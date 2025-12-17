"use client";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { Assignment, HelpRequest, Submission, SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { Accordion, Badge, Box, Flex, HStack, Icon, IconButton, Input, Separator, Stack, Text } from "@chakra-ui/react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BsArrowLeft,
  BsBoxArrowUpRight,
  BsCheck,
  BsCheckCircle,
  BsChevronDown,
  BsClock,
  BsCode,
  BsFileEarmark,
  BsHandIndex,
  BsPencil,
  BsPeople,
  BsPersonCheck,
  BsPersonDash,
  BsShield,
  BsStar,
  BsTrash,
  BsXCircle
} from "react-icons/bs";
import CreateKarmaEntryModal from "@/app/course/[course_id]/manage/office-hours/modals/createKarmaEntryModal";
import CreateModerationActionModal from "@/app/course/[course_id]/manage/office-hours/modals/createModerationActionModal";
import { RealtimeChat } from "@/components/realtime-chat";
import PersonAvatar from "@/components/ui/person-avatar";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import useModalManager from "@/hooks/useModalManager";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import HelpRequestFeedbackModal from "./help-request-feedback-modal";
import VideoCallControls from "./video-call-controls";

import StudentGroupPicker from "@/components/ui/student-group-picker";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import {
  useHelpRequest,
  useHelpRequestFeedback,
  useHelpRequestFileReferences,
  useHelpRequestStudents,
  useOfficeHoursController
} from "@/hooks/useOfficeHoursRealtime";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import Link from "next/link";
import { HelpRequestWatchButton } from "./help-request-watch-button";
import StudentSummaryTrigger from "../ui/student-summary";
import DiscordMessageLink from "@/components/discord/discord-message-link";
import { formatDistanceToNow } from "date-fns";

/**
 * Office hours form and UI helper types
 */
export type HelpRequestFormFileReference = {
  submission_file_id: number;
  line_number?: number;
};

// Type for help request students relationship
type HelpRequestStudent = {
  id: number;
  help_request_id: number;
  profile_id: string;
  class_id: number;
  created_at: string;
};

// Extended type for editing file references that includes ID
type EditingFileReference = HelpRequestFormFileReference & {
  id?: number;
};

/**
 * Status configuration for help requests
 */
const statusConfig: Record<string, { colorPalette: string; icon: typeof BsClock; label: string }> = {
  open: { colorPalette: "blue", icon: BsClock, label: "Open" },
  in_progress: { colorPalette: "orange", icon: BsClock, label: "In Progress" },
  resolved: { colorPalette: "green", icon: BsCheckCircle, label: "Resolved" },
  closed: { colorPalette: "gray", icon: BsXCircle, label: "Closed" }
};

/**
 * Component for displaying help request status badge
 */
const HelpRequestStatusBadge = ({ status }: { status: string }) => {
  const config = statusConfig[status] || statusConfig.open;
  return (
    <Badge colorPalette={config.colorPalette} size="sm">
      <Icon as={config.icon} mr={1} />
      {config.label}
    </Badge>
  );
};

/**
 * Formats elapsed time in HH:MM:SS or MM:SS format
 */
const formatElapsedTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
};

/**
 * Timer component that shows elapsed time since help started
 * Updates every second while mounted
 */
const HelpingTimer = ({ startTime }: { startTime: string }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startDate = new Date(startTime);

    // Calculate initial elapsed time
    const calculateElapsed = () => {
      const now = new Date();
      return Math.floor((now.getTime() - startDate.getTime()) / 1000);
    };

    setElapsedSeconds(calculateElapsed());

    // Update every second
    const interval = setInterval(() => {
      setElapsedSeconds(calculateElapsed());
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <Badge colorPalette="orange" variant="surface" size="sm">
      <Icon as={BsClock} mr={1} />
      {formatElapsedTime(elapsedSeconds)}
    </Badge>
  );
};

/**
 * Component for managing help request assignment status and actions
 * @param request - The help request object
 * @param compact - Whether to show compact view (badge only)
 * @returns JSX element for assignment controls
 */
const HelpRequestAssignment = ({ request, compact = false }: { request: HelpRequest; compact?: boolean }) => {
  const { private_profile_id } = useClassProfiles();
  const profiles = useAllProfilesForClass();

  // Get student data using individual hooks
  const allHelpRequestStudents = useHelpRequestStudents();
  const helpRequestStudentData = allHelpRequestStudents.filter((student) => student.help_request_id === request.id);

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequests, studentHelpActivity } = controller;

  // Get assignee name
  const assigneeName = useMemo(() => {
    if (!request.assignee) return null;
    const profile = profiles.find((p) => p.id === request.assignee);
    return profile?.name || "Unknown";
  }, [request.assignee, profiles]);

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      const requestStudents = helpRequestStudentData;

      for (const student of requestStudents) {
        try {
          await studentHelpActivity.create({
            student_profile_id: student.profile_id,
            class_id: request.class_id,
            help_request_id: request.id,
            activity_type: activityType,
            activity_description: description
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [request.id, request.class_id, studentHelpActivity, helpRequestStudentData]
  );

  // Disable assignment actions for resolved/closed requests
  const isRequestInactive = request.status === "resolved" || request.status === "closed";
  const canShowActions = request.status === "open" || request.status === "in_progress";

  // Compact view for metadata display
  if (compact) {
    if (request.assignee === private_profile_id) {
      return (
        <Badge colorPalette="green" size="sm">
          Assigned to you
        </Badge>
      );
    } else if (request.assignee) {
      return (
        <Badge colorPalette="blue" size="sm">
          {assigneeName}
        </Badge>
      );
    }
    return (
      <Badge colorPalette="gray" variant="outline" size="sm">
        Unassigned
      </Badge>
    );
  }

  // Full view with actions
  if (request.assignee === private_profile_id) {
    return (
      <HStack gap={2}>
        <Badge colorPalette="green" size="sm">
          <Icon as={BsPersonCheck} mr={1} />
          Helping
        </Badge>
        {/* Timer showing how long help has been in progress (uses updated_at as proxy) */}
        {request.status === "in_progress" && request.updated_at && <HelpingTimer startTime={request.updated_at} />}
        {canShowActions && (
          <Tooltip content="Stop helping and return to queue" showArrow>
            <Button
              aria-label="Stop Helping"
              size="xs"
              variant="ghost"
              colorPalette="red"
              disabled={isRequestInactive}
              onClick={async () => {
                await helpRequests.update(request.id, { assignee: null, status: "open" });
                await logActivityForAllStudents("request_updated", "Request assignment dropped and returned to queue");
                toaster.success({
                  title: "Help request successfully updated",
                  description: `Help request ${request.id} updated`
                });
              }}
            >
              <Icon as={BsPersonDash} />
              Stop
            </Button>
          </Tooltip>
        )}
      </HStack>
    );
  } else if (request.assignee) {
    return (
      <HStack gap={2}>
        <Badge colorPalette="blue" size="sm">
          <Icon as={BsPersonCheck} mr={1} />
          {assigneeName}
        </Badge>
        {/* Timer showing how long help has been in progress */}
        {request.status === "in_progress" && request.updated_at && <HelpingTimer startTime={request.updated_at} />}
      </HStack>
    );
  } else {
    // Unassigned - show prominent "Start Helping" button
    return (
      <>
        {canShowActions && (
          <Button
            aria-label="Start Helping"
            size="sm"
            colorPalette="green"
            disabled={isRequestInactive}
            onClick={async () => {
              await helpRequests.update(request.id, {
                assignee: private_profile_id,
                status: "in_progress"
              });
              await logActivityForAllStudents("request_updated", "Request assigned and marked as in progress");
              toaster.success({
                title: "You're now helping!",
                description: "This request has been assigned to you."
              });
            }}
          >
            <Icon as={BsHandIndex} />
            Start Helping
          </Button>
        )}
      </>
    );
  }
};

/**
 * Component to display and manage referenced files and submissions for a help request
 * @param request - The help request object
 * @param canEdit - Whether the current user can edit the file references
 * @returns JSX element showing file references with optional editing
 */
const HelpRequestFileReferences = ({ request, canEdit }: { request: HelpRequest; canEdit: boolean }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingReferences, setEditingReferences] = useState<EditingFileReference[]>([]);
  const [editingSubmissionId, setEditingSubmissionId] = useState<number | null>(null);
  const { private_profile_id } = useClassProfiles();

  // Get file references using individual hook
  const { fileReferences: currentFileReferences } = useHelpRequestFileReferences(request.id);

  // Fetch referenced submission if any
  const { data: referencedSubmission, refetch: refetchSubmission } = useList<Submission>({
    resource: "submissions",
    filters: [{ field: "id", operator: "eq", value: request.referenced_submission_id }],
    queryOptions: {
      enabled: !!request.referenced_submission_id
    }
  });

  // Fetch the actual files referenced to get their name
  const fileReferenceIds = currentFileReferences?.map((ref) => ref.submission_file_id) || [];
  const { data: referencedFiles, refetch: refetchReferencedFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [{ field: "id", operator: "in", value: fileReferenceIds }],
    queryOptions: {
      enabled: fileReferenceIds.length > 0
    }
  });

  // Fetch all files from the referenced submission for adding new references
  const { data: submissionFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [
      { field: "submission_id", operator: "eq", value: editingSubmissionId || request.referenced_submission_id }
    ],
    queryOptions: {
      enabled: !!(editingSubmissionId || request.referenced_submission_id) && isEditing
    }
  });

  // Fetch assignments for submission selection
  const { data: assignments } = useList<Assignment>({
    resource: "assignments",
    filters: [
      { field: "class_id", operator: "eq", value: request.class_id },
      { field: "release_date", operator: "lte", value: new Date().toISOString() }
    ],
    sorters: [{ field: "due_date", order: "desc" }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: isEditing
    }
  });

  // Fetch user's submissions for selection
  const { data: userSubmissions } = useList<Submission>({
    resource: "submissions",
    filters: [
      { field: "profile_id", operator: "eq", value: private_profile_id },
      ...(assignments?.data
        ? [{ field: "assignment_id", operator: "in" as const, value: assignments.data.map((a) => a.id) }]
        : [])
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: isEditing && !!private_profile_id && !!assignments?.data
    }
  });

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequestFileReferences, helpRequests } = controller;

  const hasReferences = !!request.referenced_submission_id || (currentFileReferences?.length ?? 0) > 0;

  /**
   * Initialize editing mode with current file references and submission
   */
  const handleEditClick = useCallback(() => {
    if (!currentFileReferences) return;

    // Convert database references to form format
    const formReferences: EditingFileReference[] = currentFileReferences.map((ref) => ({
      id: ref.id, // Include ID for existing references
      submission_file_id: ref.submission_file_id!,
      line_number: ref.line_number || undefined
    }));

    setEditingReferences(formReferences);
    setEditingSubmissionId(request.referenced_submission_id);
    setIsEditing(true);
  }, [currentFileReferences, request.referenced_submission_id]);

  /**
   * Cancel editing and revert changes
   */
  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditingReferences([]);
    setEditingSubmissionId(null);
  }, []);

  /**
   * Add a new file reference to the editing list
   */
  const handleAddFileReference = useCallback((fileId: number) => {
    const newRef: EditingFileReference = {
      submission_file_id: fileId,
      line_number: undefined
    };
    setEditingReferences((prev) => [...prev, newRef]);
  }, []);

  /**
   * Remove a file reference from the editing list
   */
  const handleRemoveFileReference = useCallback((index: number) => {
    setEditingReferences((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * Update line number for a file reference
   */
  const handleUpdateLineNumber = useCallback((index: number, lineNumber: number | undefined) => {
    setEditingReferences((prev) => prev.map((ref, i) => (i === index ? { ...ref, line_number: lineNumber } : ref)));
  }, []);

  /**
   * Handle submission reference change
   */
  const handleSubmissionChange = useCallback(
    (submissionId: number | null) => {
      setEditingSubmissionId(submissionId);
      // Clear file references when submission changes
      if (submissionId !== request.referenced_submission_id) {
        setEditingReferences([]);
      }
    },
    [request.referenced_submission_id]
  );

  /**
   * Save file reference and submission changes
   */
  const handleSaveChanges = useCallback(async () => {
    try {
      const currentRefs = currentFileReferences || [];
      const newRefs = editingReferences;

      // Determine which references to create, update, and delete
      const refsToCreate = newRefs.filter((ref) => !ref.id);
      const refsToUpdate = newRefs.filter((ref) => ref.id);
      const refsToDelete = currentRefs.filter((current) => !newRefs.some((newRef) => newRef.id === current.id));

      // Delete removed references
      for (const ref of refsToDelete) {
        await helpRequestFileReferences.delete(ref.id);
      }

      // Update existing references
      for (const ref of refsToUpdate) {
        if (ref.id) {
          await helpRequestFileReferences.update(ref.id, {
            line_number: ref.line_number
          });
        }
      }

      // Create new references (only if we have a submission reference)
      if (editingSubmissionId && newRefs.length > 0) {
        const selectedSubmission = userSubmissions?.data?.find((s) => s.id === editingSubmissionId);
        if (!selectedSubmission?.assignment_id) {
          throw new Error("Assignment ID not found for the selected submission");
        }

        for (const ref of refsToCreate) {
          await helpRequestFileReferences.create({
            help_request_id: request.id,
            class_id: request.class_id,
            assignment_id: selectedSubmission.assignment_id,
            submission_file_id: ref.submission_file_id,
            submission_id: editingSubmissionId,
            line_number: ref.line_number ?? null
          });
        }
      }

      // Update help request with new submission reference and privacy
      const hasFileReferences = newRefs.length > 0;
      const hasSubmissionReference = editingSubmissionId !== null;
      const shouldBePrivate = hasFileReferences || hasSubmissionReference;

      await helpRequests.update(request.id, {
        referenced_submission_id: editingSubmissionId,
        is_private: shouldBePrivate
      });

      // Show appropriate privacy message
      if (shouldBePrivate && !request.is_private) {
        toaster.success({
          title: "Privacy Updated",
          description: "Help request has been marked as private due to code references."
        });
      } else if (!shouldBePrivate && request.is_private) {
        toaster.success({
          title: "Privacy Updated",
          description: "Help request has been made public as it no longer contains code references."
        });
      }

      // Refetch data to update UI
      await Promise.all([refetchReferencedFiles(), refetchSubmission()]);

      setIsEditing(false);
      setEditingReferences([]);
      setEditingSubmissionId(null);

      toaster.success({
        title: "Code references updated",
        description: "The code references have been successfully updated."
      });
    } catch (error) {
      toaster.error({
        title: "Failed to update code references",
        description: "There was an error updating the code references: " + (error as Error).message
      });
    }
  }, [
    request,
    currentFileReferences,
    editingReferences,
    editingSubmissionId,
    userSubmissions,
    helpRequestFileReferences,
    helpRequests,
    refetchReferencedFiles,
    refetchSubmission
  ]);

  // Get available files for adding (not already referenced)
  const availableFiles = useMemo(() => {
    if (!submissionFiles?.data) return [];

    return submissionFiles.data.filter((file) => !editingReferences.some((ref) => ref.submission_file_id === file.id));
  }, [submissionFiles?.data, editingReferences]);

  // Get the currently editing submission for display
  const editingSubmission = useMemo(() => {
    if (!editingSubmissionId || !userSubmissions?.data) return null;
    return userSubmissions.data.find((s) => s.id === editingSubmissionId);
  }, [editingSubmissionId, userSubmissions?.data]);

  const isInstructorOrGrader = useIsGraderOrInstructor();

  // Show add button when no references exist but user can edit
  if (!hasReferences && !isEditing) {
    if (canEdit && request.status !== "resolved" && request.status !== "closed" && !isInstructorOrGrader) {
      return (
        <Box m={4}>
          <Button size="sm" colorPalette="blue" onClick={handleEditClick}>
            <Icon as={BsCode} />
            Add code references
          </Button>
        </Box>
      );
    }
    return null;
  }

  return (
    <Accordion.Root collapsible defaultValue={isEditing ? ["help-request-file-refs"] : []}>
      <Accordion.Item value="help-request-file-refs">
        <Accordion.ItemTrigger px={2} py={1} _hover={{ bg: "transparent" }}>
          <HStack gap={2} justifyContent="space-between" w="100%">
            <HStack gap={2}>
              <Icon as={BsCode} />
              <Text fontWeight="medium" fontSize="sm">
                Referenced Code
              </Text>
            </HStack>
            <HStack gap={1}>
              {canEdit && request.status !== "resolved" && request.status !== "closed" && !isEditing && (
                <Tooltip content="Edit code references" showArrow>
                  <IconButton aria-label="Edit code references" size="xs" variant="ghost" onClick={handleEditClick}>
                    <Icon as={BsPencil} />
                  </IconButton>
                </Tooltip>
              )}
              <Accordion.ItemIndicator>
                <Icon as={BsChevronDown} />
              </Accordion.ItemIndicator>
            </HStack>
          </HStack>
        </Accordion.ItemTrigger>
        <Accordion.ItemContent>
          <Accordion.ItemBody px={2} py={2}>
            <Stack spaceY={3}>
              {isEditing ? (
                <Box>
                  <Box mb={4}>
                    <Text fontSize="sm" fontWeight="medium" mb={2}>
                      Referenced Submission:
                    </Text>
                    <Select
                      placeholder="Select a submission to reference (optional)"
                      isClearable={true}
                      value={
                        editingSubmissionId && editingSubmission
                          ? {
                              label: `${editingSubmission.repository} (Run #${editingSubmission.run_number}) - ${new Date(editingSubmission.created_at).toLocaleDateString()}`,
                              value: editingSubmissionId.toString()
                            }
                          : null
                      }
                      options={
                        userSubmissions?.data
                          ?.filter((submission) => submission.id)
                          .map((submission) => ({
                            label: `${submission.repository} (Run #${submission.run_number}) - ${new Date(submission.created_at).toLocaleDateString()}`,
                            value: submission.id!.toString()
                          })) || []
                      }
                      onChange={(option: { label: string; value: string } | null) => {
                        const submissionId = option?.value ? Number.parseInt(option.value) : null;
                        handleSubmissionChange(submissionId);
                      }}
                    />
                  </Box>

                  {editingSubmissionId && (
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={2}>
                        Specific Files (Optional):
                      </Text>

                      {editingReferences.length > 0 && (
                        <Stack spaceY={2} mb={4}>
                          {editingReferences.map((ref, index) => {
                            const fileName =
                              submissionFiles?.data?.find((f) => f.id === ref.submission_file_id)?.name || "Unknown";
                            return (
                              <Box
                                key={`editing-ref-${index}-${ref.submission_file_id}`}
                                p={3}
                                border="1px solid"
                                borderColor="gray.200"
                                borderRadius="md"
                              >
                                <HStack justify="space-between" align="center">
                                  <HStack flex={1}>
                                    <Icon as={BsFileEarmark} color="fg.muted" />
                                    <Text fontWeight="medium">{fileName}</Text>
                                  </HStack>
                                  <HStack>
                                    <Input
                                      placeholder="Line number (optional)"
                                      type="number"
                                      value={ref.line_number || ""}
                                      onChange={(e) => {
                                        const lineNumber = e.target.value ? Number.parseInt(e.target.value) : undefined;
                                        handleUpdateLineNumber(index, lineNumber);
                                      }}
                                      width="150px"
                                      min={1}
                                      size="sm"
                                    />
                                    <IconButton
                                      aria-label="Remove file reference"
                                      size="sm"
                                      colorPalette="red"
                                      onClick={() => handleRemoveFileReference(index)}
                                    >
                                      <Icon as={BsTrash} />
                                    </IconButton>
                                  </HStack>
                                </HStack>
                              </Box>
                            );
                          })}
                        </Stack>
                      )}

                      {availableFiles.length > 0 && (
                        <Box mb={4}>
                          <Text fontSize="sm" fontWeight="medium" mb={2}>
                            Add specific file:
                          </Text>
                          <Select
                            placeholder="Select a file to add"
                            options={availableFiles.map((file) => ({
                              label: file.name,
                              value: file.id.toString()
                            }))}
                            onChange={(option: { label: string; value: string } | null) => {
                              if (option) {
                                handleAddFileReference(Number.parseInt(option.value));
                              }
                            }}
                            value={null}
                            isClearable={false}
                          />
                        </Box>
                      )}
                    </Box>
                  )}

                  <HStack>
                    <Button size="sm" onClick={handleCancelEdit}>
                      Cancel
                    </Button>
                    <Button size="sm" colorPalette="green" onClick={handleSaveChanges} loading={false}>
                      Save Changes
                    </Button>
                  </HStack>
                </Box>
              ) : (
                <Box>
                  {request.referenced_submission_id && referencedSubmission?.data?.[0] && (
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={2}>
                        Submission:
                      </Text>
                      <HStack>
                        <Badge colorPalette="blue">{referencedSubmission.data[0].repository}</Badge>
                        <Link
                          href={`/course/${request.class_id}/assignments/${referencedSubmission.data[0].assignment_id}/submissions/${referencedSubmission.data[0].id}`}
                        >
                          <Text fontSize="sm" color="fg.muted" _hover={{ textDecoration: "underline" }}>
                            Run #{referencedSubmission.data[0].run_number} •{" "}
                            {new Date(referencedSubmission.data[0].created_at).toLocaleDateString()}
                          </Text>
                        </Link>
                      </HStack>
                    </Box>
                  )}

                  {referencedFiles?.data && referencedFiles.data.length > 0 && (
                    <Box>
                      <Text fontSize="sm" fontWeight="medium" mb={2}>
                        Files:
                      </Text>
                      <Stack spaceY={2}>
                        {referencedFiles.data.map((file) => {
                          const fileRef = currentFileReferences?.find((ref) => ref.submission_file_id === file.id);
                          return (
                            <HStack key={fileRef?.id}>
                              <Icon as={BsFileEarmark} color="fg.muted" />
                              <Link
                                href={`/course/${request.class_id}/assignments/${fileRef?.assignment_id}/submissions/${fileRef?.submission_id}/files?file_id=${fileRef?.submission_file_id}${fileRef?.line_number ? `#L${fileRef.line_number}` : ""}`}
                                key={fileRef?.id}
                              >
                                <Text fontSize="sm" _hover={{ textDecoration: "underline" }}>
                                  {file.name}
                                </Text>
                              </Link>
                              {fileRef?.line_number && (
                                <Badge size="sm" variant="outline">
                                  Line {fileRef.line_number}
                                </Badge>
                              )}
                            </HStack>
                          );
                        })}
                      </Stack>
                    </Box>
                  )}
                </Box>
              )}
            </Stack>
          </Accordion.ItemBody>
        </Accordion.ItemContent>
      </Accordion.Item>
    </Accordion.Root>
  );
};

/**
 * Component to display and manage students associated with a help request
 * Shows avatars and names in a compact, clean format
 */
const HelpRequestStudents = ({
  request,
  students,
  currentUserCanEdit,
  currentAssociations
}: {
  request: HelpRequest;
  students: UserProfile[];
  currentUserCanEdit: boolean;
  currentAssociations: HelpRequestStudent[];
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const { course_id } = useParams();

  const isInstructorOrGrader = useIsGraderOrInstructor();

  // Get student associations for activity logging
  const allHelpRequestStudents = useHelpRequestStudents();
  const helpRequestStudentData = allHelpRequestStudents.filter((student) => student.help_request_id === request.id);

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequestStudents, studentHelpActivity } = controller;

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      const requestStudents = helpRequestStudentData;

      for (const student of requestStudents) {
        try {
          await studentHelpActivity.create({
            student_profile_id: student.profile_id,
            class_id: request.class_id,
            help_request_id: request.id,
            activity_type: activityType,
            activity_description: description
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [request.id, request.class_id, studentHelpActivity, helpRequestStudentData]
  );

  // Initialize selected students when editing mode is entered
  const handleEditClick = () => {
    setSelectedStudents(students.map((student) => student.id));
    setIsEditing(true);
  };

  const handleSaveChanges = async () => {
    try {
      const originalStudentIds = students.map((student) => student.id);
      const studentsToAdd = selectedStudents.filter((id) => !originalStudentIds.includes(id));
      const studentsToRemove = originalStudentIds.filter((id) => !selectedStudents.includes(id));

      if (studentsToRemove.length > 0 && currentAssociations.length > 0) {
        const associationsToDelete = currentAssociations.filter((association) =>
          studentsToRemove.includes(association.profile_id)
        );
        for (const association of associationsToDelete) {
          await helpRequestStudents.delete(association.id!);
        }
      }

      if (studentsToAdd.length > 0) {
        for (const studentId of studentsToAdd) {
          await helpRequestStudents.create({
            help_request_id: request.id,
            profile_id: studentId,
            class_id: request.class_id
          });
        }
      }

      setIsEditing(false);
      toaster.success({
        title: "Students updated",
        description: "The student list has been successfully updated."
      });
      await logActivityForAllStudents("request_updated", "Student list updated");
    } catch (error) {
      toaster.error({
        title: "Failed to update students",
        description: "There was an error updating the student list: " + (error as Error).message
      });
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setSelectedStudents([]);
  };

  if (isEditing) {
    return (
      <Box w="100%">
        <Stack gap={2}>
          <StudentGroupPicker
            selectedStudents={selectedStudents}
            onSelectionChange={setSelectedStudents}
            placeholder="Search and select students..."
            invalid={selectedStudents.length === 0}
            errorMessage={selectedStudents.length === 0 ? "At least one student must be selected" : undefined}
            minSelections={1}
            helperText="At least one student must remain associated with this help request."
          />
          <HStack gap={2} justify="flex-end">
            <Button size="xs" variant="ghost" onClick={handleCancelEdit}>
              Cancel
            </Button>
            <Button size="xs" colorPalette="blue" onClick={handleSaveChanges} disabled={selectedStudents.length === 0}>
              Save
            </Button>
          </HStack>
        </Stack>
      </Box>
    );
  }

  return (
    <HStack gap={2} flexWrap="wrap" align="center">
      {students.map((student) => (
        <HStack key={student.id} gap={1}>
          <PersonAvatar uid={student.id} size="2xs" />
          <Text fontSize="sm">{student.name}</Text>
          {isInstructorOrGrader && (
            <StudentSummaryTrigger student_id={student.id} course_id={parseInt(course_id as string, 10)} />
          )}
        </HStack>
      ))}
      {currentUserCanEdit && request.status !== "resolved" && request.status !== "closed" && (
        <Tooltip content="Edit students" showArrow>
          <IconButton aria-label="Edit student list" size="xs" variant="ghost" onClick={handleEditClick}>
            <Icon as={BsPencil} boxSize={3} />
          </IconButton>
        </Tooltip>
      )}
    </HStack>
  );
};

/**
 * HelpRequestChat component with integrated control buttons for instructors/graders
 * @param request - The help request object
 * @returns JSX element for the chat interface with controls
 */
export default function HelpRequestChat({ request_id }: { request_id: number }) {
  const request = useHelpRequest(request_id);
  const { private_profile_id, role } = useClassProfiles();
  const profiles = useAllProfilesForClass();
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const readOnly = request?.status === "resolved" || request?.status === "closed";

  // Check if we're in popout mode
  const isPopOut = searchParams.get("popout") === "true";

  // Get data using individual hooks
  const allHelpRequestStudents = useHelpRequestStudents();
  const helpRequestStudentData = useMemo(
    () => allHelpRequestStudents.filter((student) => student.help_request_id === request?.id),
    [allHelpRequestStudents, request?.id]
  );

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { studentHelpActivity, helpRequests } = controller;

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      // Get all student associations for this help request
      const requestStudents = helpRequestStudentData;

      for (const student of requestStudents) {
        try {
          await studentHelpActivity.create({
            student_profile_id: student.profile_id,
            class_id: Number(params.course_id),
            help_request_id: request_id,
            activity_type: activityType,
            activity_description: description
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [params.course_id, request_id, studentHelpActivity, helpRequestStudentData]
  );

  // Note: helpRequestMessages and helpRequestStudentData are already defined above

  // Get all feedback data to check if this request has feedback
  const allFeedback = useHelpRequestFeedback();

  // Check if this specific help request has feedback from the currently-logged in student
  const hasExistingFeedback = useMemo(() => {
    return allFeedback.some(
      (feedback) => feedback.help_request_id === request_id && feedback.student_profile_id === private_profile_id
    );
  }, [allFeedback, request_id, private_profile_id]);

  // Get student profiles for display - memoized to prevent unnecessary recalculations
  const { studentIds, students } = useMemo(() => {
    const studentIds = helpRequestStudentData.map((student) => student.profile_id);
    const students = profiles.filter((user: UserProfile) => studentIds.includes(user.id));
    return { studentIds, students };
  }, [helpRequestStudentData, profiles]);

  // Check if current user is instructor or grader (not a student)
  const isInstructorOrGrader = useIsGraderOrInstructor();

  /**
   * Handle back navigation based on context
   * - Management context: go back to help request list
   * - Student context: go back to help queue page
   */
  const handleBackNavigation = useCallback(() => {
    const courseId = params.course_id;

    // Check if we're in the TA/Instructor context
    if (pathname.includes("/manage/office-hours/request/")) {
      router.push(`/course/${courseId}/manage/office-hours`);
    } else {
      // We're in the student context, so just hide the back button
      return;
    }
  }, [router, params, pathname]);

  // Check if current user can access video controls (join/start video calls)
  const canAccessVideoControls = useMemo(() => {
    return (
      request &&
      (isInstructorOrGrader ||
        (!request.is_private && role.role === "student") ||
        (request.is_private && studentIds.includes(private_profile_id!)))
    );
  }, [isInstructorOrGrader, request, role.role, studentIds, private_profile_id]);

  // Check if current user can access request management controls (resolve/close)
  const canAccessRequestControls = useMemo(() => {
    return isInstructorOrGrader || studentIds.includes(private_profile_id!);
  }, [isInstructorOrGrader, studentIds, private_profile_id]);

  // Modal management for moderation, karma, and feedback actions
  const moderationModal = useModalManager();
  const karmaModal = useModalManager();
  const feedbackModal = useModalManager<{ action: "resolve" | "close" }>();

  // Generate title based on number of students - memoized to prevent recalculation
  const requestTitle = useMemo(() => {
    if (students.length === 0) {
      return "Help Request"; // Fallback if no students found
    } else if (students.length === 1) {
      return `${students[0].name}'s Help Request`;
    } else if (students.length === 2) {
      return `${students[0].name} & ${students[1].name}'s Help Request`;
    } else {
      return `${students[0].name} + ${students.length - 1} others' Help Request`;
    }
  }, [students]);

  // Modal success handlers
  const handleModerationSuccess = useCallback(() => {
    moderationModal.closeModal();
    toaster.success({
      title: "Moderation action created",
      description: "The moderation action has been successfully created."
    });
  }, [moderationModal]);

  const handleKarmaSuccess = useCallback(() => {
    karmaModal.closeModal();
    toaster.success({
      title: "Karma entry created",
      description: "The karma entry has been successfully created."
    });
  }, [karmaModal]);

  /**
   * Handle feedback submission and complete the resolve/close action
   */
  const handleFeedbackSuccess = useCallback(async () => {
    const action = feedbackModal.modalData?.action;
    if (!action || !request) return;

    try {
      // Only update request status if it's not already resolved/closed
      if (request.status !== "resolved" && request.status !== "closed") {
        if (action === "resolve") {
          await helpRequests.update(request.id, {
            resolved_by: private_profile_id,
            resolved_at: new Date().toISOString(),
            status: "resolved"
          });
          await logActivityForAllStudents("request_resolved", "Request resolved by student");
        } else if (action === "close") {
          await helpRequests.update(request.id, {
            status: "closed"
          });
          await logActivityForAllStudents("request_updated", "Request closed by student");
        }
      }

      feedbackModal.closeModal();
    } catch (error) {
      toaster.error({
        title: "Action Failed",
        description: `Failed to ${action} the request: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }, [feedbackModal, helpRequests, request, private_profile_id, logActivityForAllStudents]);

  const resolveRequest = useCallback(async () => {
    // For students, show feedback modal first
    if (role.role === "student") {
      feedbackModal.openModal({ action: "resolve" });
      return;
    }

    // For instructors/graders, resolve directly
    await helpRequests.update(request_id, {
      resolved_by: private_profile_id,
      resolved_at: new Date().toISOString(),
      status: "resolved"
    });
    await logActivityForAllStudents("request_resolved", "Request resolved by instructor");
  }, [helpRequests, request_id, private_profile_id, logActivityForAllStudents, role.role, feedbackModal]);

  /**
   * Open feedback modal for closed/resolved requests without existing feedback from the currently-logged in student
   */
  const provideFeedback = useCallback(() => {
    feedbackModal.openModal({ action: "resolve" }); // Use resolve action as default
  }, [feedbackModal]);

  /**
   * Pop out the chat into a separate window
   */
  const popOutChat = useCallback(() => {
    const courseId = params.course_id;
    const requestId = request_id;

    // Construct the URL for the popped out chat
    const popOutUrl = `/course/${courseId}/office-hours/request/${requestId}?popout=true`;

    // Open a new window with chat-appropriate dimensions
    const newWindow = window.open(
      popOutUrl,
      `help-request-chat-${requestId}`,
      "width=800,height=600,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no"
    );

    if (newWindow) {
      newWindow.focus();

      // Set a meaningful title for the popped-out window once it loads
      newWindow.addEventListener("load", () => {
        const windowTitle = `Help Request #${requestId} - ${requestTitle}`;
        newWindow.document.title = windowTitle;
      });
    } else {
      toaster.error({
        title: "Pop-out blocked",
        description: "Please allow pop-ups for this site to use the pop-out feature."
      });
    }
  }, [params.course_id, request_id, requestTitle]);

  // Format creation time
  const createdTimeAgo = useMemo(() => {
    if (!request?.created_at) return "";
    return formatDistanceToNow(new Date(request.created_at), { addSuffix: true });
  }, [request?.created_at]);

  return (
    <Flex
      direction="column"
      width="100%"
      maxW={{ base: "md", md: "full" }}
      mx="auto"
      height={isPopOut ? "100vh" : "calc(100vh - var(--nav-height))"}
    >
      {/* Header Section */}
      <Box
        width="100%"
        borderBottomWidth="1px"
        borderColor="border.subtle"
        bg="bg.subtle"
        px={{ base: 3, md: 4 }}
        py={3}
      >
        {/* Top Row: Back button, Title, Status, Actions */}
        <Flex justify="space-between" align="center" mb={2}>
          <HStack gap={2}>
            {/* Back Button - Hide in popout mode */}
            {!isPopOut && pathname.includes("/manage/office-hours/request/") && (
              <IconButton aria-label="Go back" variant="ghost" onClick={handleBackNavigation} size="sm">
                <Icon as={BsArrowLeft} />
              </IconButton>
            )}

            {/* Title */}
            <Text fontWeight="semibold" fontSize="lg">
              {requestTitle}
            </Text>

            {/* Status Badge */}
            {request && <HelpRequestStatusBadge status={request.status} />}

            {/* Privacy Badge */}
            {request?.is_private && (
              <Badge colorPalette="purple" size="sm" variant="outline">
                Private
              </Badge>
            )}
          </HStack>

          {/* Primary Actions */}
          <HStack gap={2}>
            {/* Start Helping Button - Prominent for unassigned requests (Staff only) */}
            {isInstructorOrGrader &&
              !readOnly &&
              request &&
              !request.assignee &&
              (request.status === "open" || request.status === "in_progress") && (
                <HelpRequestAssignment request={request} />
              )}

            {/* Resolve Button */}
            {!readOnly &&
              canAccessRequestControls &&
              request &&
              request.status !== "resolved" &&
              request.status !== "closed" && (
                <PopConfirm
                  triggerLabel="Resolve Request"
                  trigger={
                    <Button size="sm" colorPalette="blue" variant="outline">
                      <Icon as={BsCheck} />
                      Resolve
                    </Button>
                  }
                  confirmHeader="Resolve Request"
                  confirmText="Are you sure you want to resolve this request?"
                  onConfirm={resolveRequest}
                />
              )}

            {/* Provide Feedback Button for resolved requests */}
            {readOnly && !hasExistingFeedback && canAccessRequestControls && !isInstructorOrGrader && (
              <Button size="sm" colorPalette="blue" onClick={provideFeedback}>
                <Icon as={BsStar} />
                Provide Feedback
              </Button>
            )}
          </HStack>
        </Flex>

        {/* Metadata Row */}
        <Flex
          direction={{ base: "column", md: "row" }}
          gap={{ base: 2, md: 4 }}
          align={{ base: "stretch", md: "center" }}
          justify="space-between"
        >
          {/* Left Side: Metadata */}
          <HStack gap={4} flexWrap="wrap" fontSize="sm" color="fg.muted">
            {/* Students */}
            {request && (
              <HStack gap={1}>
                <Icon as={BsPeople} />
                <HelpRequestStudents
                  request={request}
                  students={students}
                  currentUserCanEdit={!readOnly && canAccessRequestControls}
                  currentAssociations={helpRequestStudentData}
                />
              </HStack>
            )}

            {/* Created Time */}
            {request && (
              <HStack gap={1}>
                <Icon as={BsClock} />
                <Text fontSize="sm">{createdTimeAgo}</Text>
              </HStack>
            )}

            {/* Assignment (Staff only) */}
            {isInstructorOrGrader && request && (
              <HStack gap={1}>
                <Icon as={BsPersonCheck} />
                <HelpRequestAssignment request={request} compact />
              </HStack>
            )}
          </HStack>

          {/* Right Side: Secondary Actions Toolbar */}
          <HStack gap={1} flexWrap="wrap">
            {/* Pop Out Button */}
            {!isPopOut && (
              <Tooltip content="Pop out chat" showArrow>
                <IconButton aria-label="Pop out chat" size="xs" variant="ghost" onClick={popOutChat}>
                  <Icon as={BsBoxArrowUpRight} boxSize={3} />
                </IconButton>
              </Tooltip>
            )}

            {/* Watch Button */}
            <HelpRequestWatchButton helpRequestId={request_id} variant="ghost" size="xs" />

            {/* Discord Link (Staff only) */}
            {isInstructorOrGrader && request && (
              <DiscordMessageLink resourceType="help_request" resourceId={request.id} size="sm" variant="ghost" />
            )}

            {/* Video Call Controls */}
            {!readOnly && canAccessVideoControls && request && (
              <VideoCallControls request={request} canStartCall={isInstructorOrGrader} size="sm" variant="full" />
            )}

            {/* Staff Actions Separator */}
            {isInstructorOrGrader && !readOnly && request && (
              <>
                <Separator orientation="vertical" height="20px" />

                {/* Assignment status (only when already assigned) */}
                {request.assignee && <HelpRequestAssignment request={request} />}

                {/* Moderation */}
                <Tooltip content="Moderation" showArrow>
                  <IconButton
                    aria-label="Moderation"
                    size="xs"
                    variant="ghost"
                    colorPalette="orange"
                    onClick={() => moderationModal.openModal()}
                  >
                    <Icon as={BsShield} boxSize={3} />
                  </IconButton>
                </Tooltip>

                {/* Karma */}
                <Tooltip content="Karma" showArrow>
                  <IconButton
                    aria-label="Karma"
                    size="xs"
                    variant="ghost"
                    colorPalette="yellow"
                    onClick={() => karmaModal.openModal()}
                  >
                    <Icon as={BsStar} boxSize={3} />
                  </IconButton>
                </Tooltip>
              </>
            )}
          </HStack>
        </Flex>

        {/* Code References Section (collapsible) */}
        {request && (
          <Box mt={2}>
            <HelpRequestFileReferences request={request} canEdit={!readOnly && canAccessRequestControls} />
          </Box>
        )}
      </Box>

      {/* Chat Section */}
      <Flex flex="1" width="100%" overflow="auto" justify="center" align="stretch">
        <RealtimeChat request_id={request_id} helpRequestStudentIds={studentIds} readOnly={readOnly} />
      </Flex>

      {/* Modals */}
      {isInstructorOrGrader && (
        <>
          <CreateModerationActionModal
            isOpen={moderationModal.isOpen}
            onClose={moderationModal.closeModal}
            onSuccess={handleModerationSuccess}
          />
          <CreateKarmaEntryModal
            isOpen={karmaModal.isOpen}
            onClose={karmaModal.closeModal}
            onSuccess={handleKarmaSuccess}
          />
        </>
      )}

      {role.role === "student" && (
        <HelpRequestFeedbackModal
          isOpen={feedbackModal.isOpen}
          onClose={feedbackModal.closeModal}
          onSuccess={handleFeedbackSuccess}
          helpRequestId={request_id}
          classId={Number(params.course_id)}
          studentProfileId={private_profile_id!}
        />
      )}
    </Flex>
  );
}
