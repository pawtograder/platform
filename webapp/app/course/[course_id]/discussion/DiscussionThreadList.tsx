'use client';

import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";

import Markdown from "@/components/ui/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useUserProfile } from '@/hooks/useUserProfiles';
import { DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Box, Button, Flex, Heading, HStack, Icon, Separator, Spacer, Stack, Text } from "@chakra-ui/react";
import excerpt from '@stefanprobst/remark-excerpt';
import { formatRelative, isThisMonth, isThisWeek, isToday } from "date-fns";
import NextLink from "next/link";
import { Fragment, useId } from "react";
import { FaPlus } from "react-icons/fa";
interface MessageData {
    user: string
    updatedAt: string
    message: string
    isResolved: boolean
    isAssigned: boolean

}

interface Props {
    thread: DiscussionThread
    selected?: boolean
}

const DiscussionThreadTeaser = (props: Props) => {
    const { author, created_at, body, subject, children_count} = props.thread
    const avatarTriggerId = useId()
    const { root_id } = useParams();
    const selected = root_id ? props.thread.id === Number.parseInt(root_id as string) : false;

    const userProfile = useUserProfile(author);
    return (<><NextLink href={`/course/${props.thread.class_id}/discussion/${props.thread.id}`}>
        <HStack align="flex-start" gap="3" px="4" py="3"
            _hover={{ bg: 'bg.muted' }} rounded="md"
            width="100%"
            bg={selected ? 'bg.muted' : ''}
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
                    #{props.thread.ordinal} {subject}
                </Text>
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
                    >{body}</Markdown>
                    <HStack>
                        <Text fontSize="xs" color="text.muted">{children_count} replies</Text>
                        <Spacer />
                        <Text fontSize="xs" color="text.muted">{formatRelative(new Date(created_at), new Date())}</Text>
                    </HStack>
                </Box>
            </Stack>
        </HStack>
    </NextLink>
    </>
    )
}

export default function DiscussionThreadList() {
    const { course_id } = useParams();
    const list = useList<DiscussionThread>({
        resource: "discussion_threads",
        meta: {
            select: "*"
        },
        queryOptions: {
            staleTime: Infinity, // Realtime data
        },
        filters: [
            {
                field: "root_class_id",
                operator: "eq",
                value: Number(course_id)
            },
        ], sorters:
            [{
                field: "created_at",
                order: "desc"
            }]
    });
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
        direction="column"
        top={0} justify="space-between" align="center">
        <Box>
            <Heading size="md">Discussion Feed</Heading>
            <Button asChild size="sm" variant="surface">
                <NextLink prefetch={true} href={`/course/${course_id}/discussion/new`}>
                    <Icon as={FaPlus} />
                    New Thread
                </NextLink>
            </Button>
        </Box>

        <Box width="100%" flex={1} overflow="auto" pr="4">
            <Box role="list" aria-busy={list.isLoading} aria-live="polite" aria-label="Discussion threads">

                {list.isLoading && <Skeleton height="300px" />}
                {list.data?.data.map((thread, index) => {
                    const header = getThreadGroup(new Date(thread.created_at));
                    const prevThread = list.data?.data[list.data.data.indexOf(thread) - 1];
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
                            <DiscussionThreadTeaser thread={thread} />
                        </Fragment>
                    );
                }
                )}
            </Box>
        </Box>
        <Box width="100%">
            This is the bottom
        </Box>
    </Flex>
}