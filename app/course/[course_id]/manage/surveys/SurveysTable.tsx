"use client";

import { Box, Table, Text, Badge, Icon } from "@chakra-ui/react";
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
import { useIsInstructor } from "@/hooks/useClassProfiles";
import SurveyFilterButtons from "@/components/survey/SurveyFilterButtons";
import type { Survey, SurveyWithCounts } from "@/types/survey";

type FilterType = "all" | "closed" | "active" | "draft";

type SurveysTableProps = {
  surveys: SurveyWithCounts[];
  totalStudents: number;
  courseId: string;
  timezone: string;
};

export default function SurveysTable({ surveys, totalStudents, courseId, timezone }: SurveysTableProps) {
  const trackEvent = useTrackEvent();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const isInstructor = useIsInstructor();

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

  // Filter options for instructor view
  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: "All" },
      { value: "active" as const, label: "Active" },
      { value: "draft" as const, label: "Drafts" },
      { value: "closed" as const, label: "Closed" }
    ],
    []
  );

  // Filter surveys based on status
  const filteredSurveys = useMemo(() => {
    if (activeFilter === "all") {
      return surveys;
    }

    return surveys.filter((survey) => {
      if (activeFilter === "closed") {
        return survey.status === "closed";
      } else if (activeFilter === "draft") {
        return survey.status === "draft";
      } else if (activeFilter === "active") {
        return survey.status === "published";
      }

      return true;
    });
  }, [surveys, activeFilter]);

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
    // Non-instructors should go to the student survey-taking page for published/closed surveys
    if (!isInstructor && (survey.status === "published" || survey.status === "closed")) {
      return `/course/${courseId}/surveys/${survey.id}`;
    }

    // Instructors: route based on survey status
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
      // Validate due date
      if (survey.due_date) {
        const dueDate = new Date(survey.due_date);
        const now = new Date();

        if (dueDate < now) {
          toaster.create({
            title: "Cannot Publish Survey",
            description:
              "The due date is in the past. Please edit the survey and update the due date before publishing.",
            type: "error"
          });
          return;
        }
      }

      // Show loading toast
      const loadingToast = toaster.create({
        title: "Publishing Survey",
        description: "Updating survey status...",
        type: "loading"
      });

      try {
        const supabase = createClient();

        // Validate JSON before publishing
        // survey.json is already a parsed object from Supabase (JSONB columns are auto-deserialized)
        let validationErrors = null;
        try {
          if (survey.json) {
            // If it's already an object, validate by stringifying and parsing
            // If it's a string, parse it
            if (typeof survey.json === "string") {
              JSON.parse(survey.json);
            } else {
              // Already an object, validate by ensuring it can be stringified
              JSON.stringify(survey.json);
            }
          }
        } catch (error) {
          validationErrors = `Invalid JSON configuration: ${error instanceof Error ? error.message : "Unknown error"}`;
        }

        // Update survey status to published
        const { data, error } = await supabase
          .from("surveys")
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
        trackEvent("survey_published", {
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
          .from("surveys")
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
        trackEvent("survey_closed", {
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
          .from("survey_responses")
          .update({ deleted_at: now })
          .eq("survey_id", survey.id)
          .is("deleted_at", null); // Only update records that aren't already soft deleted

        if (responsesError) {
          throw new Error(`Failed to soft delete survey responses: ${responsesError.message}`);
        }

        // Soft delete all survey versions (all records with the same survey_id)
        const { error: surveysError } = await supabase
          .from("surveys")
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
        trackEvent("survey_deleted", {
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
      <SurveyFilterButtons
        activeFilter={activeFilter}
        setActiveFilter={setActiveFilter}
        filterOptions={filterOptions}
        filterButtonActiveBg={filterButtonActiveBg}
        filterButtonActiveColor={filterButtonActiveColor}
        filterButtonInactiveBg={filterButtonInactiveBg}
        filterButtonInactiveColor={filterButtonInactiveColor}
        filterButtonHoverBg={filterButtonHoverBg}
        tableBorderColor={tableBorderColor}
      />

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
              >
                DUE DATE
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
                  {!isInstructor && survey.status === "draft" ? (
                    <Text color={textColor}>{survey.title}</Text>
                  ) : (
                    <Link href={getSurveyLink(survey)} style={{ color: "#3182CE" }}>
                      {survey.title}
                    </Link>
                  )}
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
                <Table.Cell py={4}>
                  <Text color={survey.due_date ? textColor : "gray.500"}>
                    {survey.due_date
                      ? formatInTimeZone(new TZDate(survey.due_date), timezone, "MMM d, yyyy h:mm a")
                      : "—"}
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
                      {survey.status === "draft" && isInstructor && (
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
                      {survey.status === "draft" && !isInstructor && (
                        <MenuItem value="no-access" disabled>
                          No Actions Available
                        </MenuItem>
                      )}
                      {survey.status === "published" && (
                        <>
                          <MenuItem value="responses" asChild>
                            <Link href={`/course/${courseId}/manage/surveys/${survey.survey_id}/responses`}>
                              View Responses
                            </Link>
                          </MenuItem>
                          {isInstructor && (
                            <>
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
                        </>
                      )}
                      {survey.status === "closed" && (
                        <>
                          <MenuItem value="responses" asChild>
                            <Link href={`/course/${courseId}/manage/surveys/${survey.survey_id}/responses`}>
                              View Responses
                            </Link>
                          </MenuItem>
                          {isInstructor && (
                            <>
                              <MenuItem value="delete" color="red.500" onClick={() => handleDelete(survey)}>
                                Delete
                              </MenuItem>
                            </>
                          )}
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
