"use client";

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Box, Container, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue, ColorModeButton } from "@/components/ui/color-mode";
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
  const course_id = params.course_id as string;
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const isDarkMode = useColorModeValue(false, true);

  // Fetch the newest live poll and pass directly to SurveyJS
  useEffect(() => {
    const fetchPoll = async () => {
      const supabase = createClient();

      const { data: pollData, error } = await supabase
        .from("live_polls")
        .select("*")
        .eq("class_id", Number(course_id))
        .eq("is_live", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (error || !pollData) {
        setIsLoading(false);
        return;
      }

      const poll = pollData;
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
            public_profile_id: null,
            response: responseData,
            is_submitted: true
          });

          if (error) {
            throw new Error(error.message);
          }

          setIsSubmitted(true);
        } catch (error) {
          toaster.create({
            title: "Error submitting response",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            type: "error"
          });
        }
      });
      setSurveyModel(survey);
      setIsLoading(false);
    };

    if (course_id) {
      fetchPoll();
    }
  }, [course_id]);

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

  return (
    <Box position="relative" minH="100vh" py={8}>
      {/* Color Mode Toggle Button - Top Right */}
      <Box position="absolute" top={4} right={4} zIndex={1000}>
        <ColorModeButton colorPalette="gray" variant="outline" />
      </Box>

      <Container maxW="800px" my={2}>
        {isLoading ? (
          <Box bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8} textAlign="center">
            <Text color={textColor}>Loading poll...</Text>
          </Box>
        ) : isSubmitted ? (
          <Box bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color={textColor} mb={4}>
              Thank You!
            </Heading>
            <Text color={textColor}>
              Your poll response has been submitted successfully. Refresh the page to answer again or to load a new
              poll.
            </Text>
          </Box>
        ) : !surveyModel ? (
          <Box bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8} textAlign="center">
            <Heading size="lg" color={textColor} mb={4}>
              No Live Poll Available
            </Heading>
            <Text color={textColor}>There is currently no live poll available for this course.</Text>
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
