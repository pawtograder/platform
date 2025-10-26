"use client";

import { Box, Heading, Text, VStack, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { toaster } from "@/components/ui/toaster";
import dynamic from "next/dynamic";
import { saveResponse, getResponse, ResponseData } from "./submit";
import { useClassProfiles } from "@/hooks/useClassProfiles";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading survey...</Text>
    </Box>
  )
});

type Survey = {
  id: string;
  title: string;
  description?: string;
  json: any;
  due_date?: string;
  allow_response_editing: boolean;
  status: "draft" | "published" | "closed";
};

type SurveyResponse = {
  id: string;
  response: ResponseData;
  is_submitted: boolean;
  submitted_at?: string;
};

export default function SurveyTakingPage() {
  const { course_id, survey_id } = useParams();
  const router = useRouter();

  // pulls from ClassProfileProvider 
  const { private_profile_id } = useClassProfiles();

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [existingResponse, setExistingResponse] = useState<SurveyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  useEffect(() => {
    const loadSurveyData = async () => {
      try {
        const supabase = createClient();

        // Get current user
        const {
          data: { user }
        } = await supabase.auth.getUser();
        if (!user) {
          toaster.create({
            title: "Authentication Required",
            description: "Please log in to take surveys.",
            type: "error"
          });
          router.push(`/course/${course_id}/surveys`);
          return;
        }

        // If we somehow don't have a profile for this class context, bail early
        if (!private_profile_id) {
          toaster.create({
            title: "Access Error",
            description: "We couldn't find your course profile.",
            type: "error"
          });
          router.push(`/course/${course_id}/surveys`);
          return;
        }

        // Get survey data
        const { data: surveyDataRaw, error: surveyError } = await supabase
          .from("surveys" as any)
          .select("*")
          .eq("id", survey_id)
          .eq("class_id", Number(course_id))
          .eq("status", "published")
          .single();

        const surveyData = surveyDataRaw as Survey | null;

        if (surveyError || !surveyData) {
          toaster.create({
            title: "Survey Not Found",
            description: "This survey is not available or has been removed.",
            type: "error"
          });
          router.push(`/course/${course_id}/surveys`);
          return;
        }

        setSurvey(surveyData);

        // Get existing response if any
        const response = await getResponse(survey_id as string, private_profile_id);
        setExistingResponse(response || null);
      } catch (error) {
        console.error("Error loading survey:", error);
        toaster.create({
          title: "Error Loading Survey",
          description: "An error occurred while loading the survey.",
          type: "error"
        });
        router.push(`/course/${course_id}/surveys`);
      } finally {
        setIsLoading(false);
      }
    };

    loadSurveyData();
  }, [course_id, survey_id, private_profile_id, router]); // Removed manual user_roles fetch, now depends on context

  const handleSurveyComplete = useCallback(
    async (surveyData: any) => {
      if (!private_profile_id || !survey) {
        console.error("❌ Cannot submit survey: Missing profile_id or survey", {
          hasProfileId: !!private_profile_id,
          hasSurvey: !!survey,
          surveyId: survey_id
        });
        return;
      }

      console.log("📤 Submitting survey:", {
        surveyId: survey_id,
        profileId: private_profile_id,
        surveyTitle: survey.title,
        responseKeys: Object.keys(surveyData)
      });

      setIsSubmitting(true);
      try {
        await saveResponse(survey_id as string, private_profile_id, surveyData, true);

        toaster.create({
          title: "Survey Submitted",
          description: "Your survey has been submitted successfully.",
          type: "success"
        });

        // Redirect back to surveys list
        router.push(`/course/${course_id}/surveys`);
      } catch (error) {
        console.error("❌ Error submitting survey:", {
          error,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          surveyId: survey_id,
          profileId: private_profile_id
        });

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
    [private_profile_id, survey, survey_id, course_id, router]
  );

  const handleValueChanged = useCallback(
    async (surveyData: any, options: any) => {
      if (!private_profile_id || !survey || !survey.allow_response_editing) return;

      // Auto-save on value change if editing is allowed
      try {
        await saveResponse(survey_id as string, private_profile_id, surveyData, false);
      } catch (error) {
        console.error("Error auto-saving response:", error);
        // Don't show error toast for auto-save failures to avoid spam
      }
    },
    [private_profile_id, survey, survey_id]
  );

  const handleBackToSurveys = useCallback(() => {
    router.push(`/course/${course_id}/surveys`);
  }, [router, course_id]);

  if (isLoading) {
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
          <Box
            w="100%"
            maxW="800px"
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={8}
          >
            <VStack align="center" gap={4}>
              <Heading size="xl" color={textColor} textAlign="center">
                Survey Not Found
              </Heading>
              <Text color={textColor} textAlign="center">
                This survey is not available or has been removed.
              </Text>
              <Button
                variant="outline"
                bg="transparent"
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={handleBackToSurveys}
            alignSelf="flex-start"
          >
            ← Back to Surveys
          </Button>

          <Heading size="xl" color={textColor} textAlign="left">
            {survey.title}
          </Heading>

          {survey.description && (
            <Text color={textColor} fontSize="md" opacity={0.8}>
              {survey.description}
            </Text>
          )}

          {isReadOnly && (
            <Box bg="#FEF3C7" border="1px solid" borderColor="#F59E0B" borderRadius="md" p={3}>
              <Text color="#92400E" fontSize="sm" fontWeight="medium">
                This survey has been submitted and cannot be edited.
              </Text>
            </Box>
          )}

          {existingResponse?.is_submitted && survey.allow_response_editing && (
            <Box bg="#D1FAE5" border="1px solid" borderColor="#10B981" borderRadius="md" p={3}>
              <Text color="#065F46" fontSize="sm" fontWeight="medium">
                You can edit your response since editing is allowed for this survey.
              </Text>
            </Box>
          )}
        </VStack>

        {/* Survey */}
        <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
          <SurveyComponent
            surveyJson={survey.json}
            onComplete={handleSurveyComplete}
            onValueChanged={handleValueChanged}
            isPopup={false}
          />
        </Box>
      </VStack>
    </Box>
  );
}
