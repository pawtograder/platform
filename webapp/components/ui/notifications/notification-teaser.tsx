import { Avatar, Box, Button, Card, HStack, Icon, IconButton, Skeleton, Text, TextProps, VStack } from "@chakra-ui/react";
import { Notification, DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { useOne } from "@refinedev/core";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { FaTimes } from "react-icons/fa";
import Link from "next/link";

type NotificationTextProps = {
    notification: Notification;
} & TextProps;

type NotificationEnvelope = {
    type: string;
}
export type DiscussionThreadNotification = NotificationEnvelope & {
    type: "discussion_thread";
    new_comment_number: number;
    new_comment_id: number;
    root_thread_id: number;
    reply_author_profile_id: string;
}

function truncateString(str: string, maxLength: number) {
    if (str.length <= maxLength) {
        return str;
    }
    return str.substring(0, maxLength) + "...";
}
function DiscussionThreadReplyNotificationTeaser({ notification }: { notification: Notification }) {
    const body = notification.body as DiscussionThreadNotification;
    const rootThread = useOne<DiscussionThread>({
        resource: "discussion_threads",
        id: body.root_thread_id,
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity, //We get live updates anyway
        }
    })
    const reply = useOne<DiscussionThread>({
        resource: "discussion_threads",
        id: body.new_comment_id,
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity, //We get live updates anyway
        }
    });
    const author = useUserProfile(body.reply_author_profile_id);
    if (!author || !reply.data || !rootThread.data) {
        return <Skeleton boxSize="4" />
    }
    const replyIdx = reply.data?.data.ordinal ? `#post-${reply.data?.data.ordinal}` :'';
    return <Link href={`/course/${rootThread.data?.data.class_id}/discussion/${rootThread.data?.data.id}${replyIdx}`}>
        <HStack align="flex-start" color="text.muted">
            <Avatar.Root size="sm">
                <Avatar.Image src={author.avatar_url} />
                <Avatar.Fallback>
                {author.name.charAt(0)}
            </Avatar.Fallback>
        </Avatar.Root>
        <VStack align="flex-start">
            <Text>{author.name} replied to thread #{rootThread.data?.data.ordinal} {rootThread.data?.data.subject}</Text>
                <Text>{truncateString(reply.data?.data.body, 100)}</Text>
            </VStack>
        </HStack>
    </Link>
}

export default function NotificationTeaser({ notification, markAsRead, dismiss }: { notification: Notification, markAsRead: ()=>Promise<void>, dismiss: ()=>Promise<void> }) {
    const body = notification.body as NotificationEnvelope;
    let teaser: React.ReactNode;
    if (body.type === "discussion_thread") {
        teaser = <DiscussionThreadReplyNotificationTeaser notification={notification} />
    } else {
        teaser = <Text>Unknown notification type: {body.type}</Text>
    }
    return <Box position="relative" borderRadius="md" borderWidth={1} borderColor={notification.viewed_at ? "border.muted" : "border.info"}
        p={4}
        bg={notification.viewed_at ? "bg.muted" : "yellow.subtle"}
        _hover={{
            bg: "yellow.emphasized",
            cursor: "pointer"
        }}
        onMouseDown={()=>{
            markAsRead();
        }}
    >
        {!notification.viewed_at && (
            <Box 
                position="absolute" 
                left="2"
                top="3"
                transform="translateY(-50%)"
                width="10px"
                height="10px"
                borderRadius="full"
                bg="blue.500"
            >
            </Box>
        )}
        <Button
            position="absolute"
            right="0"
            top="0"
            size="xs"
            variant="ghost"
            colorScheme="gray"
            m={0}
            p={0}
            aria-label="Dismiss notification"
            onClick={() => dismiss()}
        >
                X
        </Button>
        {teaser}
    </Box>
}
