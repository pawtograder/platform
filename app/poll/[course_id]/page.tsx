"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Box, Container, Heading, Text, Button, VStack } from "@chakra-ui/react";
import { useColorMode, ColorModeButton } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.min.css";
import { PollResponseData } from "@/types/poll";

interface PollQuestion {
  elements: Array<Record<string, unknown>>;
}
export default function PollRespondPage() {
  const params = useParams();
  const router = useRouter();
  const course_id = Array.isArray(params.course_id) ? params.course_id[0] : params.course_id;
  const courseIdNum = course_id ? parseInt(course_id, 10) : NaN;

  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [hasAlreadySubmitted, setHasAlreadySubmitted] = useState(false);
  const [pollRequiresLogin, setPollRequiresLogin] = useState(false);
  const { colorMode } = useColorMode();
  const isDarkMode = colorMode === "dark";

  // Fetch the newest live poll and pass directly to SurveyJS
  useEffect(() => {
    const fetchPoll = async () => {
      const supabase = createClient();
      const { data: pollData, error } = await supabase
        .from("live_polls")
        .select("*")
        .eq("class_id", courseIdNum)
        .eq("is_live", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (error || !pollData) {
        if (error) {
          toaster.create({
            title: "Error loading poll",
            description: error.message,
            type: "error"
          });
        }
        setIsLoading(false);
        return;
      }

      const poll = pollData;

      // Store require_login for use in render
      setPollRequiresLogin(poll.require_login);

      // Resolve the profile ID to attach to responses (if login is required)
      let profileId: string | null = null;
      if (poll.require_login) {
        const {
          data: { user }
        } = await supabase.auth.getUser();

        if (!user) {
          setRequiresLogin(true);
          setIsLoading(false);
          return;
        }

        const { data } = await supabase
          .from("user_roles")
          .select("public_profile_id")
          .eq("user_id", user.id)
          .eq("class_id", courseIdNum)
          .single();

        if (!data?.public_profile_id) {
          toaster.create({
            title: "Access Error",
            description: "We couldn't find your course profile.",
            type: "error"
          });
          setRequiresLogin(true);
          setIsLoading(false);
          return;
        }

        profileId = data.public_profile_id;
      }

      const pollQuestion = poll.question as unknown as PollQuestion;

      if (!pollQuestion?.elements || pollQuestion.elements.length === 0) {
        setIsLoading(false);
        return;
      }

      // Add name field to elements if missing
      const elements = pollQuestion.elements.map((el: Record<string, unknown>, index: number) => ({
        ...el,
        name: el.name || `poll_question_${index}`,
        isRequired: el.isRequired !== false // Default to required
      }));

      // SurveyJS needs pages structure
      const surveyConfig = {
        pages: [
          {
            name: "page1",
            elements
          }
        ],
        showNavigationButtons: "bottom",
        showProgressBar: false,
        showCompletedPage: false // Disable default completed page
      };

      // Create Model from JSON config
      const survey = new Model(surveyConfig);

      survey.onComplete.add(async (sender) => {
        const supabase = createClient();

        try {
          // sender.data is in format { "poll_question_0": "Dynamic Programming" }
          const responseData: PollResponseData = sender.data as PollResponseData;

          const { error } = await supabase.from("live_poll_responses").insert({
            live_poll_id: poll.id,
            public_profile_id: profileId,
            response: responseData,
            is_submitted: true
          });

          if (error) {
            // Check if it's a unique constraint violation and poll requires login
            if (error.code === "23505" && poll.require_login) {
              setHasAlreadySubmitted(true);
              return;
            }
            throw error;
          }

          setIsSubmitted(true);
        } catch (error) {
          // Only show toast if we haven't already handled it as a duplicate submission
          if (!hasAlreadySubmitted) {
            toaster.create({
              title: "Error submitting response",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
              type: "error"
            });
          }
        }
      });
      setSurveyModel(survey);
      setIsLoading(false);
    };

    if (!course_id || Number.isNaN(courseIdNum)) {
      setIsLoading(false);
      return;
    }

    fetchPoll();
  }, [courseIdNum, course_id]);

  // Update survey theme when color mode changes
  useEffect(() => {
    if (surveyModel) {
      if (isDarkMode) {
        surveyModel.applyTheme(DefaultDark);
      } else {
        surveyModel.applyTheme(DefaultLight);
      }
    }
  }, [isDarkMode, surveyModel]);

  // Handle invalid course ID in render instead of early return
  if (isNaN(courseIdNum)) {
    return (
      <Box position="relative" minH="100vh" py={8}>
        <Box position="absolute" top={4} right={4} zIndex={1000}>
          <ColorModeButton colorPalette="gray" variant="outline" />
        </Box>
        <Container maxW="800px" my={2}>
          <Box bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color="fg" mb={4}>
              Invalid Course ID
            </Heading>
            <Text color="fg">Course ID must be a number.</Text>
          </Box>
        </Container>
      </Box>
    );
  }

  return (
    <Box position="relative" minH="100vh" py={8}>
      {/* Color Mode Toggle Button - Top Right */}
      <Box position="absolute" top={4} right={4} zIndex={1000}>
        <ColorModeButton colorPalette="gray" variant="outline" />
      </Box>

      <Container maxW="800px" my={2}>
        {isLoading ? (
          <Box bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8} textAlign="center">
            <Text color="fg">Loading poll...</Text>
          </Box>
        ) : requiresLogin ? (
          <Box display="flex" justifyContent="center" alignItems="center" minH="calc(100vh - 4rem)">
            <Box
              bg="bg.muted"
              border="1px solid"
              borderColor="border"
              borderRadius="md"
              p={8}
              maxW="400px"
              width="100%"
            >
              <VStack gap={6} align="stretch">
                <VStack gap={3} align="center" textAlign="center">
                  <Heading size="xl" color="fg">
                    Login Required
                  </Heading>
                  <Text color="fg" fontSize="sm">
                    You need to be logged in to respond to this poll. Please sign in to continue.
                  </Text>
                </VStack>
                <Button
                  onClick={() => {
                    const currentUrl = window.location.pathname + window.location.search;
                    router.push(`/sign-in?redirect=${encodeURIComponent(currentUrl)}`);
                  }}
                  colorPalette="blue"
                  size="lg"
                  width="100%"
                >
                  Sign In
                </Button>
              </VStack>
            </Box>
          </Box>
        ) : hasAlreadySubmitted ? (
          <Box bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color="fg" mb={4}>
              Already Submitted
            </Heading>
            <Text color="fg">
              You have already submitted a response. Polls with login require you to submit only once.
            </Text>
          </Box>
        ) : isSubmitted ? (
          <Box bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color="fg" mb={4}>
              Thank You!
            </Heading>
            <Text color="fg">
              Your poll response has been submitted successfully.{" "}
              {pollRequiresLogin
                ? "Refresh the page to load a new poll."
                : "Refresh the page to answer again or to load a new poll."}
            </Text>
          </Box>
        ) : !surveyModel ? (
          <Box bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color="fg" mb={4}>
              No Live Poll Available
            </Heading>
            <Text color="fg">There is currently no live poll available for this course.</Text>
          </Box>
        ) : (
          <Box display="flex" justifyContent="center" alignItems="center" minH="calc(100vh - 4rem)">
            <Survey model={surveyModel} />
          </Box>
        )}
      </Container>
    </Box>
  );
}
