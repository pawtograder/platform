'use client';

import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";

import Markdown from "@/components/ui/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useUserProfile } from '@/hooks/useUserProfiles';
import { DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Button, Flex, Heading, HStack, Icon, Separator, Spacer, Stack, Text } from "@chakra-ui/react";
import excerpt from '@stefanprobst/remark-excerpt';
import { formatRelative, isThisMonth, isThisWeek, isToday } from "date-fns";
import NextLink from "next/link";
import { Fragment, useId } from "react";
import { FaPlus } from "react-icons/fa";
import { useDiscussionThreadReadStatus, useDiscussionThreadTeaser, useDiscussionThreadTeasers } from "@/hooks/useCourseController";
interface MessageData {
    user: string
    updatedAt: string
    message: string
    isResolved: boolean
    isAssigned: boolean

}

interface Props {
    thread_id: number
    selected?: boolean
    width?: string
}

export const DiscussionThreadTeaser = (props: Props) => {
    const thread = useDiscussionThreadTeaser(props.thread_id);
    const avatarTriggerId = useId()
    const { root_id } = useParams();
    const selected = root_id ? props.thread_id === Number.parseInt(root_id as string) : false;
    const is_answered = thread?.answer != undefined;

    const { readStatus } = useDiscussionThreadReadStatus(props.thread_id);

    const userProfile = useUserProfile(thread?.author);
    return (<Box position="relative" width={props.width || "100%"}><NextLink href={`/course/${thread?.class_id}/discussion/${thread?.id}`} prefetch={true}>
        <Box position="absolute" left="1" top="50%" transform="translateY(-50%)">
            {!readStatus?.read_at && (
                <Box w="8px" h="8px" bg="blue.500" rounded="full">
                </Box>
            )}
        </Box>
        <HStack align="flex-start" gap="3" px="4" py="3"
            _hover={{ bg: 'bg.muted' }} rounded="md"
            width="100%"
            bg={
                !readStatus?.read_at ? 'bg.info' :
                    selected ? 'bg.muted' : ''}
        >
            <Box pt="1">
                <Tooltip ids={{ trigger: avatarTriggerId }} openDelay={0} showArrow content={userProfile?.name}>
                    <Avatar.Root size="xs">
                        <Avatar.Image id={avatarTriggerId} src={userProfile?.avatar_url} />
                        <Avatar.Fallback id={avatarTriggerId}>{userProfile?.name.charAt(0)}</Avatar.Fallback>
                    </Avatar.Root>
                </Tooltip>
            </Box>
            <Stack spaceY="0" fontSize="sm" flex="1" truncate>
                <Text fontWeight="medium" flex="1" css={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                    #{thread?.ordinal} {thread?.subject}
                </Text>
                {(thread?.is_question && !is_answered) && <Box><Badge colorPalette="red">Unanswered</Badge></Box>}
                {is_answered && <Box><Badge colorPalette="green">Answered</Badge></Box>}
                <Box color="fg.subtle" truncate>
                    <Markdown
                        components={{
                            a: ({ href, children }) => (
                                children
                            ),
                            img: ({ src, alt }) => (
                                <Text as="span" color="gray.500">[image]</Text>
                            ),
                            code: ({ children }) => (
                                children
                            ),
                            pre: ({ children }) => (
                                children
                            ),
                            blockquote: ({ children }) => (
                                children
                            ),
                            h1: ({ children }) => (
                                children
                            ),
                            h2: ({ children }) => (
                                children
                            ),
                            h3: ({ children }) => (
                                children
                            ),
                        }}
                        remarkPlugins={[[excerpt, { maxLength: 100 }]]}
                    >{thread?.body}</Markdown>
                    <HStack>
                        <Text fontSize="xs" color="text.muted">{thread?.children_count} replies</Text>
                        {readStatus?.numReadDescendants !== thread?.children_count && (
                            <Badge colorScheme="blue">{(thread?.children_count ?? 0) - (readStatus?.numReadDescendants ?? 0)} new</Badge>
                        )}
                        <Spacer />
                        <Text fontSize="xs" color="text.muted">{thread?.created_at ? formatRelative(new Date(thread?.created_at), new Date()) : ""}</Text>
                    </HStack>
                </Box>
            </Stack>
        </HStack>
    </NextLink>
    </Box>
    )
}

export default function DiscussionThreadList() {
    const { course_id } = useParams();
    const list = useDiscussionThreadTeasers();
    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const getThreadGroup = (date: Date) => {
        if (isToday(date)) {
            return "Today";
        } else if (isThisWeek(date)) {
            return "This Week";
        } else if (isThisMonth(date)) {
            return "This Month";
        } else {
            return "Older";
        }
    };


    return <Flex width="314px"
        height="100vh"
        bottom={0}
        direction="column"
        top={0} justify="space-between" align="center">
        <Box>
            <Heading size="md">Discussion Feed</Heading>
            <Button asChild size="sm" variant="surface" colorScheme="green">
                <NextLink prefetch={true} href={`/course/${course_id}/discussion/new`}>
                    <Icon as={FaPlus} />
                    New Thread
                </NextLink>
            </Button>
        </Box>

        <Box width="100%" flex={1} overflowY="auto" pr="4">
            <Box role="list" aria-busy={list === undefined} aria-live="polite" aria-label="Discussion threads">

                {list === undefined && <Skeleton height="300px" />}
                {list.map((thread, index) => {
                    const header = getThreadGroup(new Date(thread.created_at));
                    const prevThread = list[index - 1];
                    const isFirstInGroup = !prevThread ||
                        getThreadGroup(new Date(prevThread.created_at)) !== header;

                    return (
                        <Fragment key={thread.id}>
                            {isFirstInGroup &&
                                <HStack>
                                    <Separator flex="1" />
                                    <Text fontSize="sm" fontWeight="light" color="text.muted" flexShrink="0">{header}</Text>
                                    <Separator flex="1" />
                                </HStack>
                            }
                            <DiscussionThreadTeaser thread_id={thread.id} />
                        </Fragment>
                    );
                }
                )}
            </Box>
        </Box>
    </Flex>
}