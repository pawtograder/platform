"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Box, Heading, Text, VStack, HStack, Badge, Button } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { toaster } from "@/components/ui/toaster";
import Link from "@/components/ui/link";
import { SurveyWithResponse } from "@/types/survey";
import SurveyFilterButtons from "@/components/survey/SurveyFilterButtons";
import { useClassProfiles, useIsStudent } from "@/hooks/useClassProfiles";
import { useCourse, usePublishedSurveys } from "@/hooks/useCourseController";
import { Database } from "@/utils/supabase/SupabaseTypes";

type FilterType = "all" | "not_started" | "completed";
type SurveyResponse = Database["public"]["Tables"]["survey_responses"]["Row"];

export default function StudentSurveysPage() {
  const { course_id } = useParams();
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  // Get private_profile_id from ClassProfileProvider (already available via course layout)
  const { private_profile_id } = useClassProfiles();
  const isStudent = useIsStudent();
  const course = useCourse();

  // Use the hook for realtime survey updates
  const { surveys: publishedSurveys, isLoading: surveysLoading } = usePublishedSurveys();

  // Status badge configuration
  const statusColors = {
    not_started: {
      colorPalette: "red",
      text: "Not Started"
    },
    in_progress: {
      colorPalette: "red",
      text: "In Progress"
    },
    completed: {
      colorPalette: "green",
      text: "Completed"
    }
  };

  // Fetch student's responses for the surveys
  useEffect(() => {
    const loadResponses = async () => {
      if (!isStudent) {
        toaster.create({
          title: "Access Error",
          description: "This page is only available for students.",
          type: "error"
        });
        setResponsesLoading(false);
        return;
      }

      if (!private_profile_id) {
        toaster.create({
          title: "Access Error",
          description: "We couldn't find your course profile.",
          type: "error"
        });
        setResponsesLoading(false);
        return;
      }

      if (publishedSurveys.length === 0) {
        setResponses([]);
        setResponsesLoading(false);
        return;
      }

      try {
        const supabase = createClient();

        // Get this profile's responses for those surveys
        const { data: responsesData, error: responsesError } = await supabase
          .from("survey_responses")
          .select("*")
          .eq("profile_id", private_profile_id)
          .in(
            "survey_id",
            publishedSurveys.map((s) => s.id)
          );

        if (responsesError) {
          throw responsesError;
        }

        setResponses(responsesData || []);
      } catch (error) {
        console.error("Error loading responses:", error);
        toaster.create({
          title: "Error Loading Surveys",
          description: "An error occurred while loading survey responses.",
          type: "error"
        });
      } finally {
        setResponsesLoading(false);
      }
    };

    // Only load responses after surveys have loaded
    if (!surveysLoading) {
      loadResponses();
    }
  }, [private_profile_id, isStudent, publishedSurveys, surveysLoading]);

  // Merge surveys with response status
  const surveysWithResponse: SurveyWithResponse[] = useMemo(() => {
    return publishedSurveys.map((survey) => {
      const response = responses.find((r) => r.survey_id === survey.id);

      let response_status: "not_started" | "in_progress" | "completed" = "not_started";
      if (response) {
        if (response.is_submitted) {
          response_status = "completed";
        } else {
          response_status = "in_progress";
        }
      }

      return {
        ...survey,
        response_status,
        submitted_at: response?.submitted_at,
        is_submitted: response?.is_submitted
      };
    });
  }, [publishedSurveys, responses]);

  const getStatusBadge = useCallback(
    (survey: SurveyWithResponse) => {
      const status = statusColors[survey.response_status];

      return (
        <Badge
          colorPalette={status.colorPalette}
          bg={`${status.colorPalette}.subtle`}
          color={`${status.colorPalette}.fg`}
          px={2}
          py={1}
          borderRadius="md"
          fontSize="sm"
          fontWeight="medium"
        >
          {status.text}
        </Badge>
      );
    },
    [statusColors]
  );


  // Filter options for student view
  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: "All" },
      { value: "not_started" as const, label: "Available" },
      { value: "completed" as const, label: "Completed" }
    ],
    []
  );

  const filteredSurveys = useMemo(() => {
    switch (activeFilter) {
      case "all":
        return surveysWithResponse;
      case "not_started":
        // Show surveys that are not started or in progress (still available to take)
        return surveysWithResponse.filter(
          (survey) => survey.response_status === "not_started" || survey.response_status === "in_progress"
        );
      case "completed":
        // Show completed surveys
        return surveysWithResponse.filter((survey) => survey.response_status === "completed");
      default:
        return surveysWithResponse;
    }
  }, [surveysWithResponse, activeFilter]);

  const isLoading = surveysLoading || responsesLoading;

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading surveys...</Text>
        </Box>
      </Box>
    );
  }

  if (surveysWithResponse.length === 0) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <VStack align="center" gap={6} w="100%" minH="100vh" p={8}>
          <Box w="100%" maxW="800px" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
            <VStack align="center" gap={4}>
              <Heading size="xl" color="fg" textAlign="center">
                No Surveys Available
              </Heading>
              <Text color="fg" textAlign="center">
                There are no published surveys available for this course at this time.
              </Text>
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
          <Heading size="xl" color="fg" textAlign="left">
            Course Surveys
          </Heading>
          <Text color="fg" fontSize="md" opacity={0.8}>
            Complete the surveys assigned to this course. Your responses help improve the learning experience.
          </Text>
        </VStack>

        {/* Filter Buttons */}
        <SurveyFilterButtons
          activeFilter={activeFilter}
          setActiveFilter={setActiveFilter}
          filterOptions={filterOptions}
          filterButtonActiveBg="blue.solid"
          filterButtonActiveColor="white"
          filterButtonInactiveBg="bg.subtle"
          filterButtonInactiveColor="fg.muted"
          filterButtonHoverBg="gray.subtle"
          tableBorderColor="border"
        />

        {/* Surveys List */}
        <VStack align="stretch" gap={4}>
          {filteredSurveys.length === 0 ? (
            <Box w="100%" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
              <VStack align="center" gap={2}>
                <Text color="fg" fontSize="md" fontWeight="medium">
                  No surveys match the selected filter.
                </Text>
                <Text color="fg" fontSize="sm" opacity={0.7}>
                  Try selecting a different filter option.
                </Text>
              </VStack>
            </Box>
          ) : (
            filteredSurveys.map((survey) => (
              <Box
                key={survey.id}
                w="100%"
                bg="bg.muted"
                border="1px solid"
                borderColor="border"
                borderRadius="lg"
                p={6}
              >
                <VStack align="stretch" gap={4}>
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={2} flex={1}>
                      <Heading size="md" color="fg">
                        {survey.title}
                      </Heading>
                      {survey.description && (
                        <Text color="fg" fontSize="sm" opacity={0.8}>
                          {survey.description}
                        </Text>
                      )}
                    </VStack>
                  </HStack>

                  <HStack justify="space-between" align="center">
                    <HStack gap={4} align="center">
                      {getStatusBadge(survey)}
                      <VStack align="start" gap={1}>
                        {survey.due_date && (
                          <Text color="fg" fontSize="sm" fontWeight="medium">
                            Due: <TimeZoneAwareDate date={survey.due_date} format="MMM d, yyyy, h:mm a" />
                          </Text>
                        )}
                        {survey.submitted_at && (
                          <Text color="fg" fontSize="sm" opacity={0.7}>
                            Submitted: <TimeZoneAwareDate date={survey.submitted_at} format="MMM d, yyyy, h:mm a" />
                          </Text>
                        )}
                      </VStack>
                    </HStack>

                    <Link href={`/course/${course_id}/surveys/${survey.id}`}>
                      <Button
                        size="sm"
                        colorPalette={survey.response_status === "completed" ? "gray" : "green"}
                        variant="solid"
                        _hover={{
                          bg: survey.response_status === "completed" ? "gray.emphasized" : "green.emphasized"
                        }}
                      >
                        {survey.response_status === "completed"
                          ? "View Submission"
                          : survey.response_status === "in_progress"
                            ? "Continue Survey"
                            : "Start Survey"}
                      </Button>
                    </Link>
                  </HStack>
                </VStack>
              </Box>
            ))
          )}
        </VStack>
      </VStack>
    </Box>
  );
}
