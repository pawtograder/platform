import { useRouter } from "next/navigation";
import { useRef, useCallback, useEffect, Fragment, useState } from "react";
import { useChatChannel } from "@/lib/chat";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Flex, HStack, Stack, Text, AvatarGroup, Box, IconButton, Icon, Textarea, Group, Button, AvatarImage, VStack, Badge } from "@chakra-ui/react";
import { BsCameraVideo, BsCheck, BsSend } from "react-icons/bs";
import useUserProfiles, { getUserProfile, useUserProfile } from "@/hooks/useUserProfiles";
import { ChatMessage } from "./ChatMessage";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverHeader, PopoverBody } from "../popover";
import { useUpdate } from "@refinedev/core";
import useAuthState from "@/hooks/useAuthState";
import { PopConfirm } from "../popconfirm";
import { Avatar } from "../avatar";
import MdEditor from "../md-editor";

function HelpRequestChatInput() {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [newMessage, setNewMessage] = useState<string | undefined>(undefined);
    const { postMessage: _postMessage } = useChatChannel();
    const postMessage = useCallback((message: string) => {
        _postMessage(message);
        setNewMessage(undefined);
    }, [_postMessage]);

    return (
        <Flex>
            <MdEditor value={newMessage} onChange={(value) => setNewMessage(value)} 
            preview="edit"
                 textareaProps={
                    {
                        placeholder: `Type a message... Press Cmd+Enter to send`,
                        onKeyDown: (e) => {
                            if (e.metaKey && e.key === 'Enter') {
                                postMessage(newMessage ?? '');
                            }
                        }
                    }
                }
                />
            <IconButton
                size="sm"
                aria-label="Send message"
                onClick={() => postMessage(newMessage ?? '')}
            >
                <Icon as={BsSend} fontSize="md!" />
            </IconButton>

        </Flex>
    )
}
export default function HelpRequestChat({ request, actions }: { request: HelpRequest, actions: React.ReactNode }) {
    const { messages, participants, postMessage: _postMessage } = useChatChannel();
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const secondFromBottomRef = useRef<HTMLDivElement>(null);
    const profiles = useUserProfiles();
    const creator = useUserProfile(request.creator);
    const router = useRouter();

    useEffect(() => {
        if (!request.resolved_by && bottomRef.current && secondFromBottomRef.current) {
            const container = secondFromBottomRef.current.parentElement?.parentElement;
            if (container) {
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
                if (isNearBottom) {
                    bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
                }
            }
        }
    }, [messages, request.resolved_by]);
    const { mutate } = useUpdate({
        resource: "help_requests",
        id: request.id,
        mutationMode: "optimistic",

    })
    const user = useAuthState();
    const resolveRequest = useCallback(() => {
        mutate({ id: request.id, values: { resolved_by: user?.id, resolved_at: new Date().toISOString() } });
    }, [mutate, request.id, user?.id]);

    return (<Flex direction="column" flex="1">
        <Flex borderBottomWidth="1px" px="4" py="4">
            <HStack spaceX="4" flex="1">
                {/* <Avatar.Root /> */}
                <Stack spaceY="0">
                    <Text fontWeight="medium">{creator?.name}'s Help Request</Text>
                    <HStack>
                        Here now:
                        {participants.map(p => getUserProfile(profiles.users, p))
                            .filter(p => p)
                            .map((p) => <Box key={p!.id} fontSize="sm" color="fg.subtle">
                                <HStack alignItems="center">
                                    <Avatar key={p!.id}
                                        fallback={p!.name!.charAt(0)}
                                        src={p!.avatar_url}
                                    />
                                    <VStack alignItems="flex-start" gap={0}>
                                        {p!.badge && <Badge colorScheme={p!.badge_color}>{p!.badge}</Badge>}
                                        <Text fontWeight="medium">{p!.name}</Text>
                                    </VStack>
                                </HStack>
                            </Box>
                            )}
                    </HStack>
                </Stack>
                {actions}
                <PopConfirm triggerLabel="Resolve Request" trigger={<Button><Icon as={BsCheck} fontSize="md!" /></Button>} confirmHeader="Resolve Request" confirmText="Are you sure you want to resolve this request?" onConfirm={resolveRequest} onCancel={() => { }}></PopConfirm>
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

        <Box flex="1" overflow="auto" px="5" py="4" borderWidth="1px" borderStyle="solid" height="full">
            <ChatMessage data={{
                user: request.creator,
                updatedAt: request.created_at,
                message: request.request,
            }} />
            {messages.map((message, idx) => {
                return <Fragment key={message.id}>
                    <ChatMessage data={{
                        user: message.author,
                        updatedAt: message.created_at,
                        message: message.message,
                    }} />
                    {idx === messages.length - 2 && <Box ref={secondFromBottomRef} />}
                </Fragment>
            })}
            {messages.length < 2 && <Box ref={secondFromBottomRef} />}
            <Box ref={bottomRef} />
        </Box>
        {!request.resolved_by && <Box bg="bg.subtle" py="4" px="5" borderTopWidth="1px">
            <HelpRequestChatInput />
        </Box>}
    </Flex>)
}