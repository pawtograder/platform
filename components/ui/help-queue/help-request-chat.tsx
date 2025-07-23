"use client";
import { useCallback, useState, useMemo } from "react";
import type { HelpRequest, Submission, SubmissionFile, HelpRequestFileReference } from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, Icon, IconButton, Card, Badge } from "@chakra-ui/react";
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
  BsArrowLeft
} from "react-icons/bs";
import { useRouter, useParams, usePathname } from "next/navigation";

import { useUpdate, useList, useCreate, useDelete } from "@refinedev/core";
import { PopConfirm } from "../popconfirm";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { toaster } from "../toaster";
import { RealtimeChat } from "@/components/realtime-chat";
import PersonAvatar from "../person-avatar";
import VideoCallControls from "./video-call-controls";
import useModalManager from "@/hooks/useModalManager";
import CreateModerationActionModal from "@/app/course/[course_id]/manage/office-hours/modals/createModerationActionModal";
import CreateKarmaEntryModal from "@/app/course/[course_id]/manage/office-hours/modals/createKarmaEntryModal";

import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import StudentGroupPicker from "@/components/ui/student-group-picker";
import Link from "next/link";
import { useHelpRequestMessages, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";

// Type for help request students relationship
type HelpRequestStudent = {
  id: number;
  help_request_id: number;
  profile_id: string;
  class_id: number;
  created_at: string;
};

/**
 * Component for managing help request assignment status and actions
 * @param request - The help request object
 * @returns JSX element for assignment controls
 */
const HelpRequestAssignment = ({ request }: { request: HelpRequest }) => {
  const { private_profile_id } = useClassProfiles();
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

  // Disable assignment actions for resolved/closed requests
  const isRequestInactive = request.status === "resolved" || request.status === "closed";
  const canShowActions = request.status === "open" || request.status === "in_progress";

  if (request.assignee === private_profile_id) {
    return (
      <HStack gap={2}>
        <Badge colorPalette="green" variant="solid" fontSize="xs">
          Assigned to you
        </Badge>
        {canShowActions && (
          <Tooltip content="Drop assignment and return to queue" showArrow disabled={isRequestInactive}>
            <IconButton
              aria-label="Drop Assignment"
              size="sm"
              variant="ghost"
              colorPalette="red"
              opacity={isRequestInactive ? 0.5 : 1}
              disabled={isRequestInactive}
              onClick={() => updateRequest({ id: request.id, values: { assignee: null, status: "open" } })}
            >
              <Icon as={BsClipboardCheckFill} />
            </IconButton>
          </Tooltip>
        )}
      </HStack>
    );
  } else if (request.assignee) {
    return (
      <Badge colorPalette="blue" variant="subtle" fontSize="xs">
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
              opacity={isRequestInactive ? 0.5 : 1}
              disabled={isRequestInactive}
              onClick={() =>
                updateRequest({ id: request.id, values: { assignee: private_profile_id, status: "in_progress" } })
              }
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
 * Component to display referenced files and submissions for a help request
 * @param request - The help request object
 * @returns JSX element showing file references
 */
const HelpRequestFileReferences = ({ request }: { request: HelpRequest }) => {
  // Fetch referenced submission if any
  const { data: referencedSubmission } = useList<Submission>({
    resource: "submissions",
    filters: [{ field: "id", operator: "eq", value: request.referenced_submission_id }],
    queryOptions: {
      enabled: !!request.referenced_submission_id
    }
  });

  // Fetch file references for this help request
  const { data: fileReferences } = useList<HelpRequestFileReference>({
    resource: "help_request_file_references",
    filters: [{ field: "help_request_id", operator: "eq", value: request.id }]
  });

  // Fetch the actual files referenced to get their name
  const fileReferenceIds = fileReferences?.data?.map((ref) => ref.submission_file_id) || [];
  const { data: referencedFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [{ field: "id", operator: "in", value: fileReferenceIds }],
    queryOptions: {
      enabled: fileReferenceIds.length > 0
    }
  });

  const hasReferences = !!request.referenced_submission_id || (fileReferences?.data?.length ?? 0) > 0;

  if (!hasReferences) {
    return null;
  }

  return (
    <Card.Root variant="outline" m={4}>
      <Card.Header>
        <HStack>
          <Icon as={BsCode} />
          <Text fontWeight="medium">Referenced Code</Text>
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack spaceY={3}>
          {/* Referenced Submission */}
          {request.referenced_submission_id && referencedSubmission?.data?.[0] && (
            <Box>
              <Text fontSize="sm" fontWeight="medium" mb={2}>
                Submission:
              </Text>

              <HStack>
                <Badge colorPalette="blue" variant="subtle">
                  {referencedSubmission.data[0].repository}
                </Badge>
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
                  const fileRef = fileReferences?.data?.find((ref) => ref.submission_file_id === file.id);
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
  console.log("students", students);

  // Refinedev hooks for student association management
  const { mutateAsync: createStudentAssociation } = useCreate();
  const { mutateAsync: deleteStudentAssociation } = useDelete();

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
            <Button size="sm" variant="outline" onClick={handleCancelEdit}>
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

  // Use individual realtime hooks following the pattern from newRequestForm.tsx
  const allHelpRequestMessages = useHelpRequestMessages();
  const allHelpRequestStudents = useHelpRequestStudents();

  // Filter realtime data for this specific help request
  const helpRequestMessages = useMemo(() => {
    return allHelpRequestMessages.filter((msg) => msg.help_request_id === request.id);
  }, [allHelpRequestMessages, request.id]);

  const helpRequestStudentData = useMemo(() => {
    return allHelpRequestStudents.filter(
      (student) => student.help_request_id === request.id && student.class_id === request.class_id
    );
  }, [allHelpRequestStudents, request.id, request.class_id]);

  // Get student profiles for display - memoized to prevent unnecessary recalculations
  const { studentIds, students } = useMemo(() => {
    const studentIds = helpRequestStudentData.map((student) => student.profile_id);
    const students = profiles.filter((user: UserProfile) => studentIds.includes(user.id));
    return { studentIds, students };
  }, [helpRequestStudentData, profiles]);

  // Check if current user is instructor or grader (not a student)
  const isInstructorOrGrader = role.role === "instructor" || role.role === "grader";

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

  // Modal management for moderation and karma actions
  const moderationModal = useModalManager();
  const karmaModal = useModalManager();

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

  const resolveRequest = useCallback(() => {
    mutate({
      id: request.id,
      values: {
        resolved_by: private_profile_id,
        resolved_at: new Date().toISOString(),
        status: "resolved"
      }
    });
  }, [mutate, request.id, private_profile_id]);

  const closeRequest = useCallback(() => {
    mutate({
      id: request.id,
      values: {
        status: "closed"
      }
    });
  }, [mutate, request.id]);

  return (
    <Flex
      direction="column"
      width="100%"
      height="calc(100vh - var(--nav-height))"
      justify="space-between"
      align="center"
    >
      <Flex width="100%" borderBottomWidth="1px" px="4" py="4">
        <HStack spaceX="4" flex="1">
          {/* Back Button */}
          {pathname.includes("/manage/office-hours/request/") && (
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
              currentUserCanEdit={canAccessRequestControls}
              currentAssociations={helpRequestStudentData}
            />
          </Stack>

          {/* Control Buttons */}
          <HStack gap={2}>
            {/* Video Call Controls - Available to all users with video access */}
            {canAccessVideoControls && (
              <VideoCallControls request={request} canStartCall={isInstructorOrGrader} size="sm" variant="full" />
            )}

            {/* Request Management Controls - Available to Instructors/Graders and Students Associated with Request */}
            {canAccessRequestControls && (
              <>
                {/* Instructor/Grader Only Controls */}
                {isInstructorOrGrader && (
                  <>
                    {/* Assignment Management */}
                    <HelpRequestAssignment request={request} />
                    {/* Moderation Action Button */}
                    <Button
                      size="sm"
                      colorPalette="orange"
                      variant="outline"
                      onClick={() => moderationModal.openModal()}
                    >
                      <Icon as={BsShield} fontSize="md!" />
                      Moderate
                    </Button>

                    {/* Karma Entry Button */}
                    <Button size="sm" colorPalette="yellow" variant="outline" onClick={() => karmaModal.openModal()}>
                      <Icon as={BsStar} fontSize="md!" />
                      Karma
                    </Button>
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
                        variant="outline"
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
      <Box width="100%" px="4">
        <HelpRequestFileReferences request={request} />
      </Box>

      <Flex width="100%" overflow="auto" height="full" justify="center" align="center">
        <RealtimeChat
          messages={helpRequestMessages}
          helpRequest={request}
          helpRequestStudentIds={studentIds} // Pass student IDs for OP labeling
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
    </Flex>
  );
}
