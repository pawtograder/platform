'use client';

import { Skeleton, SkeletonCircle } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useDiscussionThreadReadStatus } from "@/hooks/useCourseController";
import useDiscussionThreadChildren, { DiscussionThreadsControllerProvider } from "@/hooks/useDiscussionThreadRootController";
import { useDiscussionThreadWatchStatus } from "@/hooks/useDiscussionThreadWatches";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { DiscussionThread as DiscussionThreadType, DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Avatar, Badge, Box, Button, Heading, HStack, Link, Text, VStack } from "@chakra-ui/react";
import { useList, useOne, useUpdate } from "@refinedev/core";
import { formatRelative } from "date-fns";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FaEye, FaEyeSlash, FaPencilAlt, FaReply, FaSmile } from "react-icons/fa";
import Markdown from "react-markdown";
import { DiscussionThread, DiscussionThreadReply } from "../discussion_thread";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import MessageInput from "@/components/ui/message-input";
import PersonName from "@/components/ui/person-name";
function ThreadHeader({ thread, topic }: { thread: DiscussionThreadType, topic: DiscussionTopic | undefined }) {
    const userProfile = useUserProfile(thread.author);
    return <Box>
        <VStack gap="0" align="start">
            <HStack align="start" gap="2" alignSelf="flex-start">
                {userProfile ? <Avatar.Root size="xs">
                    <Avatar.Image src={userProfile?.avatar_url} />
                    <Avatar.Fallback>{userProfile?.name.charAt(0)}</Avatar.Fallback>
                </Avatar.Root> : <SkeletonCircle width="20px" height="20px" />}
                <VStack gap="0" alignSelf="flex-start" align="start">
                    {thread.instructors_only && <Badge colorPalette="blue">Viewable by poster and staff only</Badge>}
                    <HStack>
                        {userProfile ?
                            <Heading size="sm">{userProfile?.name}
                                {userProfile?.real_name && (" (" + userProfile?.real_name + " to self and instructors)")}
                            </Heading>

                            : <Skeleton width="100px" />}
                        <Text fontSize="sm" color="text.muted">{thread.is_question ? "Asked question" : "Posted note"} #{thread.ordinal} to </Text>
                        {topic ? <Badge colorScheme={topic.color}>{topic.topic}</Badge> : <Skeleton width="100px" height="20px" />}
                    </HStack>
                    <Text fontSize="sm" color="text.muted">{formatRelative(new Date(thread.created_at), new Date())}</Text>
                    {thread.edited_at && <Text fontSize="sm" color="text.muted">Edited {formatRelative(new Date(thread.edited_at), new Date())}</Text>}
                </VStack>
            </HStack>
            <Heading size="xl" pt="4" pb="4">{thread.subject}</Heading>
        </VStack>
    </Box>
}
function ThreadActions({ thread, editing, setEditing }: { thread: DiscussionThreadType, editing: boolean, setEditing: (editing: boolean) => void }) {
    const [replyVisible, setReplyVisible] = useState(false);
    const { public_profile_id, private_profile_id, role } = useClassProfiles()
    const canEdit = thread.author === public_profile_id || thread.author === private_profile_id || role.role === "instructor" || role.role === "grader";
    return <Box borderBottom="1px solid" borderColor="border.emphasized" pb="2" pt="4">

        <Tooltip content="Watch">
            <ThreadWatchButton thread={thread} />
        </Tooltip>
        {canEdit && <Tooltip content="Edit">
            <Button aria-label="Edit" onClick={() => setEditing(!editing)} variant="ghost" size="sm"><FaPencilAlt /></Button>
        </Tooltip>}
        <Tooltip content="Reply">
            <Button aria-label="Reply" onClick={() => setReplyVisible(true)} variant="ghost" size="sm"><FaReply /></Button>
        </Tooltip>
        <Tooltip content="Emote">
            <Button aria-label="Emote" variant="ghost" size="sm"><FaSmile /></Button>
        </Tooltip>
        <DiscussionThreadReply thread={thread} visible={replyVisible} setVisible={setReplyVisible} />
    </Box>
}
function ThreadWatchButton({ thread }: { thread: DiscussionThreadType }) {
    const { status, setThreadWatchStatus } = useDiscussionThreadWatchStatus(thread.id);
    return <Button variant="ghost" size="sm" onClick={() => {
        setThreadWatchStatus(!status);
    }}>
        {status ? "Unwatch" : "Watch"}
        {status ? <FaEyeSlash /> : <FaEye />}
    </Button>
}

function DiscussionPost({ root_id, course_id }: { root_id: number, course_id: number }) {
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
    const { data: rootThread, isLoading } = useOne<DiscussionThreadType>({
        resource: "discussion_threads",
        id: root_id.toString(),
        meta: {
            //Avoid selecting the children count so that the page is stable during replies
            select: 'answer, author, body, class_id, created_at, draft, edited_at, id, instructors_only, is_question, ordinal, parent, root, root_class_id, subject, topic_id'
        },
        queryOptions: {
            enabled: !!root_id,
            staleTime: Infinity,
            cacheTime: Infinity,
        },
    })
    const { mutateAsync: updateThread } = useUpdate({
        resource: "discussion_threads"
    })
    const [editing, setEditing] = useState(false);

    const { readStatus, setUnread } = useDiscussionThreadReadStatus(root_id);

    useEffect(() => {
        if (!readStatus?.read_at) {
            setUnread(root_id, root_id, false);
        }
    }, [readStatus, setUnread]);


    if (isLoading || !discussion_topics?.data || !rootThread?.data) {
        return <Skeleton height="100px" />
    }
    return <>
        <ThreadHeader thread={rootThread.data} topic={discussion_topics?.data.find((t) => t.id === rootThread.data.topic_id)} />
        <Box>
            {editing ? <MessageInput sendMessage={async (message, profile_id) => {
                await updateThread({
                    id: root_id.toString(),
                    values: {
                        body: message,
                        edited_at: new Date().toISOString()
                    }
                })
                setEditing(false);

            }}
                enableEmojiPicker={true}
                enableFilePicker={true}
                enableGiphyPicker={true}
                sendButtonText="Edit"
                value={rootThread.data.body} /> : <Markdown>{rootThread.data.body}</Markdown>}
        </Box>
        {rootThread.data.answer && <DiscussionThreadAnswer answer_id={rootThread.data.answer} />}
        <ThreadActions thread={rootThread.data} editing={editing} setEditing={setEditing} />
    </>
}
function DiscussionThreadAnswer({ answer_id }: { answer_id: number }) {
    const answer = useDiscussionThreadChildren(answer_id);
    const userProfile = useUserProfile(answer?.author);
    if (!answer || !userProfile) {
        return <Skeleton height="100px" />
    }
    return <Link href={`/course/${answer.class_id}/discussion/${answer.root}#post-${answer.ordinal}`}>
        <Box m="2" p="2" border="1px solid" borderColor="border.info" rounded="l3"
            bg="bg.info"
            minW="xl"
        >
            Answered in #{answer.ordinal} by {userProfile.name} {userProfile.flair && <Badge colorPalette={userProfile.flair_color}>{userProfile.flair}</Badge>}
        </Box>
    </Link>
}
function DiscussionPostWithChildren({ root_id, course_id }: { root_id: number, course_id: number }) {

    const thread = useDiscussionThreadChildren(root_id);
    return <>
        <DiscussionPost root_id={root_id} course_id={course_id} />
        {
            thread && thread.children.map((child, index) => (
                <DiscussionThread key={child.id} thread_id={child.id}
                    indent={false}
                    outerSiblings={thread.children.length > 1 && index !== thread.children.length - 1 ? "1" : "0"}
                    isFirstDescendantOfParent={index === 0}
                    originalPoster={thread.author}
                />
            ))
        }
    </>
}
export default function ThreadView() {
    const { course_id, root_id } = useParams();
    return <Box width="100%">
        <DiscussionThreadsControllerProvider root_id={Number.parseInt(root_id as string)}>
            <DiscussionPostWithChildren root_id={Number.parseInt(root_id as string)} course_id={Number.parseInt(course_id as string)} />
        </DiscussionThreadsControllerProvider>
    </Box>
}