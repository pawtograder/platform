"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Box, Heading, Text, VStack, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { toaster } from "@/components/ui/toaster";
import dynamic from "next/dynamic";
import { createClient } from "@/utils/supabase/client";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { LivePoll, LivePollResponse } from "@/types/poll";
import { getPollResponse, savePollResponse } from "./submit";

const PollForm = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading poll...</Text>
    </Box>
  )
});

export default function PollTakingPage() {
  const { course_id, poll_id } = useParams();
  const router = useRouter();
  const { public_profile_id } = useClassProfiles();

  const [poll, setPoll] = useState<LivePoll | null>(null);
  const [existingResponse, setExistingResponse] = useState<LivePollResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const warningBgColor = useColorModeValue("#FEF3C7", "#451A03");
  const warningBorderColor = useColorModeValue("#F59E0B", "#D97706");
  const warningTextColor = useColorModeValue("#92400E", "#FCD34D");

  useEffect(() => {
    const loadPoll = async () => {
      try {
        const supabase = createClient();
        const {
          data: { user }
        } = await supabase.auth.getUser();

        if (!user) {
          toaster.create({
            title: "Authentication Required",
            description: "Please log in to participate in polls.",
            type: "error"
          });
          router.push(`/course/${course_id}/polls`);
          return;
        }

        if (!public_profile_id) {
          toaster.create({
            title: "Access Error",
            description: "We couldn't find your course profile.",
            type: "error"
          });
          router.push(`/course/${course_id}/polls`);
          return;
        }

        const { data: pollDataRaw, error: pollError } = await supabase
          .from("live_polls" as any)
          .select("*")
          .eq("id", poll_id)
          .eq("class_id", Number(course_id))
          .single();

        const pollData = pollDataRaw as LivePoll | null;

        if (pollError || !pollData) {
          toaster.create({
            title: "Poll Not Found",
            description: "This poll is not available or has been removed.",
            type: "error"
          });
          router.push(`/course/${course_id}/polls`);
          return;
        }

        setPoll(pollData);

        const response = await getPollResponse(pollData.id, public_profile_id);
        setExistingResponse(response);
        setIsSubmitted(Boolean(response?.is_submitted));
      } catch (error) {
        console.error("Error loading poll:", error);
        toaster.create({
          title: "Error Loading Poll",
          description: "An error occurred while loading the poll.",
          type: "error"
        });
        router.push(`/course/${course_id}/polls`);
      } finally {
        setIsLoading(false);
      }
    };

    loadPoll();
  }, [course_id, poll_id, public_profile_id, router]);

  const handleBackToPolls = useCallback(() => {
    router.push(`/course/${course_id}/polls`);
  }, [router, course_id]);

  const handleComplete = useCallback(
    async (survey: any) => {
      if (!poll || !public_profile_id) {
        return;
      }

      setIsSubmitting(true);

      try {
        const responseData = survey.data;
        await savePollResponse(poll.id, public_profile_id, responseData);

        setIsSubmitted(true);
        toaster.create({
          title: "Response Submitted",
          description: "Your poll response has been recorded.",
          type: "success"
        });
      } catch (error) {
        console.error("Error submitting poll response:", error);
        toaster.create({
          title: "Error Submitting Response",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
          type: "error"
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [poll, public_profile_id]
  );

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Text>Loading poll...</Text>
      </Box>
    );
  }

  if (!poll) {
    return null;
  }

  // Convert poll question to SurveyJS format
  const pollQuestion = poll.question as any;
  const surveyConfig: any = {
    pages: [
      {
        name: "page1",
        elements: [],
      },
    ],
  };

  if (pollQuestion?.type === "multiple-choice" || pollQuestion?.type === "single-choice") {
    surveyConfig.pages[0].elements.push({
      type: pollQuestion.type === "multiple-choice" ? "checkbox" : "radiogroup",
      name: "poll_question",
      title: pollQuestion.prompt,
      choices: pollQuestion.choices?.map((c: any) => c.label) || [],
      isRequired: true,
    });
  } else if (pollQuestion?.type === "rating") {
    surveyConfig.pages[0].elements.push({
      type: "rating",
      name: "poll_question",
      title: pollQuestion.prompt,
      rateMin: pollQuestion.min || 1,
      rateMax: pollQuestion.max || 5,
      minRateDescription: pollQuestion.minLabel || "",
      maxRateDescription: pollQuestion.maxLabel || "",
      isRequired: true,
    });
  } else if (pollQuestion?.type === "text") {
    surveyConfig.pages[0].elements.push({
      type: "text",
      name: "poll_question",
      title: pollQuestion.prompt,
      isRequired: true,
    });
  }

  const isReadOnly = !!existingResponse?.is_submitted || !poll.is_live;

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        <VStack align="stretch" gap={4}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={handleBackToPolls}
            alignSelf="flex-start"
          >
            ← Back to Polls
          </Button>

          <Heading size="xl" color={textColor} textAlign="left">
            {poll.title}
          </Heading>

          {!poll.is_live && !existingResponse?.is_submitted && (
            <Box bg={warningBgColor} border="1px solid" borderColor={warningBorderColor} borderRadius="md" p={3}>
              <Text color={warningTextColor} fontSize="sm" fontWeight="medium">
                This poll is closed and no longer accepts responses.
              </Text>
            </Box>
          )}

          {existingResponse?.is_submitted && (
            <Box bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="md" p={3}>
              <Text color={textColor} fontSize="sm" fontWeight="medium">
                You have already submitted a response to this poll.
              </Text>
            </Box>
          )}
        </VStack>

        <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
          <PollForm
            surveyJson={poll.question ?? {}}
            initialData={existingResponse?.response}
            readOnly={isReadOnly}
            onComplete={handleComplete}
            isPopup={false}
          />
        </Box>
      </VStack>
    </Box>
  );
}

