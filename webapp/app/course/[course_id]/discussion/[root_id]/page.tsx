'use client';

import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton";
import { DiscussionThread as DiscussionThreadType, DiscussionTopic, ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { Box, Breadcrumb, Button, Heading, VStack, Text, HStack, Avatar, Badge } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DiscussionThread, DiscussionThreadReply, threadsToTree } from "../discussion_thread";
import Link from "@/components/ui/link";
import Markdown from "react-markdown";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { formatRelative } from "date-fns";
import { FaReply, FaSmile } from "react-icons/fa";

function ThreadHeader({ thread, topic }: { thread: DiscussionThreadType, topic: DiscussionTopic | undefined }) {
    const userProfile = useUserProfile(thread.author);
    return <Box>
        <VStack gap="0" align="start">
            <HStack align="start" gap="2" alignSelf="flex-start">
                {userProfile ? <Avatar.Root size="xs">
                    <Avatar.Image src={userProfile?.avatar_url} />
                    <Avatar.Fallback>{userProfile?.name.charAt(0)}</Avatar.Fallback>
                </Avatar.Root> : <SkeletonCircle size="xs" />}
                <VStack gap="0" alignSelf="flex-start" align="start">
                    <HStack>
                        <Heading size="sm">{userProfile?.name || <Skeleton width="100px" />}</Heading>
                        <Text fontSize="sm" color="text.muted">{thread.is_question ? "Asked question" : "Posted note"} #{thread.ordinal} to </Text>
                        {topic ? <Badge colorScheme={topic.color}>{topic.topic}</Badge> : <Skeleton width="100px" height="20px" />}
                    </HStack>
                    <Text fontSize="sm" color="text.muted">{formatRelative(new Date(thread.created_at), new Date())}</Text>
                </VStack>
            </HStack>
            <Heading size="xl" pt="4" pb="4">{thread.subject}</Heading>
        </VStack>
    </Box>
}
function ThreadActions({ thread }: { thread: DiscussionThreadType }) {
    const [replyVisible, setReplyVisible] = useState(false);
    return <Box borderBottom="1px solid" borderColor="border.emphasized" pb="2" pt="4">
        <Tooltip content="Reply">
            <Button aria-label="Reply" onClick={() => setReplyVisible(true)} variant="ghost" size="sm"><FaReply /></Button>
        </Tooltip>
        <Tooltip content="Emote">
            <Button aria-label="Emote" variant="ghost" size="sm"><FaSmile /></Button>
        </Tooltip>
        <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
    </Box>
}
export default function ThreadView() {
    const [thread, setThread] = useState<ThreadWithChildren>();
    const { course_id, root_id } = useParams();
    const { data: discussion_topics } = useList<DiscussionTopic>({
        resource: "discussion_topics",
        meta: {
            select: "*"
        },
        filters: [
            {
                field: 'class_id',
                operator: 'eq',
                value: course_id
            }
        ]
    })
    const { data, isLoading, error } = useList<DiscussionThreadType>({
        resource: "discussion_threads",
        meta: {
            select: "*"
        },
        pagination: {
            pageSize: 10000
        },
        sorters: [{
            field: "created_at",
            order: "asc"
        }],
        filters: [
            {
                field: 'root',
                operator: 'eq',
                value: root_id
            }
        ]
    })
    useEffect(() => {
        if (data) {
            setThread(threadsToTree(data.data));
        }
    }, [data, data?.data]);

    if (!data || !thread) {
        return <Skeleton height="100px" />
    }
    if (data.data.length === 0) {
        return <Box>
            No thread found
        </Box>
    }
    const rootThread = data.data.find((t) => t.id === Number.parseInt(root_id as string));
    if (!rootThread) {
        return <Box>
            Thread not found
        </Box>
    }

    return <Box width="100%" height="calc(100vh - var(--nav-height))" overflowY="auto">
        <ThreadHeader thread={rootThread} topic={discussion_topics?.data.find((t) => t.id === rootThread.topic_id)} />
        <Box>
            <Markdown>{rootThread.body}</Markdown>
        </Box>
        <ThreadActions thread={rootThread} />
        {
            (thread as ThreadWithChildren).children && (thread as ThreadWithChildren).children.map((child, index) => (
                <DiscussionThread key={child.id} thread={child}
                    borders={{
                        indent: false,
                        outerSiblings: (thread as ThreadWithChildren).children.length > 1 && index !== (thread as ThreadWithChildren).children.length - 1 ? [true] : [false],
                        descendant: child.children_count > 0,
                        isFirstDescendantOfParent: index === 0,
                    }}
                    originalPoster={thread.author}
                />
            ))
        }
    </Box >

}