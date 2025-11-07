"use client";

import { Box, Table, Text, Badge, HStack, Icon } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import Link from "@/components/ui/link";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";
import { Button } from "@/components/ui/button";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { MenuRoot, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { createClient } from "@/utils/supabase/client";
import { useCallback, useState, useMemo } from "react";

type FilterType = "all" | "completed" | "awaiting";

type Survey = {
  id: string;
  survey_id?: string;
  title: string;
  status: "draft" | "published" | "closed";
  version: number;
  created_at: string;
  class_id: number;
  json?: string;
};

type SurveyWithCounts = Survey & {
  response_count: number;
};

type SurveysTableProps = {
  surveys: SurveyWithCounts[];
  totalStudents: number;
  courseId: string;
  timezone: string;
};

export default function SurveysTable({ surveys, totalStudents, courseId, timezone }: SurveysTableProps) {
  const trackEvent = useTrackEvent();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  // Color mode values - same as the form
  const textColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tableBorderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tableHeaderBg = useColorModeValue("#F2F2F2", "#0D0D0D");
  const tableHeaderTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");
  const versionBadgeBg = useColorModeValue("#F2F2F2", "#0D0D0D");
  const versionBadgeBorder = useColorModeValue("#D2D2D2", "#2D2D2D");
  const versionBadgeText = useColorModeValue("#1A202C", "#A0AEC0");
  const actionsButtonBorder = useColorModeValue("#D2D2D2", "#2D2D2D");
  const filterButtonActiveBg = useColorModeValue("#3B82F6", "#2563EB");
  const filterButtonActiveColor = "#FFFFFF";
  const filterButtonInactiveBg = useColorModeValue("#F2F2F2", "#374151");
  const filterButtonInactiveColor = useColorModeValue("#4B5563", "#9CA3AF");
  const filterButtonHoverBg = useColorModeValue("#E5E5E5", "#4B5563");

  // Filter surveys based on completion status
  const filteredSurveys = useMemo(() => {
    if (activeFilter === "all") {
      return surveys;
    }
    
    return surveys.filter((survey) => {
      const completionRate = totalStudents > 0 ? (survey.response_count / totalStudents) * 100 : 0;
      
      if (activeFilter === "completed") {
        return completionRate === 100;
      } else if (activeFilter === "awaiting") {
        return completionRate < 100;
      }
      
      return true;
    });
  }, [surveys, activeFilter, totalStudents]);

  const getStatusBadge = (status: string) => {
    const statusMap = {
      published: { text: "#22C55E", bg: "rgba(34, 197, 94, 0.2)" },
      draft: { text: "#FBBF24", bg: "rgba(251, 191, 36, 0.2)" },
      closed: { text: "#EF4444", bg: "rgba(239, 68, 68, 0.2)" }
    };

    const colors = statusMap[status as keyof typeof statusMap] || statusMap.draft;

    return (
      <Badge
        px={2}
        py={1}
        borderRadius="md"
        fontSize="xs"
        fontWeight="medium"
        bg={colors.bg}
        color={colors.text}
        textTransform="capitalize"
      >
        {status}
      </Badge>
    );
  };

  const getSurveyLink = (survey: Survey) => {
    if (survey.status === "draft") {
      return `/course/${courseId}/manage/surveys/${survey.id}/edit`;
    } else if (survey.status === "published") {
      return `/course/${courseId}/manage/surveys/${survey.id}/edit`;
    } else {
      // closed - read-only view
      return `/course/${courseId}/manage/surveys/${survey.id}`;
    }
  };

  const handlePublish = useCallback(
    async (survey: Survey) => {
      // Show loading toast
      const loadingToast = toaster.create({
        title: "Publishing Survey",
        description: "Updating survey status...",
        type: "loading"
      });

      try {
        const supabase = createClient();

        // Validate JSON before publishing
        let validationErrors = null;
        try {
          if (survey.json) {
            JSON.parse(survey.json);
          }
        } catch (error) {
          validationErrors = `Invalid JSON configuration: ${error instanceof Error ? error.message : "Unknown error"}`;
        }

        // Update survey status to published
        const { data, error } = await supabase
          .from("surveys" as any)
          .update({
            status: validationErrors ? "draft" : "published",
            validation_errors: validationErrors
          })
          .eq("id", survey.id)
          .select("id, survey_id, status")
          .single();

        if (error || !data) {
          throw new Error(error?.message || "Failed to publish survey");
        }

        // Dismiss loading toast and show success
        toaster.dismiss(loadingToast);

        if (validationErrors) {
          toaster.create({
            title: "Survey Remains Draft",
            description: "Survey could not be published due to validation issues. Please fix the JSON configuration.",
            type: "warning"
          });
        } else {
          toaster.create({
            title: "Survey Published",
            description: "Your survey has been published and is now available to students.",
            type: "success"
          });
        }

        // Track the publish event
        trackEvent("survey_published" as any, {
          course_id: Number(courseId),
          survey_id: survey.survey_id,
          has_validation_errors: !!validationErrors
        });

        // Refresh the page to show updated status
        window.location.reload();
      } catch (error) {
        // Dismiss loading toast and show error
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Failed to Publish Survey",
          description: error instanceof Error ? error.message : "An unexpected error occurred",
          type: "error"
        });
      }
    },
    [courseId, trackEvent]
  );

  const handleClose = useCallback(
    async (survey: Survey) => {
      // Show loading toast
      const loadingToast = toaster.create({
        title: "Closing Survey",
        description: "Updating survey status...",
        type: "loading"
      });

      try {
        const supabase = createClient();

        // Update survey status to closed
        const { data, error } = await supabase
          .from("surveys" as any)
          .update({
            status: "closed"
          })
          .eq("id", survey.id)
          .select("id, survey_id, status")
          .single();

        if (error || !data) {
          throw new Error(error?.message || "Failed to close survey");
        }

        // Dismiss loading toast and show success
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Survey Closed",
          description: "The survey has been closed and is no longer accepting responses.",
          type: "success"
        });

        // Track the close event
        trackEvent("survey_closed" as any, {
          course_id: Number(courseId),
          survey_id: survey.survey_id
        });

        // Refresh the page to show updated status
        window.location.reload();
      } catch (error) {
        // Dismiss loading toast and show error
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Failed to Close Survey",
          description: error instanceof Error ? error.message : "An unexpected error occurred",
          type: "error"
        });
      }
    },
    [courseId, trackEvent]
  );

  const handleDelete = useCallback(
    async (survey: SurveyWithCounts) => {
      // Check if survey has responses first
      if (survey.response_count > 0) {
        // Show confirmation dialog for surveys with responses
        const confirmed = window.confirm(
          `This survey has ${survey.response_count} response(s). Deleting it will hide the survey from view but preserve all response data for record keeping. This action can be undone by restoring the survey.\n\nAre you sure you want to delete "${survey.title}"?`
        );

        if (!confirmed) {
          return;
        }
      } else {
        // Show simple confirmation dialog for surveys without responses (drafts)
        const confirmed = window.confirm(`Are you sure you want to delete "${survey.title}"?`);

        if (!confirmed) {
          return;
        }
      }

      // Show loading toast
      const loadingToast = toaster.create({
        title: "Deleting Survey",
        description: "Soft deleting survey and responses...",
        type: "loading"
      });

      try {
        const supabase = createClient();
        const now = new Date().toISOString();

        // Soft delete all survey responses first (set deleted_at timestamp)
        const { error: responsesError } = await supabase
          .from("survey_responses" as any)
          .update({ deleted_at: now })
          .eq("survey_id", survey.id)
          .is("deleted_at", null); // Only update records that aren't already soft deleted

        if (responsesError) {
          throw new Error(`Failed to soft delete survey responses: ${responsesError.message}`);
        }

        // Soft delete all survey versions (all records with the same survey_id)
        const { error: surveysError } = await supabase
          .from("surveys" as any)
          .update({ deleted_at: now })
          .eq("survey_id", survey.survey_id)
          .is("deleted_at", null); // Only update records that aren't already soft deleted

        if (surveysError) {
          throw new Error(`Failed to soft delete survey: ${surveysError.message}`);
        }

        // Dismiss loading toast and show success
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Survey Deleted",
          description: `"${survey.title}" has been deleted. All response data has been preserved and can be restored if needed.`,
          type: "success"
        });

        // Track the delete event
        trackEvent("survey_deleted" as any, {
          course_id: Number(courseId),
          survey_id: survey.survey_id,
          had_responses: survey.response_count > 0,
          response_count: survey.response_count,
          soft_delete: true
        });

        // Refresh the page to show updated list
        window.location.reload();
      } catch (error) {
        // Dismiss loading toast and show error
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Failed to Delete Survey",
          description: error instanceof Error ? error.message : "An unexpected error occurred",
          type: "error"
        });
      }
    },
    [courseId, trackEvent]
  );

  return (
    <>
      {/* Filter Buttons */}
      <HStack gap={2} mb={4}>
        <Button
          size="sm"
          variant="outline"
          bg={activeFilter === "all" ? filterButtonActiveBg : filterButtonInactiveBg}
          color={activeFilter === "all" ? filterButtonActiveColor : filterButtonInactiveColor}
          borderColor={activeFilter === "all" ? filterButtonActiveBg : tableBorderColor}
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
          bg={activeFilter === "completed" ? filterButtonActiveBg : filterButtonInactiveBg}
          color={activeFilter === "completed" ? filterButtonActiveColor : filterButtonInactiveColor}
          borderColor={activeFilter === "completed" ? filterButtonActiveBg : tableBorderColor}
          _hover={{
            bg: activeFilter === "completed" ? filterButtonActiveBg : filterButtonHoverBg
          }}
          onClick={() => setActiveFilter("completed")}
        >
          Completed
        </Button>
        <Button
          size="sm"
          variant="outline"
          bg={activeFilter === "awaiting" ? filterButtonActiveBg : filterButtonInactiveBg}
          color={activeFilter === "awaiting" ? filterButtonActiveColor : filterButtonInactiveColor}
          borderColor={activeFilter === "awaiting" ? filterButtonActiveBg : tableBorderColor}
          _hover={{
            bg: activeFilter === "awaiting" ? filterButtonActiveBg : filterButtonHoverBg
          }}
          onClick={() => setActiveFilter("awaiting")}
        >
          Awaiting Responses
        </Button>
      </HStack>

      <Box border="1px solid" borderColor={tableBorderColor} borderRadius="lg" overflow="hidden" overflowX="auto">
        <Table.Root variant="outline" size="md">
        <Table.Header>
          <Table.Row bg={tableHeaderBg}>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
              pl={6}
            >
              TITLE
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
            >
              STATUS
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
            >
              VERSION
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
            >
              RESPONSES
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
            >
              CREATED
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontSize="xs"
              fontWeight="semibold"
              textTransform="uppercase"
              py={3}
              pr={0}
            >
              ACTIONS
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {filteredSurveys.map((survey) => (
            <Table.Row key={survey.id} bg={tableRowBg} borderColor={tableBorderColor}>
              <Table.Cell py={4} pl={6}>
                <Link href={getSurveyLink(survey)} style={{ color: "#3182CE" }}>
                  {survey.title}
                </Link>
              </Table.Cell>
              <Table.Cell py={4}>{getStatusBadge(survey.status)}</Table.Cell>
              <Table.Cell py={4}>
                <Badge
                  px={2}
                  py={1}
                  borderRadius="md"
                  fontSize="xs"
                  bg={versionBadgeBg}
                  border="1px solid"
                  borderColor={versionBadgeBorder}
                  color={versionBadgeText}
                >
                  v{survey.version}
                </Badge>
              </Table.Cell>
              <Table.Cell py={4}>
                <Text color={textColor}>
                  {survey.status === "draft" ? "—" : `${survey.response_count}/${totalStudents} responded`}
                </Text>
              </Table.Cell>
              <Table.Cell py={4}>
                <Text color={textColor}>
                  {formatInTimeZone(new TZDate(survey.created_at), timezone, "MMM d, yyyy")}
                </Text>
              </Table.Cell>
              <Table.Cell pr={3}>
                <MenuRoot>
                  <MenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      border="1px solid"
                      borderColor={actionsButtonBorder}
                      _focus={{ borderColor: actionsButtonBorder, boxShadow: "none", outline: "none" }}
                      _active={{ borderColor: actionsButtonBorder, boxShadow: "none", outline: "none" }}
                    >
                      <Icon as={HiOutlineDotsHorizontal} color={tableHeaderTextColor} />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    {survey.status === "draft" && (
                      <>
                        <MenuItem value="edit" asChild>
                          <Link href={getSurveyLink(survey)}>Edit</Link>
                        </MenuItem>
                        <MenuItem value="publish" onClick={() => handlePublish(survey)}>
                          Publish
                        </MenuItem>
                        <MenuItem value="delete" color="red.500" onClick={() => handleDelete(survey)}>
                          Delete
                        </MenuItem>
                      </>
                    )}
                    {survey.status === "published" && (
                      <>
                        <MenuItem value="responses" asChild>
                          <Link href={`/course/${courseId}/manage/surveys/${survey.survey_id}/responses`}>
                            View Responses
                          </Link>
                        </MenuItem>
                        <MenuItem value="edit" asChild>
                          <Link href={getSurveyLink(survey)}>Edit (New Version)</Link>
                        </MenuItem>
                        <MenuItem value="close" onClick={() => handleClose(survey)}>
                          Close
                        </MenuItem>
                        <MenuItem value="delete" color="red.500" onClick={() => handleDelete(survey)}>
                          Delete
                        </MenuItem>
                      </>
                    )}
                    {survey.status === "closed" && (
                      <>
                        <MenuItem value="responses" asChild>
                          <Link href={`/course/${courseId}/manage/surveys/${survey.survey_id}/responses`}>
                            View Responses
                          </Link>
                        </MenuItem>
                        <MenuItem value="reopen">Re-open</MenuItem>
                        <MenuItem value="delete" color="red.500" onClick={() => handleDelete(survey)}>
                          Delete
                        </MenuItem>
                      </>
                    )}
                  </MenuContent>
                </MenuRoot>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
    </>
  );
}
