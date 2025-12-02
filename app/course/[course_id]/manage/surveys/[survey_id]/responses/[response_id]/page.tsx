"use client";

import { Box, Heading, Text, VStack, HStack, Button, Badge } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { formatInTimeZone } from "date-fns-tz";
import dynamic from "next/dynamic";
import { Survey, SurveyResponseWithProfile } from "@/types/survey";

const ViewSurveyResponse = dynamic(() => import("@/components/ViewSurveyResponse"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading response...</Text>
    </Box>
  )
});

export default function IndividualResponsePage() {
  const { course_id, survey_id, response_id } = useParams();
  const router = useRouter();
  const [response, setResponse] = useState<SurveyResponseWithProfile | null>(null);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [timezone, setTimezone] = useState<string>("America/New_York");

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  // Status badge colors for dark mode
  const completedBadgeBg = useColorModeValue("#D1FAE5", "#064E3B");
  const completedBadgeColor = useColorModeValue("#065F46", "#A7F3D0");
  const partialBadgeBg = useColorModeValue("#FEF3C7", "#451A03");
  const partialBadgeColor = useColorModeValue("#92400E", "#FCD34D");

  useEffect(() => {
    const loadResponseData = async () => {
      console.log("🚀 Loading response data:", { course_id, survey_id, response_id });

      try {
        const supabase = createClient();

        // Fetch class data for timezone
        const { data: classData } = await supabase
          .from("classes")
          .select("time_zone")
          .eq("id", Number(course_id))
          .single();
        const courseTimezone = classData?.time_zone || "America/New_York";
        setTimezone(courseTimezone);

        // First, fetch the survey to get its database ID (not the UUID)
        // The URL survey_id parameter is surveys.survey_id (UUID), but we need surveys.id
        console.log("📋 Fetching survey to get database ID...");
        const { data: surveyData, error: surveyError } = await supabase
          .from("surveys")
          .select("id, title, description, json, allow_response_editing")
          .eq("survey_id", String(survey_id))
          .eq("class_id", Number(course_id))
          .limit(1)
          .single();

        if (surveyError || !surveyData) {
          toaster.create({
            title: "Survey Not Found",
            description: "The survey for this response could not be found.",
            type: "error"
          });
          router.push(`/course/${course_id}/manage/surveys/${survey_id}/responses`);
          return;
        }

        const finalSurvey = surveyData as unknown as Survey;
        console.log("✅ Survey found with database ID:", finalSurvey.id);
        setSurvey(finalSurvey);

        // Now fetch the response using the survey's database ID
        // survey_responses.survey_id is a foreign key to surveys.id, not surveys.survey_id
        console.log("📊 Fetching survey response...");
        const { data: responseData, error: responseError } = await supabase
          .from("survey_responses")
          .select("*")
          .eq("id", String(response_id))
          .eq("survey_id", finalSurvey.id)
          .single();

        console.log("📊 Response query result:", {
          hasData: !!responseData,
          hasError: !!responseError,
          errorCode: responseError?.code,
          errorMessage: responseError?.message,
          responseKeys: responseData ? Object.keys(responseData) : [],
          responseSample: responseData ? JSON.stringify(responseData).slice(0, 200) : "No data"
        });

        if (responseError || !responseData) {
          toaster.create({
            title: "Response Not Found",
            description: "This survey response could not be found.",
            type: "error"
          });
          router.push(`/course/${course_id}/manage/surveys/${survey_id}/responses`);
          return;
        }

        // Get the student's profile via user_roles using profile_id
        console.log("👤 Fetching user profile for profile_id:", responseData?.profile_id);
        const { data: userRole, error: userRoleError } = await supabase
          .from("user_roles")
          .select(
            `
            user_id,
            private_profile_id,
            profiles:profiles!user_roles_private_profile_id_fkey (
              id,
              name
            )
          `
          )
          .eq("class_id", Number(course_id))
          .eq("private_profile_id", responseData?.profile_id)
          .single();

        console.log("👤 User profile query result:", {
          hasData: !!userRole,
          hasError: !!userRoleError,
          errorCode: userRoleError?.code,
          errorMessage: userRoleError?.message,
          profileData: userRole?.profiles ?? null
        });

        if (userRoleError || !userRole) {
          console.error("❌ Error getting user profile:", userRoleError);
          // Set response with fallback profile data
          const fallbackResponse = {
            ...responseData,
            profiles: {
              id: responseData?.profile_id ?? "",
              name: "Unknown Student"
            }
          } as SurveyResponseWithProfile;
          console.log("🔄 Using fallback profile data:", fallbackResponse);
          setResponse(fallbackResponse);
        } else {
          const responseWithProfile = {
            ...responseData,
            profiles: {
              id: userRole.profiles?.id ?? "",
              name: userRole.profiles?.name ?? null,
              sis_user_id: null // Not available on profiles table
            }
          } as SurveyResponseWithProfile;
          console.log("✅ Response with profile data:", responseWithProfile);
          setResponse(responseWithProfile);
        }
      } catch (error) {
        console.error("Error loading response:", error);
        toaster.create({
          title: "Error Loading Response",
          description: "An error occurred while loading the survey response.",
          type: "error"
        });
        router.push(`/course/${course_id}/manage/surveys/${survey_id}/responses`);
      } finally {
        setIsLoading(false);
      }
    };

    loadResponseData();
  }, [course_id, survey_id, response_id, router]);

  const formatDate = (dateString: string) => {
    try {
      return formatInTimeZone(new Date(dateString), timezone, "MMM dd, yyyy 'at' h:mm a");
    } catch {
      return "Invalid date";
    }
  };

  const getStatusBadge = (isSubmitted: boolean) => {
    if (isSubmitted) {
      return (
        <Badge
          bg={completedBadgeBg}
          color={completedBadgeColor}
          px={3}
          py={1}
          borderRadius="md"
          fontSize="sm"
          fontWeight="medium"
        >
          Completed
        </Badge>
      );
    } else {
      return (
        <Badge
          bg={partialBadgeBg}
          color={partialBadgeColor}
          px={3}
          py={1}
          borderRadius="md"
          fontSize="sm"
          fontWeight="medium"
        >
          Partial
        </Badge>
      );
    }
  };

  const handleBackToResponses = () => {
    router.push(`/course/${course_id}/manage/surveys/${survey_id}/responses`);
  };

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading response...</Text>
        </Box>
      </Box>
    );
  }

  if (!response || !survey) {
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
                Response Not Found
              </Heading>
              <Text color={textColor} textAlign="center">
                This survey response could not be found.
              </Text>
              <Button
                variant="outline"
                bg="transparent"
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                onClick={handleBackToResponses}
              >
                ← Back to Responses
              </Button>
            </VStack>
          </Box>
        </VStack>
      </Box>
    );
  }

  console.log("🎨 Rendering IndividualResponsePage with:", {
    isLoading,
    hasResponse: !!response,
    hasSurvey: !!survey,
    responseData: response?.response ? "Present" : "Missing",
    surveyJson: survey?.json ? "Present" : "Missing",
    allowResponseEditing: survey?.allow_response_editing,
    readOnly: survey ? !survey.allow_response_editing : true
  });

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
            onClick={handleBackToResponses}
            alignSelf="flex-start"
          >
            ← Back to Responses
          </Button>

          <Heading size="xl" color={textColor} textAlign="left">
            Survey Response Details
          </Heading>
        </VStack>

        {/* Student Info and Metadata */}
        <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={6}>
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="start">
              <VStack align="start" gap={2}>
                <Heading size="md" color={textColor}>
                  {survey.title}
                </Heading>
                {survey.description && (
                  <Text color={textColor} fontSize="sm" opacity={0.8}>
                    {survey.description}
                  </Text>
                )}
              </VStack>
              {getStatusBadge(response.is_submitted)}
            </HStack>

            <Box
              display="grid"
              gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
              gap={4}
              pt={4}
              borderTop="1px solid"
              borderColor={borderColor}
            >
              <VStack align="start" gap={1}>
                <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Student
                </Text>
                <Text color={textColor} fontWeight="medium">
                  {response.profiles.name}
                </Text>
                {response.profiles.sis_user_id && (
                  <Text color={textColor} fontSize="sm" opacity={0.7}>
                    {response.profiles.sis_user_id}
                  </Text>
                )}
              </VStack>

              <VStack align="start" gap={1}>
                <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Started
                </Text>
                <Text color={textColor}>{formatDate(response.created_at || "")}</Text>
              </VStack>

              <VStack align="start" gap={1}>
                <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Last Updated
                </Text>
                <Text color={textColor}>{formatDate(response.updated_at || "")}</Text>
              </VStack>

              {response.submitted_at && (
                <VStack align="start" gap={1}>
                  <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                    Submitted
                  </Text>
                  <Text color={textColor}>{formatDate(response.submitted_at)}</Text>
                </VStack>
              )}
            </Box>
          </VStack>
        </Box>

        {/* Survey Response */}
        <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="center">
              <Heading size="md" color={textColor}>
                Response
              </Heading>
              <Badge
                bg={survey.allow_response_editing ? "#D1FAE5" : "#FEF3C7"}
                color={survey.allow_response_editing ? "#065F46" : "#92400E"}
                px={3}
                py={1}
                borderRadius="md"
                fontSize="sm"
                fontWeight="medium"
              >
                {survey.allow_response_editing ? "Editable" : "Read Only"}
              </Badge>
            </HStack>

            <Box>
              <ViewSurveyResponse
                surveyJson={survey.json}
                responseData={response.response}
                readOnly={!survey.allow_response_editing}
                onComplete={() => {}} // No-op for display mode
                onValueChanged={() => {}} // No-op for display mode
              />
            </Box>
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
