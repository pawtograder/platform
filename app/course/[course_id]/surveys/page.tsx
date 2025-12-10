"use client";

import { Box, Heading, Text, VStack, HStack, Badge, Button } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { toaster } from "@/components/ui/toaster";
import Link from "@/components/ui/link";
import { formatInTimeZone } from "date-fns-tz";
import { SurveyWithResponse } from "@/types/survey";
import SurveyFilterButtons from "@/components/survey/SurveyFilterButtons";
import { useClassProfiles, useIsStudent } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";

type FilterType = "all" | "not_started" | "completed";

export default function StudentSurveysPage() {
  const { course_id } = useParams();
  const [surveys, setSurveys] = useState<SurveyWithResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  // Get private_profile_id from ClassProfileProvider (already available via course layout)
  const { private_profile_id } = useClassProfiles();
  const isStudent = useIsStudent();
  const course = useCourse();

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

  useEffect(() => {
    const loadSurveys = async () => {
      // Check if user has student role for this course
      if (!isStudent) {
        toaster.create({
          title: "Access Error",
          description: "This page is only available for students.",
          type: "error"
        });
        setIsLoading(false);
        return;
      }

      if (!private_profile_id) {
        toaster.create({
          title: "Access Error",
          description: "We couldn't find your course profile.",
          type: "error"
        });
        setIsLoading(false);
        return;
      }

      try {
        const supabase = createClient();
        const profileId = private_profile_id;

        // Get published surveys for this course (and not soft-deleted)
        const { data: surveysData, error: surveysError } = await supabase
          .from("surveys")
          .select("*")
          .eq("class_id", Number(course_id))
          .eq("status", "published")
          .is("deleted_at", null)
          .order("created_at", { ascending: false });

        if (surveysError) {
          throw surveysError;
        }

        // If there are no surveys, just finish early
        if (!surveysData || surveysData.length === 0) {
          setSurveys([]);
          setIsLoading(false);
          return;
        }

        // Get this profile's responses for those surveys
        const { data: responsesData, error: responsesError } = await supabase
          .from("survey_responses")
          .select("*")
          .eq("profile_id", profileId)
          .in(
            "survey_id",
            surveysData.map((s) => s.id)
          );

        if (responsesError) {
          throw responsesError;
        }

        // Merge surveys with the current profile's response status
        const surveysWithResponse: SurveyWithResponse[] = surveysData.map((survey) => {
          const response = responsesData?.find((r) => r.survey_id === survey.id);

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

        setSurveys(surveysWithResponse);
      } catch (error) {
        console.error("Error loading surveys:", error);
        toaster.create({
          title: "Error Loading Surveys",
          description: "An error occurred while loading surveys.",
          type: "error"
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadSurveys();
  }, [course_id, private_profile_id, isStudent]);

  const getStatusBadge = (survey: SurveyWithResponse) => {
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
  };

  const formatDueDate = (dueDate: string) => {
    try {
      const timeZone = course.time_zone || "UTC";
      return formatInTimeZone(new Date(dueDate), timeZone, "MMM dd, yyyy 'at' h:mm a");
    } catch {
      return "Invalid date";
    }
  };

  // Filter options for student view
  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: "All" },
      { value: "not_started" as const, label: "Not Started" },
      { value: "completed" as const, label: "Completed" }
    ],
    []
  );

  const filteredSurveys = useMemo(() => {
    switch (activeFilter) {
      case "all":
        return surveys;
      case "not_started":
        // Show surveys that are not started or in progress (still available to take)
        return surveys.filter(
          (survey) => survey.response_status === "not_started" || survey.response_status === "in_progress"
        );
      case "completed":
        // Show completed surveys
        return surveys.filter((survey) => survey.response_status === "completed");
      default:
        return surveys;
    }
  }, [surveys, activeFilter]);

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading surveys...</Text>
        </Box>
      </Box>
    );
  }

  if (surveys.length === 0) {
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
                            Due: {formatDueDate(survey.due_date)}
                          </Text>
                        )}
                        {survey.submitted_at && (
                          <Text color="fg" fontSize="sm" opacity={0.7}>
                            Submitted: {formatDueDate(survey.submitted_at)}
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
