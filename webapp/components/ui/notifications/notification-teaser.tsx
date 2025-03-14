import { Avatar, Box, Button, Card, HStack, Icon, IconButton, Skeleton, Text, TextProps, VStack } from "@chakra-ui/react";
import { Notification, DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { useOne } from "@refinedev/core";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { FaTimes } from "react-icons/fa";
import Link from "next/link";
import { useNotification } from "@/hooks/useNotifications";
import { useDiscussionThreadTeaser } from "@/hooks/useCourseController";

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
    teaser: string;
}

function truncateString(str: string, maxLength: number) {
    if (str.length <= maxLength) {
        return str;
    }
    return str.substring(0, maxLength) + "...";
}
function DiscussionThreadReplyNotificationTeaser({ notification }: { notification: Notification }) {
    const body = notification.body as DiscussionThreadNotification;
    const rootThread = useDiscussionThreadTeaser(body.root_thread_id, ['ordinal','subject','class_id']);
    const author = useUserProfile(body.reply_author_profile_id);
    if (!author || !rootThread) {
        return <Skeleton boxSize="4" />
    }
    const replyIdx = body.new_comment_number ? `#post-${body.new_comment_number}` :'';
    return <Link href={`/course/${rootThread.class_id}/discussion/${rootThread.id}${replyIdx}`}>
        <HStack align="flex-start" color="text.muted">
            <Avatar.Root size="sm">
                <Avatar.Image src={author.avatar_url} />
                <Avatar.Fallback>
                {author.name.charAt(0)}
            </Avatar.Fallback>
        </Avatar.Root>
        <VStack align="flex-start">
            <Text>{author.name} replied to thread #{rootThread.ordinal} {rootThread.subject}</Text>
                <Text>{body.teaser}</Text>
            </VStack>
        </HStack>
    </Link>
}

export default function NotificationTeaser({ notification_id, markAsRead, dismiss }: { notification_id: number, markAsRead: ()=>Promise<void>, dismiss: ()=>Promise<void> }) {
    
    // const { data, error} = useOne<Notification>({
    //     resource: "notifications",
    //     id: notification_id,
    //     queryOptions: {
    //         cacheTime: Infinity,
    //         staleTime: Infinity, //We get live updates anyway
    //     }
    // })
    // console.log(error)
    // console.log(data)
    // const notification = data?.data;
    const notification = useNotification(notification_id);
    const body = notification?.body as NotificationEnvelope;
    let teaser: React.ReactNode;
    if (!notification) {
        return <Skeleton height="40px" width="100%" />
    }
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
