"use client";

import { Box, Heading, Text, VStack, HStack, Button, Badge } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { formatInTimeZone } from "date-fns-tz";
import dynamic from "next/dynamic";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box display="flex" alignItems="center" justifyContent="center" p={8}>
      <Text>Loading response...</Text>
    </Box>
  )
});

type SurveyResponse = {
  id: string;
  response: Record<string, any>;
  is_submitted: boolean;
  submitted_at?: string;
  created_at: string;
  updated_at: string;
  profiles: {
    id: string;
    name: string;
    sis_user_id: string | null;
  };
};

type Survey = {
  id: string;
  title: string;
  description?: string;
  questions: any;
};

export default function IndividualResponsePage() {
  const { course_id, survey_id, response_id } = useParams();
  const router = useRouter();
  const [response, setResponse] = useState<SurveyResponse | null>(null);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  useEffect(() => {
    const loadResponseData = async () => {
      try {
        const supabase = createClient();

        // Get response with student info
        const { data: responseData, error: responseError } = await supabase
          .from("survey_responses" as any)
          .select("*")
          .eq("id", response_id)
          .eq("survey_id", survey_id)
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

        // Get the student's profile via user_roles
        const { data: userRole, error: userRoleError } = await supabase
          .from("user_roles" as any)
          .select(
            `
            user_id,
            private_profile_id,
            profiles:private_profile_id (
              id,
              name,
              sis_user_id
            )
          `
          )
          .eq("class_id", Number(course_id))
          .eq("user_id", (responseData as any).student_id)
          .single();

        if (userRoleError || !userRole) {
          console.error("Error getting user profile:", userRoleError);
          // Set response with fallback profile data
          setResponse({
            ...(responseData as any),
            profiles: {
              id: (responseData as any).student_id,
              name: "Unknown Student",
              sis_user_id: null
            }
          } as SurveyResponse);
        } else {
          setResponse({
            ...(responseData as any),
            profiles: (userRole as any).profiles
          } as SurveyResponse);
        }

        // Get survey info
        const { data: surveyData, error: surveyError } = await supabase
          .from("surveys" as any)
          .select("id, title, description, questions")
          .eq("id", survey_id)
          .eq("class_id", Number(course_id))
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

        setSurvey(surveyData as unknown as Survey);
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
  }, [course_id, survey_id, response_id]); // Removed router from dependencies

  const formatDate = (dateString: string) => {
    try {
      return formatInTimeZone(new Date(dateString), "America/New_York", "MMM dd, yyyy 'at' h:mm a");
    } catch {
      return "Invalid date";
    }
  };

  const getStatusBadge = (isSubmitted: boolean) => {
    if (isSubmitted) {
      return (
        <Badge bg="#D1FAE5" color="#065F46" px={3} py={1} borderRadius="md" fontSize="sm" fontWeight="medium">
          Completed
        </Badge>
      );
    } else {
      return (
        <Badge bg="#FEF3C7" color="#92400E" px={3} py={1} borderRadius="md" fontSize="sm" fontWeight="medium">
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
                <Text color={textColor} fontSize="sm" opacity={0.7}>
                  {response.profiles.sis_user_id || "No SIS ID"}
                </Text>
              </VStack>

              <VStack align="start" gap={1}>
                <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Started
                </Text>
                <Text color={textColor}>{formatDate(response.created_at)}</Text>
              </VStack>

              <VStack align="start" gap={1}>
                <Text color={textColor} fontSize="sm" fontWeight="medium" opacity={0.8}>
                  Last Updated
                </Text>
                <Text color={textColor}>{formatDate(response.updated_at)}</Text>
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
            <Heading size="md" color={textColor}>
              Response
            </Heading>

            <Box>
              <SurveyComponent
                surveyJson={survey.questions}
                initialData={response.response}
                readOnly={true}
                onComplete={() => {}} // No-op for display mode
                onValueChanged={() => {}} // No-op for display mode
                isPopup={false}
              />
            </Box>
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
