import { Avatar, Box, HStack, Skeleton, VStack, IconButton } from "@chakra-ui/react";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useNotification } from "@/hooks/useNotifications";
import { useDiscussionThreadTeaser } from "@/hooks/useCourseController";
import { useParams, useRouter } from "next/navigation";
import { LucideMail, X } from "lucide-react";
import { useState } from "react";
import { toaster } from "../ui/toaster";
import Markdown from "../ui/markdown";

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

export type CourseEnrollmentNotification = NotificationEnvelope & {
  type: "course_enrollment";
  action: "create";
  course_name: string;
  course_id: number;
  inviter_name: string;
  inviter_email: string;
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
  request_subject?: string;
  request_body?: string;
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

  let message: React.ReactNode;

  if (body.action === "created") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.creator_name}** created a new help request in **${body.help_queue_name}**${body.is_private ? " *(private)*" : ""}`}
      </Markdown>
    );
  } else if (body.action === "assigned") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.assignee_name}** is now working on **${body.creator_name}**'s help request in **${body.help_queue_name}**`}
      </Markdown>
    );
  } else if (body.action === "status_changed") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`Help request by **${body.creator_name}** in **${body.help_queue_name}** was marked as **${body.status}**`}
      </Markdown>
    );
  }

  return (
    <VStack align="flex-start" gap="2">
      {message}
      {body.request_preview && (
        <Markdown
          style={{
            fontSize: "0.75rem",
            color: "var(--chakra-colors-fg-muted)",
            lineHeight: "1.3",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical"
          }}
        >
          {`> ${body.request_preview}`}
        </Markdown>
      )}
    </VStack>
  );
}

function HelpRequestMessageNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as HelpRequestMessageNotification;
  const author = useUserProfile(body.author_profile_id);

  if (!author) {
    return <Skeleton height="40px" width="100%" />;
  }

  return (
    <HStack align="flex-start" gap="3">
      <Avatar.Root size="sm" flexShrink="0">
        <Avatar.Image src={author.avatar_url} />
        <Avatar.Fallback fontSize="xs">{author.name?.charAt(0)}</Avatar.Fallback>
      </Avatar.Root>
      <VStack align="flex-start" gap="1" flex="1">
        <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
          {`**${author.name}** replied to **${body.help_request_creator_name}**'s help request in **${body.help_queue_name}**${body.is_private ? " *(private)*" : ""}`}
        </Markdown>
        {body.message_preview && (
          <Markdown
            style={{
              fontSize: "0.75rem",
              color: "var(--chakra-colors-fg-muted)",
              lineHeight: "1.3",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical"
            }}
          >
            {`> ${body.message_preview}`}
          </Markdown>
        )}
      </VStack>
    </HStack>
  );
}

function AssignmentGroupMemberNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupMemberNotification;
  return (
    <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
      {`**${body.name}** ${body.action === "join" ? "joined" : "left"} your group **${body.assignment_group_name}** for **${body.assignment_name}**${body.action === "join" ? ` *(added by ${body.added_by_name})*` : ""}`}
    </Markdown>
  );
}
function AssignmentGroupInvitationNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupInvitationNotification;
  return (
    <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
      {`**${body.inviter_name}** invited you to join **${body.assignment_group_name}** for **${body.assignment_name}**`}
    </Markdown>
  );
}
function AssignmentGroupJoinRequestNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as AssignmentGroupJoinRequestNotification;

  let message;
  if (body.status === "pending") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.requestor_name}** requested to join **${body.assignment_group_name}** for **${body.assignment_name}**`}
      </Markdown>
    );
  } else if (body.status === "approved") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.decision_maker_name}** approved **${body.requestor_name}**'s request to join **${body.assignment_group_name}** for **${body.assignment_name}**`}
      </Markdown>
    );
  } else if (body.status === "rejected") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.decision_maker_name}** rejected **${body.requestor_name}**'s request to join **${body.assignment_group_name}** for **${body.assignment_name}**`}
      </Markdown>
    );
  } else if (body.status === "withdrawn") {
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${body.requestor_name}** withdrew their request to join **${body.assignment_group_name}** for **${body.assignment_name}**`}
      </Markdown>
    );
  }

  return message;
}
function DiscussionThreadReplyNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as DiscussionThreadNotification;
  const rootThread = useDiscussionThreadTeaser(body.root_thread_id, ["ordinal", "subject", "class_id"]);
  const author = useUserProfile(body.reply_author_profile_id);

  if (!author || !rootThread) {
    return <Skeleton height="40px" width="100%" />;
  }

  return (
    <HStack align="flex-start" gap="3">
      <Avatar.Root size="sm" flexShrink="0">
        <Avatar.Image src={author.avatar_url} />
        <Avatar.Fallback fontSize="xs">{author.name?.charAt(0)}</Avatar.Fallback>
      </Avatar.Root>
      <VStack align="flex-start" gap="1" flex="1">
        <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
          {`**${author.name}** replied to thread **#${rootThread.ordinal}** **${rootThread.subject}**`}
        </Markdown>
        {body.teaser && (
          <Markdown
            style={{
              fontSize: "0.75rem",
              color: "var(--chakra-colors-fg-muted)",
              lineHeight: "1.3",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical"
            }}
          >
            {`> ${body.teaser}`}
          </Markdown>
        )}
      </VStack>
    </HStack>
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
        <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
          {`**${body.subject}**`}
        </Markdown>
        <Markdown style={{ fontSize: "0.75rem", color: "var(--chakra-colors-fg-muted)" }}>
          {`*Check your email for details*`}
        </Markdown>
      </VStack>
    </HStack>
  );
}

function CourseEnrollmentNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as CourseEnrollmentNotification;
  return (
    <HStack align="flex-start" gap="3">
      <Box flexShrink="0" p="2" bg="green.subtle" borderRadius="md">
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
      </Box>
      <VStack align="flex-start" gap="1" flex="1">
        <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
          {`Welcome to **${body.course_name}**!`}
        </Markdown>
        <Markdown
          style={{
            fontSize: "0.75rem",
            color: "var(--chakra-colors-fg-muted)",
            lineHeight: "1.3"
          }}
        >
          {`You were added by **${body.inviter_name}** (${body.inviter_email})`}
        </Markdown>
      </VStack>
    </HStack>
  );
}

/**
 * Gets the navigation URL for a notification based on its type
 */
function getNotificationUrl(notification: Notification, course_id: string): string | undefined {
  const body = notification.body as NotificationEnvelope;

  if (body.type === "help_request" || body.type === "help_request_message") {
    const helpBody = body as HelpRequestNotification | HelpRequestMessageNotification;
    return `/course/${course_id}/office-hours/${helpBody.help_queue_id}`;
  } else if (body.type === "assignment_group_invitations" || body.type === "assignment_group_join_request") {
    const assignmentBody = body as AssignmentGroupInvitationNotification | AssignmentGroupJoinRequestNotification;
    return `/course/${course_id}/assignments/${assignmentBody.assignment_id}`;
  } else if (body.type === "discussion_thread") {
    const discussionBody = body as DiscussionThreadNotification;
    const replyIdx = discussionBody.new_comment_number ? `#post-${discussionBody.new_comment_number}` : "";
    return `/course/${course_id}/discussion/${discussionBody.root_thread_id}${replyIdx}`;
  } else if (body.type === "course_enrollment") {
    const enrollmentBody = body as CourseEnrollmentNotification;
    return `/course/${enrollmentBody.course_id}`;
  }

  // Email notifications and assignment group member notifications don't have specific URLs
  return undefined;
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
  const { course_id } = useParams();
  const router = useRouter();

  // No cross-course routing: use current course_id for all notification types

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

  const handleClick = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      // Mark as read if not already read
      if (!notification.viewed_at) {
        await markAsRead();
      }

      // Handle help request notifications with popup
      if (body.type === "help_request" || body.type === "help_request_message") {
        const helpBody = body as HelpRequestNotification | HelpRequestMessageNotification;
        const popOutUrl = `/course/${course_id}/office-hours/request/${helpBody.help_request_id}?popout=true`;

        // Open a new window with chat-appropriate dimensions
        const newWindow = window.open(
          popOutUrl,
          `help-request-chat-${helpBody.help_request_id}`,
          "width=800,height=600,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no"
        );

        if (newWindow) {
          newWindow.focus();

          // Set a meaningful title for the popped-out window once it loads
          newWindow.addEventListener("load", () => {
            const windowTitle = `Help Request #${helpBody.help_request_id} - ${helpBody.help_queue_name}`;
            newWindow.document.title = windowTitle;
          });
        } else {
          toaster.error({
            title: "Pop-out blocked",
            description: "Please allow pop-ups for this site to use the pop-out feature."
          });
        }
      } else {
        // Navigate to other notification URLs normally
        const url = getNotificationUrl(notification, course_id as string);
        if (url) {
          router.push(url);
        }
      }
    } catch (error) {
      toaster.error({
        title: "Failed to process notification",
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
  } else if (body.type === "course_enrollment") {
    teaser = <CourseEnrollmentNotificationTeaser notification={notification} />;
  } else if (body.type === "help_request") {
    teaser = <HelpRequestNotificationTeaser notification={notification} />;
  } else if (body.type === "help_request_message") {
    teaser = <HelpRequestMessageNotificationTeaser notification={notification} />;
  } else {
    teaser = <Markdown>{`*Unknown notification type: ${body.type}*`}</Markdown>;
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
      onClick={handleClick}
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
