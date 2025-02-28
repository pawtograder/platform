'use client';

import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { DiscussionThreadWithAuthorAndTopic, ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
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
type Thread = Database['public']['Tables']['discussion_threads']['Row'];

function ThreadHeader({ thread }: { thread: DiscussionThreadWithAuthorAndTopic }) {
    const userProfile = useUserProfile(thread.author);
    return <Box>
        <VStack gap="0" align="start">
            <HStack align="start" gap="2" alignSelf="flex-start">
                <Avatar.Root size="xs">
                    <Avatar.Image src={userProfile?.avatar_url} />
                    <Avatar.Fallback>{userProfile?.name.charAt(0)}</Avatar.Fallback>
                </Avatar.Root>
                <VStack gap="0" alignSelf="flex-start" align="start">
                    <HStack>
                        <Heading size="sm">{userProfile?.name}</Heading>
                        <Text fontSize="sm" color="text.muted">{thread.is_question ? "Asked a question" : "Posted a note"} to </Text>
                        <Badge colorScheme={thread.discussion_topics.color}>{thread.discussion_topics.topic}</Badge>
                    </HStack>
                    <Text fontSize="sm" color="text.muted">{formatRelative(new Date(thread.created_at), new Date())}</Text>
                </VStack>
            </HStack>
            <Heading size="xl" pt="4" pb="4">{thread.subject}</Heading>
        </VStack>
    </Box>
}
function ThreadActions({ thread }: { thread: DiscussionThreadWithAuthorAndTopic }) {
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
    const { data, isLoading, error } = useList<DiscussionThreadWithAuthorAndTopic>({
        resource: "discussion_threads",
        meta: {
            select: "*, discussion_topics(*), public_profiles(*)"
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
                operator: 'or',
                value: [
                    {
                        field: 'id',
                        operator: 'eq',
                        value: root_id
                    },
                    {
                        field: 'root',
                        operator: 'eq',
                        value: root_id
                    }
                ]
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
        <ThreadHeader thread={rootThread} />
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