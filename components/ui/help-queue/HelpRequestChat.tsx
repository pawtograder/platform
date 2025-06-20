"use client";
import { useRef, useCallback, useEffect, Fragment } from "react";
import { useChatChannel } from "@/lib/chat";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, Button, VStack, Badge, Icon, IconButton } from "@chakra-ui/react";
import { BsCheck, BsCameraVideo, BsClipboardCheckFill, BsClipboardCheck, BsXCircle } from "react-icons/bs";
import useUserProfiles, { getUserProfile, useUserProfile } from "@/hooks/useUserProfiles";
import { ChatMessage } from "./ChatMessage";
import { useUpdate } from "@refinedev/core";
import { PopConfirm } from "../popconfirm";
import { Avatar } from "../avatar";
import MessageInput from "../message-input";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { toaster } from "../toaster";

/**
 * Component for managing help request assignment status and actions
 * @param request - The help request object
 * @returns JSX element for assignment controls
 */
const HelpRequestAssignment = ({ request }: { request: HelpRequest }) => {
  const { private_profile_id } = useClassProfiles();
  const { mutateAsync: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    mutationMode: "optimistic",
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
          disabled={isRequestInactive}
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
          disabled={isRequestInactive}
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
 * HelpRequestChat component with integrated control buttons for instructors/graders
 * @param request - The help request object
 * @returns JSX element for the chat interface with controls
 */
export default function HelpRequestChat({ request }: { request: HelpRequest }) {
  const { messages, participants, postMessage } = useChatChannel();
  const bottomRef = useRef<HTMLDivElement>(null);
  const secondFromBottomRef = useRef<HTMLDivElement>(null);
  const profiles = useUserProfiles();
  const creator = useUserProfile(request.creator);
  const { private_profile_id } = useClassProfiles();

  useEffect(() => {
    if (!request.resolved_by && bottomRef.current && secondFromBottomRef.current) {
      const container = secondFromBottomRef.current.parentElement?.parentElement;
      if (container) {
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (isNearBottom) {
          bottomRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        }
      }
    }
  }, [messages, request.resolved_by]);

  const { mutate } = useUpdate({ resource: "help_requests", id: request.id, mutationMode: "optimistic" });

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

  const joinVideoCall = useCallback(() => {
    window.open(
      `${process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/course/${request.class_id}/office-hours/${request.id}/meet`,
      "_blank"
    );
  }, [request.class_id, request.id]);

  const isRequestInactive = request.status === "resolved" || request.status === "closed";

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
            <HStack>
              Here now:
              {participants
                .map((p) => getUserProfile(profiles.users, p))
                .filter((p) => p)
                .map((p) => (
                  <Box key={p!.id} fontSize="sm" color="fg.subtle">
                    <HStack alignItems="center">
                      <Avatar key={p!.id} fallback={p!.name!.charAt(0)} src={p!.avatar_url} />
                      <VStack alignItems="flex-start" gap={0}>
                        {p!.badge && <Badge colorPalette={p!.badge_color}>{p!.badge}</Badge>}
                        <Text fontWeight="medium">{p!.name}</Text>
                      </VStack>
                    </HStack>
                  </Box>
                ))}
            </HStack>
          </Stack>

          {/* Assignment Management */}
          <Box>
            <HelpRequestAssignment request={request} />
          </Box>

          {/* Control Buttons */}
          <HStack gap={2}>
            {/* Video Call Button */}
            <IconButton
              aria-label="Join Video Call"
              disabled={isRequestInactive}
              opacity={isRequestInactive ? 0.5 : 1}
              onClick={joinVideoCall}
              title="Join Video Call"
            >
              <Icon as={BsCameraVideo} fontSize="md!" />
            </IconButton>

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
                  <Button size="sm" colorPalette="red" variant="outline">
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
          {/* {group.members.map((member, idx) => (
            <Avatar.Root key={idx}>
              <Avatar.Image src={member.image} />
              <Avatar.Fallback>{member.name.charAt(0)}</Avatar.Fallback>
            </Avatar.Root>
          ))} */}
        </AvatarGroup>
      </Flex>

      <Box width="100%" flex="1" overflow="auto" px="5" py="4" borderWidth="1px" borderStyle="solid" height="full">
        <ChatMessage data={{ user: request.creator, updatedAt: request.created_at, message: request.request }} />
        {messages.map((message, idx) => {
          return (
            <Fragment key={message.id}>
              <ChatMessage data={{ user: message.author, updatedAt: message.created_at, message: message.message }} />
              {idx === messages.length - 2 && <Box ref={secondFromBottomRef} />}
            </Fragment>
          );
        })}
        {messages.length < 2 && <Box ref={secondFromBottomRef} />}
        <Box ref={bottomRef} />
      </Box>
      {!request.resolved_by && request.status !== "closed" && (
        <Box width="100%" bg="bg.subtle" py="4" px="5" borderTopWidth="1px">
          <MessageInput defaultSingleLine={true} sendMessage={postMessage} />
        </Box>
      )}
    </Flex>
  );
}
