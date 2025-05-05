import { useRef, useCallback, useEffect, Fragment } from "react";
import { useChatChannel } from "@/lib/chat";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, Button, VStack, Badge, Icon } from "@chakra-ui/react";
import { BsCheck } from "react-icons/bs";
import useUserProfiles, { getUserProfile, useUserProfile } from "@/hooks/useUserProfiles";
import { ChatMessage } from "./ChatMessage";
import { useUpdate } from "@refinedev/core";
import { PopConfirm } from "../popconfirm";
import { Avatar } from "../avatar";
import MessageInput from "../message-input";
import { useClassProfiles } from "@/hooks/useClassProfiles";
export default function HelpRequestChat({ request, actions }: { request: HelpRequest; actions: React.ReactNode }) {
  const { messages, participants, postMessage } = useChatChannel();
  const bottomRef = useRef<HTMLDivElement>(null);
  const secondFromBottomRef = useRef<HTMLDivElement>(null);
  const profiles = useUserProfiles();
  const creator = useUserProfile(request.creator);

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
  const { private_profile_id } = useClassProfiles();
  const resolveRequest = useCallback(() => {
    mutate({ id: request.id, values: { resolved_by: private_profile_id, resolved_at: new Date().toISOString() } });
  }, [mutate, request.id, private_profile_id]);

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
          {/* <Avatar.Root /> */}
          <Stack spaceY="0">
            <Text fontWeight="medium">{creator?.name}'s Help Request</Text>
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
                        {p!.badge && <Badge colorScheme={p!.badge_color}>{p!.badge}</Badge>}
                        <Text fontWeight="medium">{p!.name}</Text>
                      </VStack>
                    </HStack>
                  </Box>
                ))}
            </HStack>
          </Stack>
          {actions}
          <PopConfirm
            triggerLabel="Resolve Request"
            trigger={
              <Button>
                <Icon as={BsCheck} fontSize="md!" />
              </Button>
            }
            confirmHeader="Resolve Request"
            confirmText="Are you sure you want to resolve this request?"
            onConfirm={resolveRequest}
            onCancel={() => {}}
          ></PopConfirm>
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
      {!request.resolved_by && (
        <Box width="100%" bg="bg.subtle" py="4" px="5" borderTopWidth="1px">
          <MessageInput defaultSingleLine={true} sendMessage={postMessage} />
        </Box>
      )}
    </Flex>
  );
}
