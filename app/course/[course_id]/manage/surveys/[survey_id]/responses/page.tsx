"use client";

import { Box, Heading, Text, VStack, HStack, Button, Badge, Input } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { toaster } from "@/components/ui/toaster";
import { getAllResponses, deleteResponse } from "../../../../surveys/[survey_id]/submit";
import { exportSurveyResponses } from "./export";
import { formatInTimeZone } from "date-fns-tz";
import Link from "@/components/ui/link";
import { MenuRoot, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { HiOutlineDotsHorizontal } from "react-icons/hi";

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

export default function SurveyResponsesPage() {
  const { course_id, survey_id } = useParams();
  const router = useRouter();
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "partial">("all");

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const tableHeaderBg = useColorModeValue("#F2F2F2", "#0D0D0D");
  const tableHeaderTextColor = useColorModeValue("#1A202C", "#9CA3AF");

  useEffect(() => {
    const loadData = async () => {
      try {
        const supabase = createClient();

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
            description: "This survey could not be found.",
            type: "error"
          });
          router.push(`/course/${course_id}/manage/surveys`);
          return;
        }

        setSurvey(surveyData as Survey);

        // Get all responses
        const responsesData = await getAllResponses(survey_id as string, course_id as string);
        setResponses(responsesData);
      } catch (error) {
        console.error("Error loading responses:", error);
        toaster.create({
          title: "Error Loading Responses",
          description: "An error occurred while loading survey responses.",
          type: "error"
        });
        // Set empty array as fallback
        setResponses([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [course_id, survey_id]); // Removed router from dependencies

  const handleDeleteResponse = useCallback(async (responseId: string, studentName: string) => {
    if (!confirm(`Are you sure you want to delete the response from ${studentName}? This action cannot be undone.`)) {
      return;
    }

    try {
      await deleteResponse(responseId);

      // Remove from local state
      setResponses((prev) => prev.filter((r) => r.id !== responseId));

      toaster.create({
        title: "Response Deleted",
        description: "The survey response has been deleted successfully.",
        type: "success"
      });
    } catch (error) {
      console.error("Error deleting response:", error);
      toaster.create({
        title: "Delete Failed",
        description: "An error occurred while deleting the response.",
        type: "error"
      });
    }
  }, []);

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
        <Badge bg="#D1FAE5" color="#065F46" px={2} py={1} borderRadius="md" fontSize="sm">
          Completed
        </Badge>
      );
    } else {
      return (
        <Badge bg="#FEF3C7" color="#92400E" px={2} py={1} borderRadius="md" fontSize="sm">
          Partial
        </Badge>
      );
    }
  };

  const filteredResponses = responses.filter((response) => {
    const matchesSearch =
      response.profiles.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (response.profiles.sis_user_id && response.profiles.sis_user_id.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "completed" && response.is_submitted) ||
      (statusFilter === "partial" && !response.is_submitted);

    return matchesSearch && matchesStatus;
  });

  const handleExportCSV = useCallback(() => {
    if (!survey) return;

    try {
      exportSurveyResponses(filteredResponses, survey, "csv");
      toaster.create({
        title: "Export Started",
        description: "Your CSV file is being downloaded.",
        type: "success"
      });
    } catch (error) {
      console.error("Error exporting responses:", error);
      toaster.create({
        title: "Export Failed",
        description: "An error occurred while exporting responses.",
        type: "error"
      });
    }
  }, [filteredResponses, survey]);

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading responses...</Text>
        </Box>
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
            onClick={() => router.push(`/course/${course_id}/manage/surveys`)}
            alignSelf="flex-start"
          >
            ← Back to Surveys
          </Button>

          <Heading size="xl" color={textColor} textAlign="left">
            Survey Responses
          </Heading>

          {survey && (
            <VStack align="start" gap={2}>
              <Text color={textColor} fontSize="lg" fontWeight="medium">
                {survey.title}
              </Text>
              {survey.description && (
                <Text color={textColor} fontSize="md" opacity={0.8}>
                  {survey.description}
                </Text>
              )}
            </VStack>
          )}
        </VStack>

        {/* Filters and Search */}
        <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={6}>
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="center">
              <Text color={textColor} fontWeight="medium">
                {filteredResponses.length} response{filteredResponses.length !== 1 ? "s" : ""}
              </Text>

              <HStack gap={2}>
                <Button
                  size="sm"
                  variant="outline"
                  bg="transparent"
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                  onClick={handleExportCSV}
                  disabled={filteredResponses.length === 0}
                >
                  Export CSV
                </Button>
              </HStack>
            </HStack>

            <HStack gap={4}>
              <Input
                placeholder="Search by student name or SIS ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                bg={bgColor}
                borderColor={borderColor}
                color={textColor}
                _placeholder={{ color: buttonTextColor }}
                _focus={{ borderColor: "blue.500" }}
                maxW="400px"
              />

              <HStack gap={2}>
                <Button
                  size="sm"
                  variant={statusFilter === "all" ? "solid" : "outline"}
                  bg={statusFilter === "all" ? "#22C55E" : "transparent"}
                  color={statusFilter === "all" ? "white" : buttonTextColor}
                  borderColor={buttonBorderColor}
                  _hover={{ bg: statusFilter === "all" ? "#16A34A" : "rgba(160, 174, 192, 0.1)" }}
                  onClick={() => setStatusFilter("all")}
                >
                  All
                </Button>
                <Button
                  size="sm"
                  variant={statusFilter === "completed" ? "solid" : "outline"}
                  bg={statusFilter === "completed" ? "#22C55E" : "transparent"}
                  color={statusFilter === "completed" ? "white" : buttonTextColor}
                  borderColor={buttonBorderColor}
                  _hover={{ bg: statusFilter === "completed" ? "#16A34A" : "rgba(160, 174, 192, 0.1)" }}
                  onClick={() => setStatusFilter("completed")}
                >
                  Completed
                </Button>
                <Button
                  size="sm"
                  variant={statusFilter === "partial" ? "solid" : "outline"}
                  bg={statusFilter === "partial" ? "#22C55E" : "transparent"}
                  color={statusFilter === "partial" ? "white" : buttonTextColor}
                  borderColor={buttonBorderColor}
                  _hover={{ bg: statusFilter === "partial" ? "#16A34A" : "rgba(160, 174, 192, 0.1)" }}
                  onClick={() => setStatusFilter("partial")}
                >
                  Partial
                </Button>
              </HStack>
            </HStack>
          </VStack>
        </Box>

        {/* Responses Table */}
        {filteredResponses.length === 0 ? (
          <Box w="100%" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
            <VStack align="center" gap={4}>
              <Text color={textColor} fontSize="lg" fontWeight="medium">
                No responses found
              </Text>
              <Text color={textColor} opacity={0.8} textAlign="center">
                {searchTerm || statusFilter !== "all"
                  ? "Try adjusting your search or filter criteria."
                  : "No students have responded to this survey yet."}
              </Text>
            </VStack>
          </Box>
        ) : (
          <Box
            w="100%"
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            overflow="hidden"
          >
            <Box
              display="grid"
              gridTemplateColumns="1fr 1fr 1fr 1fr auto"
              gap={4}
              p={4}
              bg={tableHeaderBg}
              borderBottom="1px solid"
              borderColor={borderColor}
            >
              <Text color={tableHeaderTextColor} fontWeight="medium" fontSize="sm">
                Student
              </Text>
              <Text color={tableHeaderTextColor} fontWeight="medium" fontSize="sm">
                Status
              </Text>
              <Text color={tableHeaderTextColor} fontWeight="medium" fontSize="sm">
                Submitted
              </Text>
              <Text color={tableHeaderTextColor} fontWeight="medium" fontSize="sm">
                Last Updated
              </Text>
              <Text color={tableHeaderTextColor} fontWeight="medium" fontSize="sm">
                Actions
              </Text>
            </Box>

            {filteredResponses.map((response) => (
              <Box
                key={response.id}
                display="grid"
                gridTemplateColumns="1fr 1fr 1fr 1fr auto"
                gap={4}
                p={4}
                borderBottom="1px solid"
                borderColor={borderColor}
                _last={{ borderBottom: "none" }}
                _hover={{ bg: "rgba(160, 174, 192, 0.05)" }}
              >
                <VStack align="start" gap={1}>
                  <Text color={textColor} fontWeight="medium">
                    {response.profiles.name}
                  </Text>
                  <Text color={textColor} fontSize="sm" opacity={0.7}>
                    {response.profiles.sis_user_id || "No SIS ID"}
                  </Text>
                </VStack>

                <Box>{getStatusBadge(response.is_submitted)}</Box>

                <Text color={textColor} fontSize="sm">
                  {response.submitted_at ? formatDate(response.submitted_at) : "Not submitted"}
                </Text>

                <Text color={textColor} fontSize="sm">
                  {formatDate(response.updated_at)}
                </Text>

                <Box>
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        p={1}
                        minW="auto"
                        h="auto"
                        color={buttonTextColor}
                        _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      >
                        <HiOutlineDotsHorizontal size={16} />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem value="view" asChild>
                        <Link href={`/course/${course_id}/manage/surveys/${survey_id}/responses/${response.id}`}>
                          View Details
                        </Link>
                      </MenuItem>
                      <MenuItem
                        value="delete"
                        onClick={() => handleDeleteResponse(response.id, response.profiles.name)}
                      >
                        Delete Response
                      </MenuItem>
                    </MenuContent>
                  </MenuRoot>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </VStack>
    </Box>
  );
}
