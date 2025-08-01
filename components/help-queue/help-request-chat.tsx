"use client";
import { useCallback, useState, useMemo } from "react";
import type {
  HelpRequest,
  Assignment,
  Submission,
  SubmissionFile,
  HelpRequestFormFileReference
} from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, Icon, IconButton, Card, Badge, Input } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  BsCheck,
  BsClipboardCheckFill,
  BsClipboardCheck,
  BsXCircle,
  BsFileEarmark,
  BsCode,
  BsShield,
  BsStar,
  BsPeople,
  BsPencil,
  BsArrowLeft,
  BsBoxArrowUpRight,
  BsTrash
} from "react-icons/bs";
import { useRouter, useParams, usePathname, useSearchParams } from "next/navigation";

import { useUpdate, useList, useCreate, useDelete } from "@refinedev/core";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { toaster } from "@/components/ui/toaster";
import { RealtimeChat } from "@/components/realtime-chat";
import PersonAvatar from "@/components/ui/person-avatar";
import VideoCallControls from "./video-call-controls";
import useModalManager from "@/hooks/useModalManager";
import CreateModerationActionModal from "@/app/course/[course_id]/manage/office-hours/modals/createModerationActionModal";
import CreateKarmaEntryModal from "@/app/course/[course_id]/manage/office-hours/modals/createKarmaEntryModal";
import HelpRequestFeedbackModal from "./help-request-feedback-modal";
import { Select } from "chakra-react-select";

import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import StudentGroupPicker from "@/components/ui/student-group-picker";
import Link from "next/link";
import { useOfficeHoursRealtime, useHelpRequestFeedback } from "@/hooks/useOfficeHoursRealtime";
import { HelpRequestWatchButton } from "./help-request-watch-button";

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
 * Component for managing help request assignment status and actions
 * @param request - The help request object
 * @returns JSX element for assignment controls
 */
const HelpRequestAssignment = ({ request }: { request: HelpRequest }) => {
  const { private_profile_id } = useClassProfiles();

  // Get student data from realtime
  const { data: realtimeData } = useOfficeHoursRealtime({
    classId: request.class_id,
    helpRequestId: request.id,
    enableChat: false
  });

  const { mutateAsync: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    id: request.id,
    mutationOptions: {
      onSuccess: () => {
        toaster.success({
          title: "Help request successfully updated",
          description: `Help request ${request.id} updated`
        });
      }
    }
  });

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      // Get all student associations for this help request from realtime data
      const requestStudents = realtimeData.helpRequestStudents.filter(
        (student) => student.help_request_id === request.id
      );

      for (const student of requestStudents) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: student.profile_id,
              class_id: request.class_id,
              help_request_id: request.id,
              activity_type: activityType,
              activity_description: description
            }
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [request.id, request.class_id, createStudentActivity, realtimeData.helpRequestStudents]
  );

  // Disable assignment actions for resolved/closed requests
  const isRequestInactive = request.status === "resolved" || request.status === "closed";
  const canShowActions = request.status === "open" || request.status === "in_progress";

  if (request.assignee === private_profile_id) {
    return (
      <HStack gap={2}>
        <Badge colorPalette="green" fontSize="xs">
          Assigned to you
        </Badge>
        {canShowActions && (
          <Tooltip content="Drop assignment and return to queue" showArrow disabled={isRequestInactive}>
            <IconButton
              aria-label="Drop Assignment"
              size="sm"
              colorPalette="red"
              disabled={isRequestInactive}
              onClick={async () => {
                await updateRequest({ id: request.id, values: { assignee: null, status: "open" } });
                await logActivityForAllStudents("request_updated", "Request assignment dropped and returned to queue");
              }}
            >
              <Icon as={BsClipboardCheckFill} />
            </IconButton>
          </Tooltip>
        )}
      </HStack>
    );
  } else if (request.assignee) {
    return (
      <Badge colorPalette="blue" fontSize="xs">
        Assigned to {request.assignee}
      </Badge>
    );
  } else {
    return (
      <HStack gap={2}>
        <Badge colorPalette="gray" variant="outline" fontSize="xs">
          Not assigned
        </Badge>
        {canShowActions && (
          <Tooltip content="Take assignment and mark as in progress" showArrow disabled={isRequestInactive}>
            <IconButton
              aria-label="Assume Assignment"
              variant="ghost"
              size="sm"
              colorPalette="green"
              disabled={isRequestInactive}
              onClick={async () => {
                await updateRequest({
                  id: request.id,
                  values: { assignee: private_profile_id, status: "in_progress" }
                });
                await logActivityForAllStudents("request_updated", "Request assigned and marked as in progress");
              }}
            >
              <Icon as={BsClipboardCheck} />
            </IconButton>
          </Tooltip>
        )}
      </HStack>
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

  const { data: realtimeData } = useOfficeHoursRealtime({
    classId: request.class_id,
    helpRequestId: request.id,
    enableChat: false
  });

  // Fetch referenced submission if any
  const { data: referencedSubmission, refetch: refetchSubmission } = useList<Submission>({
    resource: "submissions",
    filters: [{ field: "id", operator: "eq", value: request.referenced_submission_id }],
    queryOptions: {
      enabled: !!request.referenced_submission_id
    }
  });

  // Fetch the actual files referenced to get their name
  const fileReferenceIds = realtimeData.helpRequestFileReferences?.map((ref) => ref.submission_file_id) || [];
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

  // Refine hooks for CRUD operations
  const { mutateAsync: createFileReference } = useCreate({
    resource: "help_request_file_references"
  });

  const { mutateAsync: updateFileReference } = useUpdate({
    resource: "help_request_file_references"
  });

  const { mutateAsync: deleteFileReference } = useDelete();

  const { mutateAsync: updateHelpRequest } = useUpdate({
    resource: "help_requests"
  });

  const hasReferences = !!request.referenced_submission_id || (realtimeData.helpRequestFileReferences?.length ?? 0) > 0;

  /**
   * Initialize editing mode with current file references and submission
   */
  const handleEditClick = useCallback(() => {
    if (!realtimeData.helpRequestFileReferences) return;

    // Convert database references to form format
    const formReferences: EditingFileReference[] = realtimeData.helpRequestFileReferences.map((ref) => ({
      id: ref.id, // Include ID for existing references
      submission_file_id: ref.submission_file_id!,
      line_number: ref.line_number || undefined
    }));

    setEditingReferences(formReferences);
    setEditingSubmissionId(request.referenced_submission_id);
    setIsEditing(true);
  }, [realtimeData.helpRequestFileReferences, request.referenced_submission_id]);

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
      const currentRefs = realtimeData.helpRequestFileReferences || [];
      const newRefs = editingReferences;

      // Determine which references to create, update, and delete
      const refsToCreate = newRefs.filter((ref) => !ref.id);
      const refsToUpdate = newRefs.filter((ref) => ref.id);
      const refsToDelete = currentRefs.filter((current) => !newRefs.some((newRef) => newRef.id === current.id));

      // Delete removed references
      for (const ref of refsToDelete) {
        await deleteFileReference({
          id: ref.id,
          resource: "help_request_file_references"
        });
      }

      // Update existing references
      for (const ref of refsToUpdate) {
        if (ref.id) {
          await updateFileReference({
            id: ref.id,
            values: {
              line_number: ref.line_number
            }
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
          await createFileReference({
            values: {
              help_request_id: request.id,
              class_id: request.class_id,
              assignment_id: selectedSubmission.assignment_id,
              submission_file_id: ref.submission_file_id,
              submission_id: editingSubmissionId,
              line_number: ref.line_number
            }
          });
        }
      }

      // Update help request with new submission reference and privacy
      const hasFileReferences = newRefs.length > 0;
      const hasSubmissionReference = editingSubmissionId !== null;
      const shouldBePrivate = hasFileReferences || hasSubmissionReference;

      await updateHelpRequest({
        id: request.id,
        values: {
          referenced_submission_id: editingSubmissionId,
          is_private: shouldBePrivate
        }
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
    realtimeData.helpRequestFileReferences,
    editingReferences,
    editingSubmissionId,
    userSubmissions,
    createFileReference,
    updateFileReference,
    deleteFileReference,
    updateHelpRequest,
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
    <Card.Root variant="outline" m={4}>
      <Card.Header>
        <HStack justify="space-between">
          <HStack>
            <Icon as={BsCode} />
            <Text fontWeight="medium">Referenced Code</Text>
          </HStack>
          {canEdit && request.status !== "resolved" && request.status !== "closed" && !isEditing && (
            <Tooltip content="Edit code references" showArrow>
              <IconButton aria-label="Edit code references" size="sm" variant="ghost" onClick={handleEditClick}>
                <Icon as={BsPencil} />
              </IconButton>
            </Tooltip>
          )}
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack spaceY={3}>
          {isEditing ? (
            /* Edit Mode */
            <Box>
              {/* Submission Selection */}
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

              {/* File References */}
              {editingSubmissionId && (
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={2}>
                    Specific Files (Optional):
                  </Text>

                  {/* Current file references being edited */}
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

                  {/* Add new file reference */}
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

              {/* Edit actions */}
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
            /* Display Mode */
            <Box>
              {/* Referenced Submission */}
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

              {/* Referenced Files */}
              {referencedFiles?.data && referencedFiles.data.length > 0 && (
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={2}>
                    Files:
                  </Text>
                  <Stack spaceY={2}>
                    {referencedFiles.data.map((file) => {
                      const fileRef = realtimeData.helpRequestFileReferences?.find(
                        (ref) => ref.submission_file_id === file.id
                      );
                      return (
                        <HStack key={fileRef?.id}>
                          <Icon as={BsFileEarmark} color="fg.muted" />
                          <Link
                            href={`/course/${request.class_id}/assignments/${fileRef?.assignment_id}/submissions/${fileRef?.submission_id}/files?file_id=${fileRef?.submission_file_id}#L${fileRef?.line_number}`}
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
      </Card.Body>
    </Card.Root>
  );
};

/**
 * Component to display and manage students associated with a help request
 * @param request - The help request object
 * @param students - Array of student profiles associated with the request
 * @param currentUserCanEdit - Whether the current user can edit the student list
 * @returns JSX element for student management
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

  // Get realtime data for activity logging
  const { data: realtimeData } = useOfficeHoursRealtime({
    classId: request.class_id,
    helpRequestId: request.id,
    enableChat: false
  });

  // Refinedev hooks for student association management
  const { mutateAsync: createStudentAssociation } = useCreate();
  const { mutateAsync: deleteStudentAssociation } = useDelete();

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      // Get all student associations for this help request from realtime data
      const requestStudents = realtimeData.helpRequestStudents.filter(
        (student) => student.help_request_id === request.id
      );

      for (const student of requestStudents) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: student.profile_id,
              class_id: request.class_id,
              help_request_id: request.id,
              activity_type: activityType,
              activity_description: description
            }
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [request.id, request.class_id, createStudentActivity, realtimeData.helpRequestStudents]
  );

  // Initialize selected students when editing mode is entered
  const handleEditClick = () => {
    setSelectedStudents(students.map((student) => student.id));
    setIsEditing(true);
  };

  const handleSaveChanges = async () => {
    try {
      const originalStudentIds = students.map((student) => student.id);

      // Calculate which students to add (in new selection but not in original)
      const studentsToAdd = selectedStudents.filter((id) => !originalStudentIds.includes(id));

      // Calculate which students to remove (in original but not in new selection)
      const studentsToRemove = originalStudentIds.filter((id) => !selectedStudents.includes(id));

      // Remove students that are no longer selected
      if (studentsToRemove.length > 0 && currentAssociations.length > 0) {
        // Find the association records to delete
        const associationsToDelete = currentAssociations.filter((association) =>
          studentsToRemove.includes(association.profile_id)
        );

        // Delete each association
        for (const association of associationsToDelete) {
          await deleteStudentAssociation({
            resource: "help_request_students",
            id: association.id!
          });
        }
      }

      // Add new students
      if (studentsToAdd.length > 0) {
        for (const studentId of studentsToAdd) {
          await createStudentAssociation({
            resource: "help_request_students",
            values: {
              help_request_id: request.id,
              profile_id: studentId,
              class_id: request.class_id
            }
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
      <Box>
        <HStack justify="space-between" align="start">
          <Box flex="1">
            <StudentGroupPicker
              selectedStudents={selectedStudents}
              onSelectionChange={setSelectedStudents}
              placeholder="Search and select students..."
              invalid={selectedStudents.length === 0}
              errorMessage={selectedStudents.length === 0 ? "At least one student must be selected" : undefined}
              minSelections={1}
              helperText="At least one student must remain associated with this help request."
            />
          </Box>
          <HStack>
            <Button size="sm" onClick={handleCancelEdit}>
              Cancel
            </Button>
            <Button size="sm" colorPalette="blue" onClick={handleSaveChanges} disabled={selectedStudents.length === 0}>
              Save
            </Button>
          </HStack>
        </HStack>
      </Box>
    );
  }

  return (
    <Box>
      <HStack justify="space-between" align="center">
        <HStack>
          <Icon as={BsPeople} />
          <Text fontSize="sm" fontWeight="medium">
            Students ({students.length}):
          </Text>
          <HStack>
            {students.map((student, index) => (
              <Text key={student.id} fontSize="sm">
                {student.name}
                {index < students.length - 1 && ","}
              </Text>
            ))}
          </HStack>
        </HStack>
        {currentUserCanEdit && request.status !== "resolved" && request.status !== "closed" && (
          <IconButton aria-label="Edit student list" size="sm" variant="ghost" onClick={handleEditClick}>
            <Icon as={BsPencil} />
          </IconButton>
        )}
      </HStack>
    </Box>
  );
};

/**
 * HelpRequestChat component with integrated control buttons for instructors/graders
 * @param request - The help request object
 * @returns JSX element for the chat interface with controls
 */
export default function HelpRequestChat({ request }: { request: HelpRequest }) {
  const { private_profile_id, role, profiles } = useClassProfiles();
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const readOnly = request.status === "resolved" || request.status === "closed";

  // Check if we're in popout mode
  const isPopOut = searchParams.get("popout") === "true";

  // Use main realtime hook instead of individual hooks
  const { data: realtimeData } = useOfficeHoursRealtime({
    classId: request.class_id,
    helpRequestId: request.id,
    enableChat: true,
    enableStaffData: role.role === "instructor" || role.role === "grader"
  });

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Helper function to log activity for all students in the request
  const logActivityForAllStudents = useCallback(
    async (activityType: "request_updated" | "request_resolved", description: string) => {
      // Get all student associations for this help request from realtime data
      const requestStudents = realtimeData.helpRequestStudents.filter(
        (student) => student.help_request_id === request.id
      );

      for (const student of requestStudents) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: student.profile_id,
              class_id: request.class_id,
              help_request_id: request.id,
              activity_type: activityType,
              activity_description: description
            }
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [request.id, request.class_id, createStudentActivity, realtimeData.helpRequestStudents]
  );

  // Extract data from realtime hook
  const helpRequestMessages = realtimeData.helpRequestMessages;
  const helpRequestStudentData = realtimeData.helpRequestStudents;

  // Get all feedback data to check if this request has feedback
  const allFeedback = useHelpRequestFeedback();

  // Check if this specific help request has feedback from the currently-logged in student
  const hasExistingFeedback = useMemo(() => {
    return allFeedback.some(
      (feedback) => feedback.help_request_id === request.id && feedback.student_profile_id === private_profile_id
    );
  }, [allFeedback, request.id, private_profile_id]);

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
      isInstructorOrGrader ||
      (!request.is_private && role.role === "student") ||
      (request.is_private && studentIds.includes(private_profile_id!))
    );
  }, [isInstructorOrGrader, request.is_private, role.role, studentIds, private_profile_id]);

  // Check if current user can access request management controls (resolve/close)
  const canAccessRequestControls = useMemo(() => {
    return isInstructorOrGrader || studentIds.includes(private_profile_id!);
  }, [isInstructorOrGrader, studentIds, private_profile_id]);

  // Modal management for moderation, karma, and feedback actions
  const moderationModal = useModalManager();
  const karmaModal = useModalManager();
  const feedbackModal = useModalManager<{ action: "resolve" | "close" }>();

  const { mutate } = useUpdate({ resource: "help_requests", id: request.id });

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

  // Generate unique participant IDs for avatars
  const participantIds = useMemo(() => {
    return Array.from(
      new Set([
        ...studentIds, // Include all students in the request
        ...helpRequestMessages.map((msg) => msg.author)
      ])
    ).slice(0, 5);
  }, [studentIds, helpRequestMessages]);

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
    if (!action) return;

    try {
      // Only update request status if it's not already resolved/closed
      if (request.status !== "resolved" && request.status !== "closed") {
        if (action === "resolve") {
          await mutate({
            id: request.id,
            values: {
              resolved_by: private_profile_id,
              resolved_at: new Date().toISOString(),
              status: "resolved"
            }
          });
          await logActivityForAllStudents("request_resolved", "Request resolved by student");
        } else if (action === "close") {
          await mutate({
            id: request.id,
            values: {
              status: "closed"
            }
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
  }, [feedbackModal, mutate, request.id, private_profile_id, logActivityForAllStudents, request.status]);

  const resolveRequest = useCallback(async () => {
    // For students, show feedback modal first
    if (role.role === "student") {
      feedbackModal.openModal({ action: "resolve" });
      return;
    }

    // For instructors/graders, resolve directly
    await mutate({
      id: request.id,
      values: {
        resolved_by: private_profile_id,
        resolved_at: new Date().toISOString(),
        status: "resolved"
      }
    });
    await logActivityForAllStudents("request_resolved", "Request resolved by instructor");
  }, [mutate, request.id, private_profile_id, logActivityForAllStudents, role.role, feedbackModal]);

  const closeRequest = useCallback(async () => {
    // For students, show feedback modal first
    if (role.role === "student") {
      feedbackModal.openModal({ action: "close" });
      return;
    }

    // For instructors/graders, close directly
    await mutate({
      id: request.id,
      values: {
        status: "closed"
      }
    });
    await logActivityForAllStudents("request_updated", "Request closed by instructor");
  }, [mutate, request.id, logActivityForAllStudents, role.role, feedbackModal]);

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
    const requestId = request.id;

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
  }, [params.course_id, request.id, requestTitle]);

  return (
    <Flex
      direction="column"
      width="100%"
      height={isPopOut ? "100vh" : "calc(100vh - var(--nav-height))"}
      justify="space-between"
      align="center"
    >
      <Flex width="100%" px="4" py="4">
        <HStack spaceX="4" flex="1">
          {/* Back Button - Hide in popout mode */}
          {!isPopOut && pathname.includes("/manage/office-hours/request/") && (
            <IconButton aria-label="Go back" variant="ghost" onClick={handleBackNavigation} size="sm">
              <Icon as={BsArrowLeft} />
            </IconButton>
          )}

          <Stack spaceY="2">
            <Text fontWeight="medium">{requestTitle}</Text>
            {/* Students Management */}
            <HelpRequestStudents
              request={request}
              students={students}
              currentUserCanEdit={!readOnly && canAccessRequestControls}
              currentAssociations={helpRequestStudentData}
            />
          </Stack>

          {/* Control Buttons */}
          <HStack gap={2}>
            {/* Pop Out Button - Available to all users, hide if already popped out */}
            {!isPopOut && (
              <Tooltip content="Pop out chat to new window" showArrow>
                <IconButton aria-label="Pop out chat" size="sm" variant="ghost" onClick={popOutChat}>
                  <Icon as={BsBoxArrowUpRight} />
                </IconButton>
              </Tooltip>
            )}

            {/* Help Request Watch Button - Available to all users */}
            <HelpRequestWatchButton helpRequestId={request.id} variant="ghost" size="sm" />

            {/* Video Call Controls - Available to all users with video access (disabled in read-only mode) */}
            {!readOnly && canAccessVideoControls && (
              <VideoCallControls request={request} canStartCall={isInstructorOrGrader} size="sm" variant="full" />
            )}

            {/* Request Management Controls - Available to Instructors/Graders and Students Associated with Request (disabled in read-only mode) */}
            {!readOnly && canAccessRequestControls && (
              <>
                {/* Instructor/Grader Only Controls */}
                {isInstructorOrGrader && (
                  <>
                    {/* Assignment Management */}
                    <HelpRequestAssignment request={request} />
                    {/* Moderation Action Button */}
                    <Tooltip content="Moderate">
                      <Button
                        size="sm"
                        colorPalette="orange"
                        variant="surface"
                        onClick={() => moderationModal.openModal()}
                      >
                        <Icon as={BsShield} fontSize="md!" />
                      </Button>
                    </Tooltip>

                    {/* Karma Entry Button */}
                    <Tooltip content="Karma">
                      <Button size="sm" colorPalette="yellow" variant="surface" onClick={() => karmaModal.openModal()}>
                        <Icon as={BsStar} fontSize="md!" />
                      </Button>
                    </Tooltip>
                  </>
                )}

                {/* Resolve Button - Available to Instructors/Graders and Students Associated with Request */}
                {request.status !== "resolved" && request.status !== "closed" && (
                  <PopConfirm
                    triggerLabel="Resolve Request"
                    trigger={
                      <Button size="sm" colorPalette="green">
                        <Icon as={BsCheck} fontSize="md!" />
                        Resolve
                      </Button>
                    }
                    confirmHeader="Resolve Request"
                    confirmText="Are you sure you want to resolve this request?"
                    onConfirm={resolveRequest}
                    onCancel={() => {}}
                  />
                )}

                {/* Close Button - Available to Instructors/Graders and Students Associated with Request */}
                {request.status !== "closed" && (
                  <PopConfirm
                    triggerLabel="Close Request"
                    trigger={
                      <Button
                        size="sm"
                        colorPalette="red"
                        visibility={
                          request.status === "open" || request.status === "in_progress" ? "visible" : "hidden"
                        }
                      >
                        <Icon as={BsXCircle} fontSize="md!" />
                        Close
                      </Button>
                    }
                    confirmHeader="Close Request"
                    confirmText="Are you sure you want to close this request? This will mark it as closed without resolving it."
                    onConfirm={closeRequest}
                    onCancel={() => {}}
                  />
                )}
              </>
            )}
            {/* Provide Feedback Button - Available to Students Associated with Closed/Resolved Requests without Existing Feedback from the currently-logged in student */}
            {readOnly && !hasExistingFeedback && canAccessRequestControls && !isInstructorOrGrader && (
              <Button size="sm" onClick={provideFeedback}>
                <Icon as={BsStar} fontSize="md" />
                Provide Feedback
              </Button>
            )}
          </HStack>
        </HStack>

        <AvatarGroup size="sm">
          {/* Show avatars of all participants who have sent messages and all students in the request */}
          {participantIds.map((participantId) => (
            <PersonAvatar key={`participant-${participantId}`} uid={participantId} size="sm" />
          ))}
        </AvatarGroup>
      </Flex>

      {/* File References Section */}
      <Box width="100%" px="4" borderBottomWidth="1px">
        <HelpRequestFileReferences request={request} canEdit={!readOnly && canAccessRequestControls} />
      </Box>

      <Flex width="100%" overflow="auto" height="full" justify="center" align="center">
        <RealtimeChat
          messages={helpRequestMessages}
          helpRequest={request}
          helpRequestStudentIds={studentIds} // Pass student IDs for OP labeling
          readOnly={readOnly}
        />
      </Flex>

      {/* Moderation and Karma Modals - Instructor/Grader Only */}
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

      {/* Feedback Modal - Student Only */}
      {role.role === "student" && (
        <HelpRequestFeedbackModal
          isOpen={feedbackModal.isOpen}
          onClose={feedbackModal.closeModal}
          onSuccess={handleFeedbackSuccess}
          helpRequestId={request.id}
          classId={request.class_id}
          studentProfileId={private_profile_id!}
        />
      )}
    </Flex>
  );
}
