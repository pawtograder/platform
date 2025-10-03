import { Avatar, Box, HStack, Skeleton, VStack, IconButton, Text } from "@chakra-ui/react";
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

/**
 * System notification type with extended properties for future development
 *
 * Example usage scenarios:
 *
 * Welcome message:
 * { title: "Welcome!", message: "...", display: "modal", severity: "success", icon: "🎉" }
 *
 * Maintenance alert:
 * { title: "Scheduled Maintenance", message: "...", display: "banner", severity: "warning",
 *   expires_at: "2024-01-01T10:00:00Z", persistent: true }
 *
 * Feature announcement with actions:
 * { title: "New Feature", message: "...", display: "modal", severity: "info",
 *   actions: [{ label: "Learn More", action: "navigate", target: "/features/new" }] }
 *
 * Targeted instructor-only notification:
 * { title: "Grading Reminder", message: "...", display: "default", severity: "info",
 *   audience: { roles: ["instructor"] }, campaign_id: "grading-reminders" }
 */
export type SystemNotification = NotificationEnvelope & {
  type: "system";
  title: string;
  message: string;
  display: "default" | "modal" | "banner";

  // Styling and presentation
  severity?: "info" | "success" | "warning" | "error";
  icon?: string; // Custom icon name or emoji

  // Behavior
  persistent?: boolean; // If true, shows again after dismissal until explicitly acknowledged
  expires_at?: string; // ISO date string - auto-dismiss after this time

  // Actions
  actions?: {
    label: string;
    action: "navigate" | "external_link" | "custom";
    target?: string; // URL for navigate/external_link, custom identifier for custom actions
    style?: "primary" | "secondary" | "danger";
  }[];

  // Targeting and conditions
  audience?: {
    roles?: ("student" | "instructor" | "admin")[];
    course_ids?: number[];
    user_ids?: string[];
    feature_flags?: string[]; // Show only if user has these features enabled
  };

  // Analytics and tracking
  campaign_id?: string; // For grouping related notifications in analytics
  track_engagement?: boolean; // Whether to track clicks, dismissals, etc.

  // Advanced display options
  max_width?: string; // CSS width value for modals/banners
  position?: "top" | "bottom" | "center"; // For banner positioning
  backdrop_dismiss?: boolean; // For modals - whether clicking outside dismisses
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

export type RegradeRequestNotification = NotificationEnvelope & {
  type: "regrade_request";
  regrade_request_id: number;
  submission_id: number;
  assignment_id: number;
} & (
    | {
        action: "comment_challenged";
        opened_by: string;
        opened_by_name: string;
      }
    | {
        action: "status_change";
        old_status: string;
        new_status: string;
        updated_by: string;
        updated_by_name: string;
      }
    | {
        action: "escalated";
        old_status: string;
        new_status: string;
        escalated_by: string;
        escalated_by_name: string;
      }
    | {
        action: "new_comment";
        comment_author: string;
        comment_author_name: string;
        comment_id: number;
      }
  );

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

function RegradeRequestNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as RegradeRequestNotification;

  let actorProfileId: string;
  let actorName: string;
  let message: React.ReactNode;

  if (body.action === "comment_challenged") {
    actorProfileId = body.opened_by;
    actorName = body.opened_by_name;
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${actorName}** opened a regrade request on your grading comment`}
      </Markdown>
    );
  } else if (body.action === "status_change") {
    actorProfileId = body.updated_by;
    actorName = body.updated_by_name;
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${actorName}** updated a regrade request to **${body.new_status}**`}
      </Markdown>
    );
  } else if (body.action === "escalated") {
    actorProfileId = body.escalated_by;
    actorName = body.escalated_by_name;
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${actorName}** escalated a regrade request`}
      </Markdown>
    );
  } else {
    // action === "new_comment"
    actorProfileId = body.comment_author;
    actorName = body.comment_author_name;
    message = (
      <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)", lineHeight: "1.4" }}>
        {`**${actorName}** commented on a regrade request`}
      </Markdown>
    );
  }

  const actor = useUserProfile(actorProfileId);

  if (!actor) {
    return <Skeleton height="40px" width="100%" />;
  }

  return (
    <HStack align="flex-start" gap="3">
      <Avatar.Root size="sm" flexShrink="0">
        <Avatar.Image src={actor.avatar_url} />
        <Avatar.Fallback fontSize="xs">{actor.name?.charAt(0)}</Avatar.Fallback>
      </Avatar.Root>
      <VStack align="flex-start" gap="1" flex="1">
        {message}
      </VStack>
    </HStack>
  );
}

function SystemNotificationTeaser({ notification }: { notification: Notification }) {
  const body = notification.body as SystemNotification;

  // Determine colors based on severity
  const severityConfig = {
    info: { bg: "blue.subtle", color: "blue.500" },
    success: { bg: "green.subtle", color: "green.500" },
    warning: { bg: "orange.subtle", color: "orange.500" },
    error: { bg: "red.subtle", color: "red.500" }
  };

  const config = severityConfig[body.severity || "info"];

  // Default icons based on severity
  const defaultIcons = {
    info: (
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
      </svg>
    ),
    success: (
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
    ),
    warning: (
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
      </svg>
    ),
    error: (
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z" />
      </svg>
    )
  };

  return (
    <HStack align="flex-start" gap="3">
      <Box flexShrink="0" p="2" bg={config.bg} borderRadius="md" color={config.color}>
        {body.icon ? (
          // Custom icon - could be emoji or lucide icon name
          <Text fontSize="16px">{body.icon}</Text>
        ) : (
          defaultIcons[body.severity || "info"]
        )}
      </Box>
      <VStack align="flex-start" gap="2" flex="1">
        <Markdown
          style={{
            fontSize: "0.875rem",
            color: "var(--chakra-colors-fg-default)",
            lineHeight: "1.4",
            fontWeight: "600"
          }}
        >
          {body.title}
        </Markdown>
        <Markdown
          style={{
            fontSize: "0.8rem",
            color: "var(--chakra-colors-fg-default)",
            lineHeight: "1.4"
          }}
        >
          {body.message}
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
  } else if (body.type === "regrade_request") {
    const regradeBody = body as RegradeRequestNotification;
    return `/course/${course_id}/assignments/${regradeBody.assignment_id}/submissions/${regradeBody.submission_id}/files#regrade-request-${regradeBody.regrade_request_id}`;
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
  } else if (body.type === "system") {
    teaser = <SystemNotificationTeaser notification={notification} />;
  } else if (body.type === "regrade_request") {
    teaser = <RegradeRequestNotificationTeaser notification={notification} />;
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
