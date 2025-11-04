"use client";

import { Box, Heading, Text, VStack, HStack, Badge, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { toaster } from "@/components/ui/toaster";
import Link from "@/components/ui/link";
import { formatInTimeZone } from "date-fns-tz";
import { SurveyWithResponse } from "@/types/survey";

type FilterType = "all" | "not_started" | "completed";

export default function StudentSurveysPage() {
  const { course_id } = useParams();
  const [surveys, setSurveys] = useState<SurveyWithResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");

  // Status badge colors for dark mode
  const statusColors = {
    not_started: {
      bg: useColorModeValue("#FEE2E2", "#7F1D1D"),
      color: useColorModeValue("#991B1B", "#FCA5A5"),
      text: "Not Started"
    },
    in_progress: {
      bg: useColorModeValue("#FEE2E2", "#7F1D1D"),
      color: useColorModeValue("#991B1B", "#FCA5A5"),
      text: "In Progress"
    },
    completed: {
      bg: useColorModeValue("#D1FAE5", "#064E3B"),
      color: useColorModeValue("#065F46", "#A7F3D0"),
      text: "Completed"
    }
  };

  useEffect(() => {
    const loadSurveys = async () => {
      try {
        const supabase = createClient();

        // Get current user
        const {
          data: { user }
        } = await supabase.auth.getUser();
        if (!user) {
          toaster.create({
            title: "Authentication Required",
            description: "Please log in to view surveys.",
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        // Resolve this user's class-specific profile (private_profile_id) for this course
        const { data: roleDataRaw, error: roleError } = await supabase
          .from("user_roles" as any)
          .select("private_profile_id")
          .eq("user_id", user.id)
          .eq("class_id", Number(course_id))
          .eq("role", "student")
          .eq("disabled", false)
          .single();

        // Tell TypeScript what we actually expect from that query
        const roleData = roleDataRaw as { private_profile_id: string } | null;

        if (roleError || !roleData || !roleData.private_profile_id) {
          toaster.create({
            title: "Access Error",
            description: "We couldn't find your course profile.",
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        const profileId = roleData.private_profile_id;

        // Get published surveys for this course (and not soft-deleted)
        const { data: surveysData, error: surveysError } = await supabase
          .from("surveys" as any)
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
          .from("survey_responses" as any)
          .select("*")
          .eq("profile_id", profileId)
          .in(
            "survey_id",
            surveysData.map((s: any) => s.id)
          );

        if (responsesError) {
          throw responsesError;
        }

        // Merge surveys with the current profile's response status
        const surveysWithResponse: SurveyWithResponse[] = surveysData.map((survey: any) => {
          const response = responsesData?.find((r: any) => r.survey_id === survey.id);

          let response_status: "not_started" | "in_progress" | "completed" = "not_started";
          if (response) {
            if ((response as any).is_submitted) {
              response_status = "completed";
            } else {
              response_status = "in_progress";
            }
          }

          return {
            ...survey,
            response_status,
            submitted_at: (response as any)?.submitted_at,
            is_submitted: (response as any)?.is_submitted
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
  }, [course_id]);

  const getStatusBadge = (survey: SurveyWithResponse) => {
    const status = statusColors[survey.response_status];

    return (
      <Badge bg={status.bg} color={status.color} px={2} py={1} borderRadius="md" fontSize="sm" fontWeight="medium">
        {status.text}
      </Badge>
    );
  };

  const formatDueDate = (dueDate: string) => {
    try {
      return formatInTimeZone(new Date(dueDate), "America/New_York", "MMM dd, yyyy 'at' h:mm a");
    } catch {
      return "Invalid date";
    }
  };

  const filterButtonActiveBg = useColorModeValue("#3B82F6", "#2563EB");
  const filterButtonActiveColor = "#FFFFFF";
  const filterButtonInactiveBg = useColorModeValue("#F2F2F2", "#374151");
  const filterButtonInactiveColor = useColorModeValue("#4B5563", "#9CA3AF");
  const filterButtonHoverBg = useColorModeValue("#E5E5E5", "#4B5563");

  const filteredSurveys = useMemo(() => {
    switch (activeFilter) {
      case "all":
        return surveys;
      case "not_started":
        // Show surveys that are not started or in progress (still available to take)
        return surveys.filter(
          (survey) =>
            survey.response_status === "not_started" || survey.response_status === "in_progress"
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
                No Surveys Available
              </Heading>
              <Text color={textColor} textAlign="center">
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
          <Heading size="xl" color={textColor} textAlign="left">
            Course Surveys
          </Heading>
          <Text color={textColor} fontSize="md" opacity={0.8}>
            Complete the surveys assigned to this course. Your responses help improve the learning experience.
          </Text>
        </VStack>

        {/* Filter Buttons */}
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant="outline"
            bg={activeFilter === "all" ? filterButtonActiveBg : filterButtonInactiveBg}
            color={activeFilter === "all" ? filterButtonActiveColor : filterButtonInactiveColor}
            borderColor={activeFilter === "all" ? filterButtonActiveBg : borderColor}
            _hover={{
              bg: activeFilter === "all" ? filterButtonActiveBg : filterButtonHoverBg
            }}
            onClick={() => setActiveFilter("all")}
          >
            All
          </Button>
          <Button
            size="sm"
            variant="outline"
            bg={activeFilter === "not_started" ? filterButtonActiveBg : filterButtonInactiveBg}
            color={activeFilter === "not_started" ? filterButtonActiveColor : filterButtonInactiveColor}
            borderColor={activeFilter === "not_started" ? filterButtonActiveBg : borderColor}
            _hover={{
              bg: activeFilter === "not_started" ? filterButtonActiveBg : filterButtonHoverBg
            }}
            onClick={() => setActiveFilter("not_started")}
          >
            Not Started
          </Button>
          <Button
            size="sm"
            variant="outline"
            bg={activeFilter === "completed" ? filterButtonActiveBg : filterButtonInactiveBg}
            color={activeFilter === "completed" ? filterButtonActiveColor : filterButtonInactiveColor}
            borderColor={activeFilter === "completed" ? filterButtonActiveBg : borderColor}
            _hover={{
              bg: activeFilter === "completed" ? filterButtonActiveBg : filterButtonHoverBg
            }}
            onClick={() => setActiveFilter("completed")}
          >
            Completed
          </Button>
        </HStack>

        {/* Surveys List */}
        <VStack align="stretch" gap={4}>
          {filteredSurveys.length === 0 ? (
            <Box
              w="100%"
              bg={cardBgColor}
              border="1px solid"
              borderColor={borderColor}
              borderRadius="lg"
              p={8}
            >
              <VStack align="center" gap={2}>
                <Text color={textColor} fontSize="md" fontWeight="medium">
                  No surveys match the selected filter.
                </Text>
                <Text color={textColor} fontSize="sm" opacity={0.7}>
                  Try selecting a different filter option.
                </Text>
              </VStack>
            </Box>
          ) : (
            filteredSurveys.map((survey) => (
            <Box
              key={survey.id}
              w="100%"
              bg={cardBgColor}
              border="1px solid"
              borderColor={borderColor}
              borderRadius="lg"
              p={6}
            >
              <VStack align="stretch" gap={4}>
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={2} flex={1}>
                    <Heading size="md" color={textColor}>
                      {survey.title}
                    </Heading>
                    {survey.description && (
                      <Text color={textColor} fontSize="sm" opacity={0.8}>
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
                        <Text color={textColor} fontSize="sm" fontWeight="medium">
                          Due: {formatDueDate(survey.due_date)}
                        </Text>
                      )}
                      {survey.submitted_at && (
                        <Text color={textColor} fontSize="sm" opacity={0.7}>
                          Submitted: {formatDueDate(survey.submitted_at)}
                        </Text>
                      )}
                    </VStack>
                  </HStack>

                  <Link href={`/course/${course_id}/surveys/${survey.id}`}>
                    <Button
                      size="sm"
                      bg={survey.response_status === "completed" ? "#6B7280" : "#22C55E"}
                      color="white"
                      _hover={{
                        bg: survey.response_status === "completed" ? "#4B5563" : "#16A34A"
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