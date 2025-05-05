import { Avatar, Box, Button, HStack, Skeleton, Text, VStack } from "@chakra-ui/react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import Link from "next/link";
import { useNotification } from "@/hooks/useNotifications";
import { useDiscussionThreadTeaser } from "@/hooks/useCourseController";
import { useParams } from "next/navigation";
// type NotificationTextProps = {
//   notification: Notification;
// } & TextProps;

export type NotificationEnvelope = { type: string };
export type DiscussionThreadNotification = NotificationEnvelope & {
  type: "discussion_thread";
  new_comment_number: number;
  new_comment_id: number;
  root_thread_id: number;
  reply_author_profile_id: string;
  teaser: string;

  thread_name: string;
  reply_author_name: string;
};

export type AssignmentGroupMemberNotification = NotificationEnvelope & {
  type: "assignment_group_member";
  action: "join" | "leave";
  added_by: string;
  profile_id: string;
  name: string;
  added_by_name: string;
  assignment_id: number;
  assignment_name: string;
  assignment_group_name: string;
  assignment_group_id: number;
};

export type AssignmentGroupInvitationNotification = NotificationEnvelope & {
  type: "assignment_group_invitations";
  action: "create";
  inviter: string;
  invitee: string;
  inviter_name: string;
  assignment_id: number;
  assignment_name: string;
  assignment_group_name: string;
  assignment_group_id: number;
};

export type AssignmentGroupJoinRequestNotification = NotificationEnvelope & {
  type: "assignment_group_join_request";
  action: "create" | "update";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requestor: string;
  requestor_name: string;
  assignment_id: number;
  assignment_name: string;
  assignment_group_name: string;
  assignment_group_id: number;
  decision_maker?: string;
  decision_maker_name?: string;
};

function truncateString(str: string, maxLength: number) {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + "...";
}
function AssignmentGroupMemberNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupMemberNotification;
  return (
    <HStack align="flex-start" color="text.muted">
      <Text>
        {body.name} {body.action === "join" ? "joined" : "left"} your group {body.assignment_group_name} for{" "}
        {body.assignment_name}
        {body.action === "join" ? ` (added by ${body.added_by_name})` : ""}
      </Text>
    </HStack>
  );
}
function AssignmentGroupInvitationNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupInvitationNotification;
  const { course_id } = useParams();
  return (
    <Link href={`/course/${course_id}/assignments/${body.assignment_id}`}>
      <HStack align="flex-start" color="text.muted">
        <Text>
          {body.inviter_name} invited you to join {body.assignment_group_name} for {body.assignment_name}
        </Text>
      </HStack>
    </Link>
  );
}
function AssignmentGroupJoinRequestNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupJoinRequestNotification;
  const { course_id } = useParams();
  let message;
  if (body.status === "pending") {
    message = (
      <Text>
        {body.requestor_name} requested to join {body.assignment_group_name} for {body.assignment_name}
      </Text>
    );
  } else if (body.status === "approved") {
    message = (
      <Text>
        {body.decision_maker_name} approved {body.requestor_name}'s request to join {body.assignment_group_name} for{" "}
        {body.assignment_name}
      </Text>
    );
  } else if (body.status === "rejected") {
    message = (
      <Text>
        {body.decision_maker_name} rejected {body.requestor_name}'s request to join {body.assignment_group_name} for{" "}
        {body.assignment_name}
      </Text>
    );
  } else if (body.status === "withdrawn") {
    message = (
      <Text>
        {body.requestor_name} withdrew their request to join {body.assignment_group_name} for {body.assignment_name}
      </Text>
    );
  }
  return (
    <Link href={`/course/${course_id}/assignments/${body.assignment_id}`}>
      <HStack align="flex-start" color="text.muted">
        {message}
      </HStack>
    </Link>
  );
}
function DiscussionThreadReplyNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as DiscussionThreadNotification;
  const rootThread = useDiscussionThreadTeaser(body.root_thread_id, ["ordinal", "subject", "class_id"]);
  const author = useUserProfile(body.reply_author_profile_id);
  if (!author || !rootThread) {
    return <Skeleton boxSize="4" />;
  }
  const replyIdx = body.new_comment_number ? `#post-${body.new_comment_number}` : "";
  return (
    <Link href={`/course/${rootThread.class_id}/discussion/${rootThread.id}${replyIdx}`}>
      <HStack align="flex-start" color="text.muted">
        <Avatar.Root size="sm">
          <Avatar.Image src={author.avatar_url} />
          <Avatar.Fallback>{author.name.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
        <VStack align="flex-start">
          <Text>
            {author.name} replied to thread #{rootThread.ordinal} {rootThread.subject}
          </Text>
          <Text>{body.teaser}</Text>
        </VStack>
      </HStack>
    </Link>
  );
}

export default function NotificationTeaser({
  notification_id,
  markAsRead,
  dismiss
}: {
  notification_id: number;
  markAsRead: () => Promise<void>;
  dismiss: () => Promise<void>;
}) {
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
    return <Skeleton height="40px" width="100%" />;
  }
  if (body.type === "discussion_thread") {
    teaser = <DiscussionThreadReplyNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_member") {
    teaser = <AssignmentGroupMemberNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_invitations") {
    teaser = <AssignmentGroupInvitationNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_join_request") {
    teaser = <AssignmentGroupJoinRequestNotificationTeaser notification={notification} />;
  } else {
    teaser = <Text>Unknown notification type: {body.type}</Text>;
  }
  return (
    <Box
      position="relative"
      borderRadius="md"
      borderWidth={1}
      borderColor={notification.viewed_at ? "border.muted" : "border.info"}
      p={4}
      bg={notification.viewed_at ? "bg.muted" : "yellow.subtle"}
      _hover={{ bg: "yellow.emphasized", cursor: "pointer" }}
      onMouseDown={() => {
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
        ></Box>
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
  );
}
