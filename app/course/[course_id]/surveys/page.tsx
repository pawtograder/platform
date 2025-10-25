"use client";

import { Box, Heading, Text, VStack, HStack, Badge, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import Link from "@/components/ui/link";
import { formatInTimeZone } from "date-fns-tz";

type Survey = {
  id: string;
  title: string;
  description?: string;
  due_date?: string;
  allow_response_editing: boolean;
  status: "draft" | "published" | "closed";
  created_at: string;
};

type SurveyWithResponse = Survey & {
  response_status: "not_started" | "in_progress" | "completed";
  submitted_at?: string;
  is_submitted?: boolean;
};

export default function StudentSurveysPage() {
  const { course_id } = useParams();
  const [surveys, setSurveys] = useState<SurveyWithResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

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
          return;
        }

        // Get published surveys for this course
        const { data: surveysData, error: surveysError } = await supabase
          .from("surveys" as any)
          .select("*")
          .eq("class_id", Number(course_id))
          .eq("status", "published")
          .order("created_at", { ascending: false });

        if (surveysError) {
          throw surveysError;
        }

        // Get responses for current user (student_id stores the user's auth UUID)
        const { data: responsesData, error: responsesError } = await supabase
          .from("survey_responses" as any)
          .select("*")
          .eq("student_id", user.id)
          .in("survey_id", surveysData?.map((s: any) => s.id) || []);

        if (responsesError) {
          throw responsesError;
        }

        // Combine surveys with response status
        const surveysWithResponse: SurveyWithResponse[] = (surveysData || []).map((survey: any) => {
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
    const statusColors = {
      not_started: { bg: "#F2F2F2", color: "#4B5563", text: "Not Started" },
      in_progress: { bg: "#FEF3C7", color: "#92400E", text: "In Progress" },
      completed: { bg: "#D1FAE5", color: "#065F46", text: "Completed" }
    };

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

        {/* Surveys List */}
        <VStack align="stretch" gap={4}>
          {surveys.map((survey) => (
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
                  {getStatusBadge(survey)}
                </HStack>

                <HStack justify="space-between" align="center">
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
                        ? "View Response"
                        : survey.response_status === "in_progress"
                          ? "Continue Survey"
                          : "Start Survey"}
                    </Button>
                  </Link>
                </HStack>
              </VStack>
            </Box>
          ))}
        </VStack>
      </VStack>
    </Box>
  );
}
