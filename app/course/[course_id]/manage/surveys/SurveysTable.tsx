"use client";

import SurveyFilterButtons from "@/components/survey/SurveyFilterButtons";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { useIsGrader, useIsInstructor } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import type { Survey, SurveyWithCounts } from "@/types/survey";
import { Badge, Box, Icon, Table, Text } from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { HiOutlineDotsHorizontal } from "react-icons/hi";

type FilterType = "all" | "closed" | "active" | "draft";

type SurveysTableProps = {
  surveys: SurveyWithCounts[];
  courseId: string;
};

export default function SurveysTable({ surveys, courseId }: SurveysTableProps) {
  const trackEvent = useTrackEvent();
  const controller = useCourseController();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const isInstructor = useIsInstructor();
  const isGrader = useIsGrader();

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
      published: { colorPalette: "green" },
      draft: { colorPalette: "yellow" },
      closed: { colorPalette: "red" }
    };

    const colors = statusMap[status as keyof typeof statusMap] || statusMap.draft;

    return (
      <Badge
        colorPalette={colors.colorPalette}
        bg={`${colors.colorPalette}.subtle`}
        color={`${colors.colorPalette}.fg`}
        px={2}
        py={1}
        borderRadius="md"
        fontSize="xs"
        fontWeight="medium"
        textTransform="capitalize"
      >
        {status}
      </Badge>
    );
  };

  const getSurveyLink = (survey: Survey) => {
    // Graders can only view responses for published/closed surveys, not edit
    if (isGrader && (survey.status === "published" || survey.status === "closed")) {
      return `/course/${courseId}/manage/surveys/${survey.survey_id}/responses`;
    }

    // Instructors: route based on survey status
    if (survey.status === "draft") {
      return `/course/${courseId}/manage/surveys/${survey.id}/edit`;
    } else if (survey.status === "published") {
      // Instructors can edit published surveys
      return isInstructor
        ? `/course/${courseId}/manage/surveys/${survey.id}/edit`
        : `/course/${courseId}/manage/surveys/${survey.survey_id}/responses`;
    } else if (survey.status === "closed") {
      // For closed surveys, instructors and graders both view responses
      return `/course/${courseId}/manage/surveys/${survey.survey_id}/responses`;
    }

    // Default fallback
    return `/course/${courseId}/manage/surveys/${survey.id}`;
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

        // Update survey status using TableController - auto-refreshes UI via realtime
        await controller.surveys.update(survey.id, {
          status: validationErrors ? "draft" : "published",
          validation_errors: validationErrors
        });

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
    [courseId, trackEvent, controller]
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
        // Update survey status using TableController - auto-refreshes UI via realtime
        await controller.surveys.update(survey.id, {
          status: "closed"
        });

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
    [courseId, trackEvent, controller]
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
        // Soft delete survey and responses atomically via RPC
        // The RPC sets deleted_at which triggers realtime broadcast and auto-refreshes UI
        const { error } = await controller.client.rpc("soft_delete_survey", {
          p_survey_id: survey.id,
          p_survey_logical_id: survey.survey_id
        });

        if (error) {
          throw new Error(`Failed to soft delete survey: ${error.message}`);
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
    [courseId, trackEvent, controller]
  );

  return (
    <>
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

      <Box border="1px solid" borderColor="border" borderRadius="lg" overflow="hidden" overflowX="auto">
        <Table.Root variant="outline" size="md">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader
                color="fg.muted"
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
                pl={6}
              >
                TITLE
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontSize="xs" fontWeight="semibold" textTransform="uppercase" py={3}>
                STATUS
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontSize="xs" fontWeight="semibold" textTransform="uppercase" py={3}>
                VERSION
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontSize="xs" fontWeight="semibold" textTransform="uppercase" py={3}>
                RESPONSES
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontSize="xs" fontWeight="semibold" textTransform="uppercase" py={3}>
                CREATED
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontSize="xs" fontWeight="semibold" textTransform="uppercase" py={3}>
                DUE DATE
              </Table.ColumnHeader>
              <Table.ColumnHeader
                color="fg.muted"
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
              <Table.Row key={survey.id} bg="bg.muted" borderColor="border">
                <Table.Cell py={4} pl={6}>
                  {!isInstructor && survey.status === "draft" ? (
                    <Text color="fg">{survey.title}</Text>
                  ) : (
                    <Link href={getSurveyLink(survey)} style={{ color: "var(--chakra-colors-blue-fg)" }}>
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
                    bg="bg.subtle"
                    border="1px solid"
                    borderColor="border"
                    color="fg.muted"
                  >
                    v{survey.version}
                  </Badge>
                </Table.Cell>
                <Table.Cell py={4}>
                  <Text color="fg">
                    {survey.status === "draft"
                      ? "—"
                      : `${survey.response_count}/${survey.assigned_student_count} responded`}
                  </Text>
                </Table.Cell>
                <Table.Cell py={4}>
                  <Text color="fg">
                    <TimeZoneAwareDate date={survey.created_at} format="MMM d" />
                  </Text>
                </Table.Cell>
                <Table.Cell py={4}>
                  <Text color={survey.due_date ? "fg" : "fg.muted"}>
                    {survey.due_date ? <TimeZoneAwareDate date={survey.due_date} format="MMM d, h:mm a" /> : "—"}
                  </Text>
                </Table.Cell>
                <Table.Cell pr={3}>
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        border="1px solid"
                        borderColor="border"
                        _focus={{ borderColor: "border", boxShadow: "none", outline: "none" }}
                        _active={{ borderColor: "border", boxShadow: "none", outline: "none" }}
                      >
                        <Icon as={HiOutlineDotsHorizontal} color="fg.muted" />
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
