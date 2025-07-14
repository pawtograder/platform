import { Avatar, Box, HStack, Skeleton, Text, VStack, IconButton } from "@chakra-ui/react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import Link from "next/link";
import { useNotification } from "@/hooks/useNotifications";
import { useDiscussionThreadTeaser } from "@/hooks/useCourseController";
import { useParams } from "next/navigation";
import { LucideMail, X } from "lucide-react";
import { useState } from "react";
import { toaster } from "../toaster";
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

export type EmailNotification = NotificationEnvelope & {
  type: "email";
  action: "create";
  subject: string;
  body: string;
  cc_emails: { emails: string[] };
  reply_to?: string;
};

export type HelpRequestNotification = NotificationEnvelope & {
  type: "help_request";
  action: "created" | "status_changed" | "assigned";
  help_request_id: number;
  help_queue_id: number;
  help_queue_name: string;
  creator_profile_id: string;
  creator_name: string;
  assignee_profile_id?: string;
  assignee_name?: string;
  status?: "open" | "in_progress" | "resolved" | "closed";
  request_preview: string;
  is_private: boolean;
};

export type HelpRequestMessageNotification = NotificationEnvelope & {
  type: "help_request_message";
  help_request_id: number;
  help_queue_id: number;
  help_queue_name: string;
  message_id: number;
  author_profile_id: string;
  author_name: string;
  message_preview: string;
  help_request_creator_profile_id: string;
  help_request_creator_name: string;
  is_private: boolean;
};

// function truncateString(str: string, maxLength: number) {
//   if (str.length <= maxLength) {
//     return str;
//   }
//   return str.substring(0, maxLength) + "...";
// }
function HelpRequestNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as HelpRequestNotification;
  const { course_id } = useParams();

  let message: React.ReactNode;

  if (body.action === "created") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.creator_name}
        </Text>{" "}
        created a new help request in{" "}
        <Text as="span" fontWeight="medium">
          {body.help_queue_name}
        </Text>
        {body.is_private && (
          <Text as="span" color="orange.500">
            {" "}
            (private)
          </Text>
        )}
      </Text>
    );
  } else if (body.action === "assigned") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.assignee_name}
        </Text>{" "}
        is now working on{" "}
        <Text as="span" fontWeight="medium">
          {body.creator_name}
        </Text>
        &apos;s help request in{" "}
        <Text as="span" fontWeight="medium">
          {body.help_queue_name}
        </Text>
      </Text>
    );
  } else if (body.action === "status_changed") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        Help request by{" "}
        <Text as="span" fontWeight="medium">
          {body.creator_name}
        </Text>{" "}
        in{" "}
        <Text as="span" fontWeight="medium">
          {body.help_queue_name}
        </Text>{" "}
        was marked as{" "}
        <Text as="span" fontWeight="medium" color="green.500">
          {body.status}
        </Text>
      </Text>
    );
  }

  return (
    <Link href={`/course/${course_id}/office-hours/${body.help_queue_id}`}>
      <VStack align="flex-start" gap="2">
        {message}
        {body.request_preview && (
          <Text
            fontSize="xs"
            color="fg.muted"
            lineHeight="1.3"
            overflow="hidden"
            css={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical"
            }}
          >
            &quot;{body.request_preview}&quot;
          </Text>
        )}
      </VStack>
    </Link>
  );
}

function HelpRequestMessageNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as HelpRequestMessageNotification;
  const author = useUserProfile(body.author_profile_id);
  const { course_id } = useParams();

  if (!author) {
    return <Skeleton height="40px" width="100%" />;
  }

  return (
    <Link href={`/course/${course_id}/office-hours/${body.help_queue_id}`}>
      <HStack align="flex-start" gap="3">
        <Avatar.Root size="sm" flexShrink="0">
          <Avatar.Image src={author.avatar_url} />
          <Avatar.Fallback fontSize="xs">{author.name?.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
        <VStack align="flex-start" gap="1" flex="1">
          <Text fontSize="sm" color="fg.default" lineHeight="1.4">
            <Text as="span" fontWeight="medium">
              {author.name}
            </Text>{" "}
            replied to{" "}
            <Text as="span" fontWeight="medium">
              {body.help_request_creator_name}
            </Text>
            &apos;s help request in{" "}
            <Text as="span" fontWeight="medium">
              {body.help_queue_name}
            </Text>
            {body.is_private && (
              <Text as="span" color="orange.500">
                {" "}
                (private)
              </Text>
            )}
          </Text>
          {body.message_preview && (
            <Text
              fontSize="xs"
              color="fg.muted"
              lineHeight="1.3"
              overflow="hidden"
              css={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical"
              }}
            >
              &quot;{body.message_preview}&quot;
            </Text>
          )}
        </VStack>
      </HStack>
    </Link>
  );
}

function AssignmentGroupMemberNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupMemberNotification;
  return (
    <Text fontSize="sm" color="fg.default" lineHeight="1.4">
      <Text as="span" fontWeight="medium">
        {body.name}
      </Text>{" "}
      {body.action === "join" ? "joined" : "left"} your group{" "}
      <Text as="span" fontWeight="medium">
        {body.assignment_group_name}
      </Text>{" "}
      for{" "}
      <Text as="span" fontWeight="medium">
        {body.assignment_name}
      </Text>
      {body.action === "join" && (
        <Text as="span" color="fg.muted">
          {" "}
          (added by {body.added_by_name})
        </Text>
      )}
    </Text>
  );
}
function AssignmentGroupInvitationNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupInvitationNotification;
  const { course_id } = useParams();
  return (
    <Link href={`/course/${course_id}/assignments/${body.assignment_id}`}>
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.inviter_name}
        </Text>{" "}
        invited you to join{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_group_name}
        </Text>{" "}
        for{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_name}
        </Text>
      </Text>
    </Link>
  );
}
function AssignmentGroupJoinRequestNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupJoinRequestNotification;
  const { course_id } = useParams();

  let message;
  if (body.status === "pending") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.requestor_name}
        </Text>{" "}
        requested to join{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_group_name}
        </Text>{" "}
        for{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_name}
        </Text>
      </Text>
    );
  } else if (body.status === "approved") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.decision_maker_name}
        </Text>{" "}
        approved{" "}
        <Text as="span" fontWeight="medium">
          {body.requestor_name}
        </Text>
        &apos;s request to join{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_group_name}
        </Text>{" "}
        for{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_name}
        </Text>
      </Text>
    );
  } else if (body.status === "rejected") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.decision_maker_name}
        </Text>{" "}
        rejected{" "}
        <Text as="span" fontWeight="medium">
          {body.requestor_name}
        </Text>
        &apos;s request to join{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_group_name}
        </Text>{" "}
        for{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_name}
        </Text>
      </Text>
    );
  } else if (body.status === "withdrawn") {
    message = (
      <Text fontSize="sm" color="fg.default" lineHeight="1.4">
        <Text as="span" fontWeight="medium">
          {body.requestor_name}
        </Text>{" "}
        withdrew their request to join{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_group_name}
        </Text>{" "}
        for{" "}
        <Text as="span" fontWeight="medium">
          {body.assignment_name}
        </Text>
      </Text>
    );
  }

  return <Link href={`/course/${course_id}/assignments/${body.assignment_id}`}>{message}</Link>;
}
function DiscussionThreadReplyNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as DiscussionThreadNotification;
  const rootThread = useDiscussionThreadTeaser(body.root_thread_id, ["ordinal", "subject", "class_id"]);
  const author = useUserProfile(body.reply_author_profile_id);

  if (!author || !rootThread) {
    return <Skeleton height="40px" width="100%" />;
  }

  const replyIdx = body.new_comment_number ? `#post-${body.new_comment_number}` : "";

  return (
    <Link href={`/course/${rootThread.class_id}/discussion/${rootThread.id}${replyIdx}`}>
      <HStack align="flex-start" gap="3">
        <Avatar.Root size="sm" flexShrink="0">
          <Avatar.Image src={author.avatar_url} />
          <Avatar.Fallback fontSize="xs">{author.name?.charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
        <VStack align="flex-start" gap="1" flex="1">
          <Text fontSize="sm" color="fg.default" lineHeight="1.4">
            <Text as="span" fontWeight="medium">
              {author.name}
            </Text>{" "}
            replied to thread{" "}
            <Text as="span" fontWeight="medium">
              #{rootThread.ordinal}
            </Text>{" "}
            <Text as="span" fontWeight="medium">
              {rootThread.subject}
            </Text>
          </Text>
          {body.teaser && (
            <Text
              fontSize="xs"
              color="fg.muted"
              lineHeight="1.3"
              overflow="hidden"
              css={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical"
              }}
            >
              &quot;{body.teaser}&quot;
            </Text>
          )}
        </VStack>
      </HStack>
    </Link>
  );
}

function EmailNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as EmailNotification;
  return (
    <HStack align="flex-start" gap="3">
      <Box flexShrink="0" p="2" bg="blue.subtle" borderRadius="md">
        <LucideMail size={16} />
      </Box>
      <VStack align="flex-start" gap="1" flex="1">
        <Text fontSize="sm" color="fg.default" lineHeight="1.4" fontWeight="medium">
          {body.subject}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          Check your email for details
        </Text>
      </VStack>
    </HStack>
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
  const notification = useNotification(notification_id);
  const [isProcessing, setIsProcessing] = useState(false);
  const body = notification?.body as NotificationEnvelope;

  if (!notification) {
    return <Skeleton height="60px" width="100%" />;
  }

  const handleDismiss = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      await dismiss();
    } catch (error) {
      toaster.error({
        title: "Failed to dismiss notification",
        description: "Error: " + (error as Error).message
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMarkAsRead = async () => {
    if (notification.viewed_at || isProcessing) return;

    setIsProcessing(true);
    try {
      await markAsRead();
    } catch (error) {
      toaster.error({
        title: "Failed to mark notification as read",
        description: "Error: " + (error as Error).message
      });
    } finally {
      setIsProcessing(false);
    }
  };

  let teaser: React.ReactNode;
  if (body.type === "discussion_thread") {
    teaser = <DiscussionThreadReplyNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_member") {
    teaser = <AssignmentGroupMemberNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_invitations") {
    teaser = <AssignmentGroupInvitationNotificationTeaser notification={notification} />;
  } else if (body.type === "assignment_group_join_request") {
    teaser = <AssignmentGroupJoinRequestNotificationTeaser notification={notification} />;
  } else if (body.type === "email") {
    teaser = <EmailNotificationTeaser notification={notification} />;
  } else if (body.type === "help_request") {
    teaser = <HelpRequestNotificationTeaser notification={notification} />;
  } else if (body.type === "help_request_message") {
    teaser = <HelpRequestMessageNotificationTeaser notification={notification} />;
  } else {
    teaser = <Text>Unknown notification type: {body.type}</Text>;
  }

  return (
    <Box
      position="relative"
      p="4"
      bg={notification.viewed_at ? "bg.default" : "blue.subtle"}
      borderBottom="1px"
      borderColor="border.subtle"
      _hover={{ bg: notification.viewed_at ? "bg.subtle" : "blue.muted" }}
      cursor="pointer"
      onClick={handleMarkAsRead}
      opacity={isProcessing ? 0.6 : 1}
      pointerEvents={isProcessing ? "none" : "auto"}
      transition="all 0.2s"
    >
      {/* Unread indicator */}
      {!notification.viewed_at && (
        <Box
          position="absolute"
          left="2"
          top="50%"
          transform="translateY(-50%)"
          width="3px"
          height="20px"
          bg="blue.500"
          borderRadius="full"
        />
      )}

      {/* Dismiss button */}
      <IconButton
        position="absolute"
        right="2"
        top="2"
        size="xs"
        variant="ghost"
        colorPalette="gray"
        aria-label="Dismiss notification"
        onClick={handleDismiss}
        disabled={isProcessing}
        opacity="0.5"
        _hover={{ opacity: "1" }}
      >
        <X size={14} />
      </IconButton>

      {/* Content with proper spacing */}
      <Box pr="6" pl={!notification.viewed_at ? "4" : "0"}>
        {teaser}
      </Box>
    </Box>
  );
}
