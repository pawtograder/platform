"use client";
import { useCallback } from "react";
import type {
  HelpRequest,
  HelpRequestMessage,
  Submission,
  SubmissionFile,
  HelpRequestFileReference
} from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, Icon, IconButton, Card, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import {
  BsCheck,
  BsClipboardCheckFill,
  BsClipboardCheck,
  BsXCircle,
  BsFileEarmark,
  BsCode,
  BsShield,
  BsStar
} from "react-icons/bs";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useUpdate, useList } from "@refinedev/core";
import { PopConfirm } from "../popconfirm";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { toaster } from "../toaster";
import { RealtimeChat } from "@/components/realtime-chat";
import PersonAvatar from "../person-avatar";
import VideoCallControls from "./video-call-controls";
import useModalManager from "@/hooks/useModalManager";
import CreateModerationActionModal from "@/app/course/[course_id]/manage/office-hours/modals/createModerationActionModal";
import CreateKarmaEntryModal from "@/app/course/[course_id]/manage/office-hours/modals/createKarmaEntryModal";
import useAuthState from "@/hooks/useAuthState";

// TODO: Fix moderation and karma button visibility
// TODO: The modals should be different from the manage OH page, they should autofill help request specific fields

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

  if (request.assignee === private_profile_id) {
    return (
      <Text fontSize="sm">
        Assigned to you{" "}
        <IconButton
          aria-label="Drop Assignment"
          size="sm"
          visibility={request.status === "open" || request.status === "in_progress" ? "visible" : "hidden"}
          opacity={isRequestInactive ? 0.5 : 1}
          onClick={() => updateRequest({ id: request.id, values: { assignee: null, status: "open" } })}
        >
          <Icon as={BsClipboardCheckFill} />
        </IconButton>
      </Text>
    );
  } else if (request.assignee) {
    return <Text fontSize="sm">Assigned to {request.assignee}</Text>;
  } else {
    return (
      <Text fontSize="sm">
        Not assigned{" "}
        <IconButton
          aria-label="Assume Assignment"
          variant="outline"
          size="sm"
          visibility={request.status === "open" || request.status === "in_progress" ? "visible" : "hidden"}
          opacity={isRequestInactive ? 0.5 : 1}
          onClick={() =>
            updateRequest({ id: request.id, values: { assignee: private_profile_id, status: "in_progress" } })
          }
        >
          <Icon as={BsClipboardCheck} />
        </IconButton>
      </Text>
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

  // Fetch the actual files referenced
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
    <Card.Root variant="outline" mb={4}>
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
                <Text fontSize="sm" color="fg.muted">
                  Run #{referencedSubmission.data[0].run_number} •{" "}
                  {new Date(referencedSubmission.data[0].created_at).toLocaleDateString()}
                </Text>
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
                    <HStack key={file.id}>
                      <Icon as={BsFileEarmark} color="fg.muted" />
                      <Text fontSize="sm">{file.name}</Text>
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
 * HelpRequestChat component with integrated control buttons for instructors/graders
 * @param request - The help request object
 * @returns JSX element for the chat interface with controls
 */
export default function HelpRequestChat({ request }: { request: HelpRequest }) {
  const creator = useUserProfile(request.creator);
  const { private_profile_id } = useClassProfiles();

  // Get the actual user ID from auth system (not profile ID)
  const { user } = useAuthState();
  // Get the user profile using the auth user ID to get the display name
  const currentUserProfile = useUserProfile(user?.id || "");

  // Modal management for moderation and karma actions
  const moderationModal = useModalManager();
  const karmaModal = useModalManager();

  // Get help request messages from database with real-time updates
  const { data: helpRequestMessages } = useList<HelpRequestMessage>({
    resource: "help_request_messages",
    filters: [{ field: "help_request_id", operator: "eq", value: request.id }],
    pagination: { pageSize: 1000 },
    sorters: [{ field: "created_at", order: "asc" }],
    liveMode: "auto"
  });

  const { mutate } = useUpdate({ resource: "help_requests", id: request.id });

  // Modal success handlers
  const handleModerationSuccess = () => {
    moderationModal.closeModal();
    toaster.success({
      title: "Moderation action created",
      description: "The moderation action has been successfully created."
    });
  };

  const handleKarmaSuccess = () => {
    karmaModal.closeModal();
    toaster.success({
      title: "Karma entry created",
      description: "The karma entry has been successfully created."
    });
  };

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
          <Stack spaceY="0">
            <Text fontWeight="medium">{creator?.name}&apos;s Help Request</Text>
          </Stack>

          {/* Assignment Management */}
          <Box>
            <HelpRequestAssignment request={request} />
          </Box>

          {/* Control Buttons */}
          <HStack gap={2}>
            {/* Video Call Controls */}
            <VideoCallControls request={request} canStartCall={true} size="sm" variant="full" />

            {/* Moderation Action Button */}
            <Button size="sm" colorPalette="orange" variant="outline" onClick={() => moderationModal.openModal()}>
              <Icon as={BsShield} fontSize="md!" />
              Moderate
            </Button>

            {/* Karma Entry Button */}
            <Button size="sm" colorPalette="yellow" variant="outline" onClick={() => karmaModal.openModal()}>
              <Icon as={BsStar} fontSize="md!" />
              Karma
            </Button>

            {/* Resolve Button */}
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

            {/* Close Button */}
            {request.status !== "closed" && (
              <PopConfirm
                triggerLabel="Close Request"
                trigger={
                  <Button
                    size="sm"
                    colorPalette="red"
                    variant="outline"
                    visibility={request.status === "open" || request.status === "in_progress" ? "visible" : "hidden"}
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
          </HStack>
        </HStack>

        <AvatarGroup size="sm">
          {/* Show avatars of all participants who have sent messages */}
          {helpRequestMessages?.data &&
            Array.from(
              new Set([
                request.creator, // Always include the request creator
                ...helpRequestMessages.data.map((msg) => msg.author)
              ])
            )
              .slice(0, 5)
              .map((participantId) => <PersonAvatar key={participantId} uid={participantId} size="sm" />)}
        </AvatarGroup>
      </Flex>

      {/* File References Section */}
      <Box width="100%" px="4">
        <HelpRequestFileReferences request={request} />
      </Box>

      <Flex width="100%" overflow="auto" height="full" justify="center" align="center">
        <RealtimeChat
          roomName={`help_request_${request.id}`}
          username={currentUserProfile?.name || user?.email || "Unknown User"} // Pass display name, fallback to email, then unknown
          messages={helpRequestMessages?.data}
          helpRequest={request}
        />
      </Flex>

      {/* Moderation and Karma Modals */}
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
    </Flex>
  );
}
