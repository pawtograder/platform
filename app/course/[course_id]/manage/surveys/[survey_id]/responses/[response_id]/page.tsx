"use client";

import { Box, Heading, Text, VStack, HStack, Button, Badge } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { formatInTimeZone } from "date-fns-tz";
import dynamic from "next/dynamic";
import { Survey, SurveyResponseWithProfile } from "@/types/survey";
import { useCourse } from "@/hooks/useCourseController";

type SurveyData = Pick<Survey, "id" | "title" | "description" | "json" | "allow_response_editing">;

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
  const course = useCourse();
  const [response, setResponse] = useState<SurveyResponseWithProfile | null>(null);
  const [survey, setSurvey] = useState<SurveyData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Use timezone from course context
  const timezone = course?.time_zone || "America/New_York";

  useEffect(() => {
    const loadResponseData = async () => {
      try {
        const supabase = createClient();

        // First, fetch the survey to get its database ID (not the UUID)
        // The URL survey_id parameter is surveys.survey_id (UUID), but we need surveys.id
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

        const finalSurvey = surveyData as SurveyData;
        setSurvey(finalSurvey);

        // Now fetch the response using the survey's database ID
        // survey_responses.survey_id is a foreign key to surveys.id, not surveys.survey_id
        const { data: responseData, error: responseError } = await supabase
          .from("survey_responses")
          .select("*")
          .eq("id", String(response_id))
          .eq("survey_id", finalSurvey.id)
          .single();

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
          colorPalette="green"
          bg="green.subtle"
          color="green.fg"
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
          colorPalette="yellow"
          bg="yellow.subtle"
          color="yellow.fg"
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
          <Box w="100%" maxW="800px" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
            <VStack align="center" gap={4}>
              <Heading size="xl" color="fg" textAlign="center">
                Response Not Found
              </Heading>
              <Text color="fg" textAlign="center">
                This survey response could not be found.
              </Text>
              <Button
                variant="outline"
                bg="transparent"
                borderColor="border"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
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

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        {/* Header */}
        <VStack align="stretch" gap={4}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor="border"
            color="fg.muted"
            _hover={{ bg: "gray.subtle" }}
            onClick={handleBackToResponses}
            alignSelf="flex-start"
          >
            ← Back to Responses
          </Button>

          <Heading size="xl" color="fg" textAlign="left">
            Survey Response Details
          </Heading>
        </VStack>

        {/* Student Info and Metadata */}
        <Box w="100%" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={6}>
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="start">
              <VStack align="start" gap={2}>
                <Heading size="md" color="fg">
                  {survey.title}
                </Heading>
                {survey.description && (
                  <Text color="fg" fontSize="sm" opacity={0.8}>
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
              borderColor="border"
            >
              <VStack align="start" gap={1}>
                <Text color="fg" fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Student
                </Text>
                <Text color="fg" fontWeight="medium">
                  {response.profiles.name}
                </Text>
                {response.profiles.sis_user_id && (
                  <Text color="fg" fontSize="sm" opacity={0.7}>
                    {response.profiles.sis_user_id}
                  </Text>
                )}
              </VStack>

              <VStack align="start" gap={1}>
                <Text color="fg" fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Started
                </Text>
                <Text color="fg">{formatDate(response.created_at || "")}</Text>
              </VStack>

              <VStack align="start" gap={1}>
                <Text color="fg" fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Last Updated
                </Text>
                <Text color="fg">{formatDate(response.updated_at || "")}</Text>
              </VStack>

              {response.submitted_at && (
                <VStack align="start" gap={1}>
                  <Text color="fg" fontSize="sm" fontWeight="medium" opacity={0.8}>
                    Submitted
                  </Text>
                  <Text color="fg">{formatDate(response.submitted_at)}</Text>
                </VStack>
              )}
            </Box>
          </VStack>
        </Box>

        {/* Survey Response */}
        <Box w="100%" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="center">
              <Heading size="md" color="fg">
                Response
              </Heading>
              <Badge
                colorPalette={survey.allow_response_editing ? "green" : "yellow"}
                bg={survey.allow_response_editing ? "green.subtle" : "yellow.subtle"}
                color={survey.allow_response_editing ? "green.fg" : "yellow.fg"}
                px={3}
                py={1}
                borderRadius="md"
                fontSize="sm"
                fontWeight="medium"
              >
                {survey.allow_response_editing ? "Student: Editable" : "Student: Read Only"}
              </Badge>
            </HStack>

            <Box>
              <ViewSurveyResponse
                surveyJson={survey.json}
                responseData={response.response}
                readOnly={true}
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
