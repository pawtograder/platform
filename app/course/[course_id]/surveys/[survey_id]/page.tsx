"use client";

import { Box, Heading, Text, VStack, Button } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { toaster } from "@/components/ui/toaster";
import dynamic from "next/dynamic";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { SurveyResponse, ResponseData } from "@/types/survey";
import { Model, ValueChangedEvent } from "survey-core";
import { useCourseController, useSurvey } from "@/hooks/useCourseController";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading survey...</Text>
    </Box>
  )
});

export default function SurveyTakingPage() {
  const { course_id, survey_id } = useParams();
  const router = useRouter();
  const controller = useCourseController();

  // pulls from ClassProfileProvider
  const { private_profile_id } = useClassProfiles();

  // Use the survey hook to get the survey with realtime updates
  const survey = useSurvey(survey_id as string);

  const [existingResponse, setExistingResponse] = useState<SurveyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load existing response for this user
  useEffect(() => {
    const loadExistingResponse = async () => {
      if (!survey || !private_profile_id) {
        setIsLoading(false);
        return;
      }

      try {
        // Fetch existing response for this student
        const { data, error } = await controller.client
          .from("survey_responses")
          .select("*")
          .eq("survey_id", survey.id)
          .eq("profile_id", private_profile_id)
          .single();

        if (error && error.code !== "PGRST116") {
          // PGRST116 = no rows found, which is fine
          console.error("Error loading response:", error);
        }

        setExistingResponse(data || null);
      } catch (error) {
        console.error("Error loading existing response:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadExistingResponse();
  }, [survey, private_profile_id, controller.client]);

  // Handle survey not found or not published
  useEffect(() => {
    if (!isLoading && survey === null) {
      toaster.create({
        title: "Survey Not Found",
        description: "This survey is not available or has been removed.",
        type: "error"
      });
      router.push(`/course/${course_id}/surveys`);
    }
  }, [isLoading, survey, course_id, router]);

  // Save response helper using controller client
  const saveResponseToDb = useCallback(
    async (responseData: ResponseData, isSubmitted: boolean) => {
      if (!survey || !private_profile_id) return;

      const upsertData: {
        survey_id: string;
        profile_id: string;
        response: ResponseData;
        is_submitted: boolean;
        submitted_at?: string;
      } = {
        survey_id: survey.id,
        profile_id: private_profile_id,
        response: responseData,
        is_submitted: isSubmitted
      };

      if (isSubmitted) {
        upsertData.submitted_at = new Date().toISOString();
      }

      const { data, error } = await controller.client
        .from("survey_responses")
        .upsert(upsertData, {
          onConflict: "survey_id,profile_id"
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    },
    [survey, private_profile_id, controller.client]
  );

  const handleSurveyComplete = useCallback(
    async (surveyModel: Model) => {
      if (!private_profile_id || !survey) {
        console.error("Cannot submit survey: Missing profile_id or survey");
        return;
      }

      // Extract only the survey data from the model, not the entire model object
      const surveyData = surveyModel.data;

      setIsSubmitting(true);
      try {
        await saveResponseToDb(surveyData, true);

        toaster.create({
          title: "Survey Submitted",
          description: "Your survey has been submitted successfully.",
          type: "success"
        });

        // Redirect back to surveys list
        router.push(`/course/${course_id}/surveys`);
      } catch (error) {
        console.error("Error submitting survey:", error);

        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        toaster.create({
          title: "Submission Failed",
          description: `Error: ${errorMessage}. Please try again.`,
          type: "error"
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [private_profile_id, survey, course_id, router, saveResponseToDb]
  );

  const handleValueChanged = useCallback(
    async (surveyModel: Model, options?: ValueChangedEvent) => {
      void options;
      if (!private_profile_id || !survey || !survey.allow_response_editing) return;

      // Extract only the survey data from the model, not the entire model object
      const surveyData = surveyModel.data;

      // Auto-save on value change if editing is allowed
      try {
        await saveResponseToDb(surveyData, false);
      } catch (error) {
        console.error("Error auto-saving response:", error);
        // Don't show error toast for auto-save failures to avoid spam
      }
    },
    [private_profile_id, survey, saveResponseToDb]
  );

  const handleBackToSurveys = useCallback(() => {
    router.push(`/course/${course_id}/surveys`);
  }, [router, course_id]);

  // Show loading while survey is being fetched
  if (isLoading || survey === undefined) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading survey...</Text>
        </Box>
      </Box>
    );
  }

  if (!survey) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
          <Box w="100%" maxW="800px" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
            <VStack align="center" gap={4}>
              <Heading size="xl" color="fg" textAlign="center">
                Survey Not Found
              </Heading>
              <Text color="fg" textAlign="center">
                This survey is not available or has been removed.
              </Text>
              <Button
                variant="outline"
                bg="transparent"
                borderColor="border.emphasized"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
                onClick={handleBackToSurveys}
              >
                ← Back to Surveys
              </Button>
            </VStack>
          </Box>
        </VStack>
      </Box>
    );
  }

  // Check if survey is read-only (submitted and editing not allowed)
  const isReadOnly = existingResponse?.is_submitted && !survey.allow_response_editing;

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        {/* Header */}
        <VStack align="stretch" gap={4}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor="border.emphasized"
            color="fg.muted"
            _hover={{ bg: "gray.subtle" }}
            onClick={handleBackToSurveys}
            alignSelf="flex-start"
          >
            ← Back to Surveys
          </Button>

          <Heading size="xl" color="fg" textAlign="left">
            {survey.title}
          </Heading>

          {survey.description && (
            <Text color="fg" fontSize="md" opacity={0.8}>
              {survey.description}
            </Text>
          )}

          {isReadOnly && (
            <Box
              colorPalette="yellow"
              bg="yellow.subtle"
              border="1px solid"
              borderColor="yellow.emphasized"
              borderRadius="md"
              p={3}
            >
              <Text color="yellow.fg" fontSize="sm" fontWeight="medium">
                This survey has been submitted and cannot be edited.
              </Text>
            </Box>
          )}

          {existingResponse?.is_submitted && survey.allow_response_editing && (
            <Box
              colorPalette="green"
              bg="green.subtle"
              border="1px solid"
              borderColor="green.emphasized"
              borderRadius="md"
              p={3}
            >
              <Text color="green.fg" fontSize="sm" fontWeight="medium">
                You can edit your response since editing is allowed for this survey.
              </Text>
            </Box>
          )}
        </VStack>

        {/* Survey */}
        <Box w="100%" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
          <SurveyComponent
            surveyJson={survey.json}
            initialData={existingResponse?.response}
            readOnly={isReadOnly || isSubmitting}
            onComplete={handleSurveyComplete}
            onValueChanged={handleValueChanged}
            isPopup={false}
          />
        </Box>
      </VStack>
    </Box>
  );
}
