import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { emailTemplates } from "./emailTemplates.ts";
import type { Notification } from "../_shared/FunctionTypes.d.ts";
import nodemailer from "npm:nodemailer";
import * as Sentry from "npm:@sentry/deno";

// Declare EdgeRuntime for type safety
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("DENO_DEPLOYMENT_ID")!,
    debug: Deno.env.get("SENTRY_DEBUG") === "true",
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}

export type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
};
export type NotificationEnvelope = {
  type: string;
};
export type DiscussionThreadNotification = NotificationEnvelope & {
  type: "discussion_thread";
  action: "new_post" | "reply";
  new_comment_number: number;
  new_comment_id: number;
  root_thread_id: number;
  reply_author_profile_id: string;
  teaser: string;
  thread_name: string;
  reply_author_name: string;
  topic_id?: number;
  notification_reason?: "topic_follow" | "thread_watch";
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

// Helper function to set up Sentry scope with notification context
function setupSentryScope(scope: Sentry.Scope, notification: QueueMessage<Notification>) {
  scope.setTag("notification_id", notification.message.id);
  scope.setTag("class_id", notification.message.class_id);
  scope.setTag("user_id", notification.message.user_id);
  scope.setContext("notification", {
    msg_id: notification.msg_id,
    notification_id: notification.message.id,
    class_id: notification.message.class_id,
    user_id: notification.message.user_id
  });
}

// Helper function to validate notification body
function validateNotificationBody(
  notification: QueueMessage<Notification>,
  scope: Sentry.Scope
): NotificationEnvelope | null {
  if (!notification.message.body) {
    const error = new Error(`No body found for notification ${notification.message.id}`);
    scope.setContext("error_details", { missing: "notification.message.body" });
    Sentry.captureException(error, scope);
    console.error(`No body found for notification ${notification.message.id}`);
    return null;
  }
  return notification.message.body as NotificationEnvelope;
}

// Helper function to extract CC emails from notification body
function extractCCEmails(body: NotificationEnvelope): string[] {
  const cc_emails: string[] = [];
  if ("cc_emails" in body) {
    const data = body.cc_emails as { emails: string[] };
    data.emails.forEach((email) => cc_emails.push(email));
  }
  return cc_emails;
}

// Helper function to get and validate email template
function getEmailTemplate(body: NotificationEnvelope, scope: Sentry.Scope): { subject: string; body: string } | null {
  let emailTemplate = emailTemplates[body.type as keyof typeof emailTemplates];
  if (!emailTemplate) {
    const error = new Error(`No email template found for notification type ${body.type}`);
    scope.setContext("error_details", { missing_template_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No email template found for notification type ${body.type}`);
    return null;
  }

  if ("action" in body && body.action) {
    emailTemplate = emailTemplate[body.action as keyof typeof emailTemplate];
  } else if (body.type === "discussion_thread") {
    // Default to "reply" for backward compatibility with old notifications
    emailTemplate = emailTemplate["reply" as keyof typeof emailTemplate];
  }

  if (!("subject" in emailTemplate)) {
    const error = new Error(`No subject found for email template ${body.type}`);
    scope.setContext("error_details", { missing_subject_for_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No subject found for email template ${body.type}`);
    return null;
  }

  if (!("body" in emailTemplate)) {
    const error = new Error(`No body found for email template ${body.type}`);
    scope.setContext("error_details", { missing_body_for_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No body found for email template ${body.type}`);
    return null;
  }

  return {
    subject: emailTemplate.subject as string,
    body: emailTemplate.body as string
  };
}

// Helper function to build URLs for email templates
function buildEmailUrls(
  body: NotificationEnvelope,
  classId: number
): {
  course_url: string;
  assignment_url?: string;
  help_queue_url?: string;
  help_request_url?: string;
  thread_url?: string;
  regrade_request_url?: string;
} {
  const course_url = `https://${Deno.env.get("APP_URL")}/course/${classId}`;
  const urls: {
    course_url: string;
    assignment_url?: string;
    help_queue_url?: string;
    help_request_url?: string;
    thread_url?: string;
    regrade_request_url?: string;
  } = { course_url };

  if ("assignment_id" in body) {
    urls.assignment_url = `https://${Deno.env.get("APP_URL")}/course/${classId}/assignments/${body.assignment_id}`;
  }

  if ("help_queue_id" in body) {
    urls.help_queue_url = `https://${Deno.env.get("APP_URL")}/course/${classId}/office-hours/${(body as { help_queue_id: string }).help_queue_id}`;
  }

  if ("help_request_id" in body) {
    urls.help_request_url = `https://${Deno.env.get("APP_URL")}/course/${classId}/office-hours/request/${(body as { help_request_id: string }).help_request_id}`;
  }

  if ("root_thread_id" in body) {
    urls.thread_url = `https://${Deno.env.get("APP_URL")}/course/${classId}/discussion/${body.root_thread_id}`;
  }

  if ("regrade_request_id" in body) {
    const regradeBody = body as RegradeRequestNotification;
    urls.regrade_request_url = `https://${Deno.env.get("APP_URL")}/course/${classId}/assignments/${regradeBody.assignment_id}/submissions/${regradeBody.submission_id}/files#regrade-request-${regradeBody.regrade_request_id}`;
  }

  return urls;
}

// Helper function to build discussion notification footer with unsubscribe links
function buildDiscussionFooter(body: DiscussionThreadNotification, classId: number, recipientUserId: string): string {
  const appUrl = Deno.env.get("APP_URL");
  const courseUrl = `https://${appUrl}/course/${classId}`;
  const threadUrl = `https://${appUrl}/course/${classId}/discussion/${body.root_thread_id}`;
  const settingsUrl = `https://${appUrl}/course/${classId}`; // UserMenu opens notification settings

  const reason = body.notification_reason || (body.action === "new_post" ? "topic_follow" : "thread_watch");

  let explanation = "";
  const unsubscribeLinks: string[] = [];

  if (reason === "topic_follow") {
    explanation =
      "You received this email because you're following this discussion topic. You'll be notified of new posts in this topic, but not replies to existing posts.";
    if (body.topic_id) {
      unsubscribeLinks.push(`Unfollow topic: https://${appUrl}/course/${classId}/unsubscribe/topic/${body.topic_id}`);
    } else {
      // Fallback if topic_id is missing
      unsubscribeLinks.push(`Manage topic follows: ${courseUrl}/discussion`);
    }
  } else {
    explanation =
      "You received this email because you're following this discussion post. You'll be notified of all replies to this post.";
    unsubscribeLinks.push(
      `Unfollow post: https://${appUrl}/course/${classId}/unsubscribe/thread/${body.root_thread_id}`
    );
  }

  unsubscribeLinks.push(
    `Change notification settings: https://${appUrl}/course/${classId}?openNotificationSettings=true`
  );
  unsubscribeLinks.push(
    `Disable all discussion notifications: https://${appUrl}/course/${classId}?setDiscussionNotification=disabled`
  );

  return `\n\n---\n${explanation}\n\n${unsubscribeLinks.join("\n")}\n\nView post: ${threadUrl}`;
}

// Helper function to build final email content by replacing template variables
function buildEmailContent(
  template: { subject: string; body: string },
  body: NotificationEnvelope,
  courses: { name: string | null; slug: string | null; id: number }[],
  classId: number,
  userRoles: {
    user_id: string;
    class_section: string | null;
    lab_section_id: number | null;
    lab_section_name: string | null;
  }[],
  recipientUserId: string
): { subject: string; body: string } {
  let emailSubject = template.subject;
  let emailBody = template.body;

  // Replace basic template variables
  const variables = Object.keys(body);
  if ("subject" in body) {
    emailSubject = emailSubject.replaceAll("{subject}", body["subject" as keyof NotificationEnvelope]);
  }
  if ("body" in body) {
    emailBody = emailBody.replaceAll("{body}", body["body" as keyof NotificationEnvelope]);
  }

  for (const variable of variables) {
    emailSubject = emailSubject.replaceAll(`{${variable}}`, body[variable as keyof NotificationEnvelope]);
    emailBody = emailBody.replaceAll(`{${variable}}`, body[variable as keyof NotificationEnvelope]);
  }

  // Replace course information
  const course = courses.find((course) => course.id === classId);
  if (course?.slug) {
    emailBody = emailBody.replaceAll("{course_slug}", course.slug);
    emailSubject = emailSubject.replaceAll("{course_slug}", course.slug);
  }
  if (course?.name) {
    emailBody = emailBody.replaceAll("{course_name}", course.name);
    emailSubject = emailSubject.replaceAll("{course_name}", course.name);
  }

  // Replace URLs
  const urls = buildEmailUrls(body, classId);
  for (const [urlKey, urlValue] of Object.entries(urls)) {
    if (urlValue) {
      emailBody = emailBody.replaceAll(`{${urlKey}}`, urlValue);
      emailSubject = emailSubject.replaceAll(`{${urlKey}}`, urlValue);
    }
  }

  // Replace user-specific template variables
  const userRole = userRoles.find((role) => role.user_id === recipientUserId);
  if (userRole) {
    if (userRole.class_section) {
      emailBody = emailBody.replaceAll("{class_section}", String(userRole.class_section || ""));
      emailSubject = emailSubject.replaceAll("{class_section}", String(userRole.class_section || ""));
    }
    if (userRole.lab_section_name) {
      emailBody = emailBody.replaceAll("{lab_section}", String(userRole.lab_section_name || ""));
      emailSubject = emailSubject.replaceAll("{lab_section}", String(userRole.lab_section_name || ""));
    }
  }

  // Build and add discussion footer for discussion_thread notifications
  if (body.type === "discussion_thread") {
    const discussionBody = body as DiscussionThreadNotification;
    const footer = buildDiscussionFooter(discussionBody, classId, recipientUserId);
    emailBody = emailBody.replaceAll("{notification_footer}", footer);
  } else {
    // Remove footer placeholder if not a discussion notification
    emailBody = emailBody.replaceAll("{notification_footer}", "");
  }

  return { subject: emailSubject, body: emailBody };
}

// Helper function to find valid recipient
// Note: This should only be called for active (non-disabled) users.
// Disabled users should be filtered out before calling this function.
// Returns null if recipient not found - caller should handle this gracefully.
function findRecipient(
  emails: { email: string | null; user_id: string }[],
  notification: QueueMessage<Notification>,
  scope: Sentry.Scope
): { email: string | null; user_id: string } | null {
  const recipient = emails.find((email) => email.user_id === notification.message.user_id);
  if (!recipient) {
    // This should be rare - user passed disabled check but isn't in emails array
    // Don't log here - let the caller decide how to handle (they have more context)
    return null;
  }
  return recipient;
}

// Helper function to check if email is internal test email
function isInternalTestEmail(email: string): boolean {
  return email.toLowerCase().endsWith("@pawtograder.net");
}

// Classify notifications to handle help request digests and discussion digests
function classifyNotification(
  body: NotificationEnvelope,
  userId: string,
  classId: number,
  notificationPreferences?: Map<string, { discussion_notification?: string }>
): "help_request_created" | "discussion_digest" | "skip" | "standard" {
  // Skip system notifications - they should not generate emails
  if (body.type === "system") {
    return "skip";
  }

  if (body.type === "help_request") {
    const action = (body as unknown as { action?: string }).action;
    if (action === "created") return "help_request_created";
    return "skip";
  }

  if (body.type === "discussion_thread") {
    const prefs = notificationPreferences?.get(`${userId}|${classId}`);
    const discussionPref = prefs?.discussion_notification || "immediate";
    if (discussionPref === "digest") {
      return "discussion_digest";
    }
    if (discussionPref === "disabled") {
      return "skip";
    }
    // immediate - process as standard
    return "standard";
  }

  if ("help_queue_id" in body || "help_request_id" in body) {
    return "skip";
  }
  return "standard";
}

// Helper function to actually send the email
async function sendEmailViaTransporter(
  transporter: nodemailer.Transporter,
  recipient: string,
  subject: string,
  body: string,
  ccEmails: string[],
  replyTo: string | undefined,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    console.log(`Sending email to ${recipient} with subject ${subject}`);
    await transporter.sendMail({
      from: "Pawtograder <" + Deno.env.get("SMTP_FROM") + ">",
      to: recipient,
      cc: ccEmails,
      replyTo: replyTo ?? Deno.env.get("SMTP_REPLY_TO"),
      subject: subject,
      text: body
    });
    return true;
  } catch (error) {
    scope.setContext("smtp_error", {
      recipient: recipient,
      error_message: error instanceof Error ? error.message : String(error),
      smtp_host: Deno.env.get("SMTP_HOST"),
      smtp_port: Deno.env.get("SMTP_PORT")
    });
    Sentry.captureException(error, scope);
    console.error(`Error sending email: ${error}`);
    return false;
  }
}

// Helper function to archive message from queue
async function archiveMessage(
  adminSupabase: SupabaseClient<Database>,
  msgId: number,
  scope: Sentry.Scope
): Promise<void> {
  try {
    await adminSupabase.schema("pgmq_public").rpc("archive", {
      queue_name: "notification_emails",
      message_id: msgId
    });
  } catch (error) {
    scope.setContext("archive_error", {
      msg_id: msgId,
      error_message: error instanceof Error ? error.message : String(error)
    });
    Sentry.captureException(error, scope);
    console.error(`Failed to archive message ${msgId}: ${error}`);
  }
}

async function sendEmail(params: {
  adminSupabase: SupabaseClient<Database>;
  transporter: nodemailer.Transporter;
  notification: QueueMessage<Notification>;
  emails: { email: string | null; user_id: string }[];
  courses: { name: string | null; slug: string | null; id: number }[];
  userRoles: {
    user_id: string;
    class_section: string | null;
    lab_section_id: number | null;
    lab_section_name: string | null;
  }[];
  activeUserClassSet: Set<string>;
  scope: Sentry.Scope;
}) {
  const { adminSupabase, transporter, notification, emails, courses, userRoles, activeUserClassSet, scope } = params;

  let emailSent = false;
  let skipReason: string | null = null;

  try {
    // Set up Sentry scope context
    setupSentryScope(scope, notification);

    // Validate notification body
    const body = validateNotificationBody(notification, scope);
    if (!body) {
      skipReason = "invalid_notification_body";
      return;
    }

    // Extract CC emails
    const ccEmails = extractCCEmails(body);

    // Get and validate email template
    const template = getEmailTemplate(body, scope);
    if (!template) {
      skipReason = "invalid_email_template";
      return;
    }

    // CRITICAL: Check if user has an active (non-disabled) role in this specific class BEFORE looking up email
    // This prevents noisy error logs for disabled users
    const userClassKey = `${notification.message.user_id}|${notification.message.class_id}`;
    if (!activeUserClassSet.has(userClassKey)) {
      skipReason = "user_disabled_in_class";
      // Don't log to Sentry - this is expected behavior for disabled users
      return;
    }

    // Find recipient (only called if user is active)
    // Note: filteredEmails should contain this user since they passed the disabled check above
    const recipient = findRecipient(emails, notification, scope);
    if (!recipient || !recipient.email) {
      // This is unexpected - user is active but email not found
      // This could happen if user record doesn't exist or email is null
      skipReason = "no_valid_recipient";
      scope.setContext("missing_email_for_active_user", {
        user_id: notification.message.user_id,
        class_id: notification.message.class_id,
        filtered_emails_count: emails.length
      });
      return;
    }

    // Unless inbucket, skip internal test emails (but still archive them)
    if (isInternalTestEmail(recipient.email) && Deno.env.get("SMTP_PORT") !== "54325") {
      skipReason = "internal_test_email";
      return;
    }

    // Build email content
    const emailContent = buildEmailContent(
      template,
      body,
      courses,
      notification.message.class_id,
      userRoles,
      recipient.user_id
    );

    // Add email context to scope
    scope.setContext("email", {
      recipient: recipient.email,
      subject: emailContent.subject,
      cc_count: ccEmails.length,
      template_type: body.type
    });

    // Send email via transporter
    emailSent = await sendEmailViaTransporter(
      transporter,
      recipient.email,
      emailContent.subject,
      emailContent.body,
      ccEmails,
      body["reply_to" as keyof NotificationEnvelope],
      scope
    );

    if (!emailSent) {
      skipReason = "smtp_send_failed";
    }
  } catch (error) {
    // Log any unexpected errors with full scope
    scope.setContext("unexpected_error", {
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : undefined
    });
    Sentry.captureException(error, scope);
    console.error(`Unexpected error in sendEmail: ${error}`);
    skipReason = "unexpected_error";
  } finally {
    // ALWAYS archive the message, regardless of success or failure
    await archiveMessage(adminSupabase, notification.msg_id, scope);

    // Log to Sentry if email was not sent successfully
    if (!emailSent) {
      scope.setContext("email_not_sent", {
        reason: skipReason,
        msg_id: notification.msg_id,
        notification_id: notification.message.id,
        class_id: notification.message.class_id,
        user_id: notification.message.user_id
      });
      Sentry.captureMessage(`Email not sent: ${skipReason}`, scope);
    }
  }
}
/**
 * Process a batch of email notifications with proper error handling and batching.
 *
 * This function implements the same pattern as the gradebook batch processor:
 * 1. Reads messages from the queue in batches
 * 2. Processes emails with proper context fetching
 * 3. Archives completed messages
 * 4. Returns whether work was processed for polling decisions
 */
export async function processBatch(adminSupabase: ReturnType<typeof createClient<Database>>, scope: Sentry.Scope) {
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "notification_emails",
    sleep_seconds: 3600, // 1 hour
    n: 100 // Process up to 100 emails at once
  });

  if (result.error) {
    Sentry.captureException(result.error, scope);
    console.error("Queue read error:", result.error);
    return false;
  }

  scope.setTag("queue_length", result.data?.length || 0);
  if (result.data && result.data.length > 0) {
    //Fetch all context: emails and course names
    const notifications = result.data as QueueMessage<Notification>[];
    console.log(`Processing these NOTIFICATION IDs: ${notifications.map((msg) => msg.message.id).join(", ")}`);
    const uniqueEmails = new Set<string>();
    notifications.forEach((notification) => {
      uniqueEmails.add(notification.message.user_id);
    });
    const uniqueCourseIds = new Set<number>();
    notifications.forEach((notification) => {
      uniqueCourseIds.add(notification.message.class_id);
    });
    const { data: emails, error: emailsError } = await adminSupabase
      .schema("public")
      .from("users")
      .select("email, user_id")
      .in(
        "user_id",
        Array.from(uniqueEmails).filter((email) => email)
      );
    const { data: courses, error: coursesError } = await adminSupabase
      .schema("public")
      .from("classes")
      .select("name, id, slug")
      .in(
        "id",
        Array.from(uniqueCourseIds).filter((id) => id)
      );

    // Fetch user roles with class sections and lab sections
    // CRITICAL: Only fetch active (non-disabled) user roles to prevent sending emails to disabled users
    const { data: userRoles, error: userRolesError } = await adminSupabase
      .schema("public")
      .from("user_roles")
      .select(
        `
        user_id,
        class_id,
        class_section_id,
        lab_section_id,
        class_sections(name),
        lab_sections(name)
      `
      )
      .in(
        "user_id",
        Array.from(uniqueEmails).filter((email) => email)
      )
      .in(
        "class_id",
        Array.from(uniqueCourseIds).filter((id) => id)
      )
      .eq("disabled", false);

    if (emailsError) {
      scope.setContext("context_fetch_error", { type: "emails", unique_emails_count: uniqueEmails.size });
      Sentry.captureException(emailsError, scope);
      console.error(`Error fetching emails: ${emailsError?.message}`);
      return false;
    }
    if (coursesError) {
      scope.setContext("context_fetch_error", { type: "courses", unique_courses_count: uniqueCourseIds.size });
      Sentry.captureException(coursesError, scope);
      console.error(`Error fetching courses: ${coursesError?.message}`);
      return false;
    }
    if (userRolesError) {
      scope.setContext("context_fetch_error", {
        type: "user_roles",
        unique_emails_count: uniqueEmails.size,
        unique_courses_count: uniqueCourseIds.size
      });
      Sentry.captureException(userRolesError, scope);
      console.error(`Error fetching user roles: ${userRolesError?.message}`);
      return false;
    }

    // Transform user roles data to include section names
    const transformedUserRoles =
      userRoles?.map((role) => ({
        user_id: role.user_id,
        class_section: role.class_sections?.name || null,
        lab_section_id: role.lab_section_id,
        lab_section_name: role.lab_sections?.name || null
      })) || [];

    // Create a Set of active user_id+class_id combinations to filter emails
    // This ensures we only send emails to users who have active (non-disabled) roles in the relevant classes
    const activeUserClassSet = new Set<string>();
    if (userRoles) {
      for (const role of userRoles) {
        activeUserClassSet.add(`${role.user_id}|${role.class_id}`);
      }
    }

    // Filter emails to only include users who have active roles in the relevant classes
    const filteredEmails =
      emails?.filter((email) => {
        // Check if this user has an active role in any of the relevant classes
        return Array.from(uniqueCourseIds).some((classId) => activeUserClassSet.has(`${email.user_id}|${classId}`));
      }) || [];

    // Fetch notification preferences for discussion digest mode
    const { data: notificationPrefs, error: notificationPrefsError } = await adminSupabase
      .schema("public")
      .from("notification_preferences")
      .select("user_id, class_id, discussion_notification")
      .in(
        "user_id",
        Array.from(uniqueEmails).filter((email) => email)
      )
      .in(
        "class_id",
        Array.from(uniqueCourseIds).filter((id) => id)
      );

    if (notificationPrefsError) {
      scope.setContext("context_fetch_error", {
        type: "notification_preferences",
        unique_emails_count: uniqueEmails.size,
        unique_courses_count: uniqueCourseIds.size
      });
      Sentry.captureException(notificationPrefsError, scope);
      console.error(`Error fetching notification preferences: ${notificationPrefsError?.message}`);
      // Continue processing without preferences (will default to immediate)
    }

    // Build map of notification preferences for quick lookup
    const notificationPrefsMap = new Map<string, { discussion_notification?: string }>();
    for (const pref of notificationPrefs || []) {
      const key = `${pref.user_id}|${pref.class_id}`;
      notificationPrefsMap.set(key, { discussion_notification: pref.discussion_notification });
    }

    if (!Deno.env.get("SMTP_HOST") || Deno.env.get("SMTP_HOST") === "") {
      // eslint-disable-next-line no-console
      console.log("No SMTP host found, deferring email processing");
      // Do not archive; allow messages to become visible again after VT expires.
      return false;
    }
    const isInbucketEmail = Deno.env.get("SMTP_PORT") === "54325";
    const transporter = nodemailer.createTransport({
      pool: true,
      host: Deno.env.get("SMTP_HOST") || "",
      port: parseInt(Deno.env.get("SMTP_PORT") || "465"),
      secure: isInbucketEmail ? false : true, // use TLS
      ignoreTLS: isInbucketEmail,
      auth: {
        user: Deno.env.get("SMTP_USER") || "",
        pass: Deno.env.get("SMTP_PASSWORD") || ""
      }
    });

    // Partition notifications for special handling of help request creation and discussion digests
    const helpCreated: QueueMessage<Notification>[] = [];
    const discussionDigest: QueueMessage<Notification>[] = [];
    const standard: QueueMessage<Notification>[] = [];
    for (const n of notifications) {
      const body = n.message.body as NotificationEnvelope | null;
      if (!body) {
        standard.push(n);
        continue;
      }
      const kind = classifyNotification(body, n.message.user_id as string, n.message.class_id, notificationPrefsMap);
      if (kind === "help_request_created") helpCreated.push(n);
      else if (kind === "discussion_digest") discussionDigest.push(n);
      else if (kind === "standard") standard.push(n);
      else {
        // Archive skipped notifications to prevent reprocessing
        await archiveMessage(adminSupabase, n.msg_id, scope);
      }
    }

    // Build batched digests for help request creation per user and class
    type DigestItem = {
      help_request_id: number;
      help_queue_name: string;
      creator_name: string;
      request_subject?: string;
      request_body?: string;
      help_request_url?: string;
    };
    const digests = new Map<string, { user_id: string; class_id: number; items: DigestItem[]; msg_ids: number[] }>();
    for (const n of helpCreated) {
      const body = n.message.body as unknown as NotificationEnvelope & {
        action: string;
        help_request_id: number;
        help_queue_name?: string;
        creator_name?: string;
        request_subject?: string;
        request_body?: string;
      };
      const key = `${n.message.user_id}|${n.message.class_id}`;
      if (!digests.has(key)) {
        digests.set(key, {
          user_id: n.message.user_id as string,
          class_id: n.message.class_id as number,
          items: [],
          msg_ids: []
        });
      }
      const entry = digests.get(key)!;
      if (!entry.items.some((it) => it.help_request_id === body.help_request_id)) {
        const urls = buildEmailUrls(body, n.message.class_id);
        entry.items.push({
          help_request_id: body.help_request_id,
          help_queue_name: body.help_queue_name || "",
          creator_name: body.creator_name || "",
          request_subject: body.request_subject,
          request_body: body.request_body,
          help_request_url: urls.help_request_url
        });
      }
      entry.msg_ids.push(n.msg_id);
    }

    // Helper to find recipient by user_id and class_id
    // Only returns recipient if they have an active (non-disabled) role in that class
    const recipientByUserId = (userId: string, classId: number) => {
      const key = `${userId}|${classId}`;
      if (!activeUserClassSet.has(key)) {
        return null; // User is disabled in this class
      }
      return filteredEmails?.find((e) => e.user_id === userId) || null;
    };

    // Send digests
    for (const { user_id, class_id, items, msg_ids } of digests.values()) {
      const recipient = recipientByUserId(user_id, class_id);
      const course = courses?.find((c) => c.id === class_id);
      type MaybeClonableScope = { clone?: () => Sentry.Scope };
      const baseScope = scope as unknown as MaybeClonableScope;
      const emailScope: Sentry.Scope = typeof baseScope.clone === "function" ? baseScope.clone!() : new Sentry.Scope();
      emailScope.setTag("digest", "help_request_created");
      emailScope.setContext("digest_meta", { user_id, class_id, count: items.length });

      if (!recipient || !recipient.email) {
        // User is disabled or has no email - archive and skip
        await Promise.all(msg_ids.map((id) => archiveMessage(adminSupabase, id, emailScope)));
        continue;
      }
      if (isInternalTestEmail(recipient.email) && !isInbucketEmail) {
        await Promise.all(msg_ids.map((id) => archiveMessage(adminSupabase, id, emailScope)));
        continue;
      }

      const subject = `${course?.name || "Course"} - Help requests digest (${items.length})`;
      const lines: string[] = [];
      lines.push(`You have ${items.length} new help request(s).`);
      lines.push("");
      for (const it of items) {
        const title = `${it.creator_name || "Student"}: ${it.request_subject || "General"}`;
        const queue = it.help_queue_name ? ` [${it.help_queue_name}]` : "";
        const urlLine = it.help_request_url ? `\n  ${it.help_request_url}` : "";
        lines.push(`- ${title}${queue}${urlLine}`);
      }
      const bodyText = lines.join("\n");

      const sent = await sendEmailViaTransporter(
        transporter,
        recipient.email,
        subject,
        bodyText,
        [],
        undefined,
        emailScope
      );
      if (!sent) {
        emailScope.setContext("email_not_sent", { reason: "smtp_send_failed", user_id, class_id, count: items.length });
        Sentry.captureMessage("Digest email not sent", emailScope);
        // do not archive on failed send; allow retry via queue visibility timeout
        continue;
      }

      await Promise.all(msg_ids.map((id) => archiveMessage(adminSupabase, id, emailScope)));
    }

    // Store discussion digest items in database for hourly batching
    // Archive queue messages immediately, but store items for later sending
    for (const n of discussionDigest) {
      const body = n.message.body as DiscussionThreadNotification;
      const urls = buildEmailUrls(body, n.message.class_id);

      // Store digest item in database
      const { error: insertError } = await adminSupabase
        .schema("public")
        .from("discussion_digest_items")
        .insert({
          user_id: n.message.user_id as string,
          class_id: n.message.class_id as number,
          thread_id: body.root_thread_id,
          thread_name: body.thread_name || "Untitled",
          author_name: body.reply_author_name || "Unknown",
          teaser: body.teaser,
          thread_url: urls.thread_url,
          topic_id: body.topic_id,
          notification_reason: body.notification_reason,
          action: body.action,
          msg_id: n.msg_id
        });

      if (insertError) {
        // If duplicate (same thread_id within same second), that's okay - skip
        if (insertError.code !== "23505") {
          // Not a unique constraint violation - log the error
          scope.setContext("digest_item_insert_error", {
            msg_id: n.msg_id,
            user_id: n.message.user_id,
            class_id: n.message.class_id,
            error: insertError.message
          });
          Sentry.captureException(insertError, scope);
          // Don't archive on failure - allow retry via queue visibility timeout
          continue;
        }
      }

      // Archive the queue message immediately (item is stored in DB)
      type MaybeClonableScope = { clone?: () => Sentry.Scope };
      const baseScope = scope as unknown as MaybeClonableScope;
      const emailScope: Sentry.Scope = typeof baseScope.clone === "function" ? baseScope.clone!() : new Sentry.Scope();
      await archiveMessage(adminSupabase, n.msg_id, emailScope);
    }

    // Check for digest items ready to send (hourly)
    // Find user/class combinations where:
    // 1. There are digest items, AND
    // 2. Either no previous send time exists, OR last send was more than 1 hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Get distinct user/class combinations that have digest items
    const { data: allDigestItems, error: digestQueryError } = await adminSupabase
      .schema("public")
      .from("discussion_digest_items")
      .select("user_id, class_id");

    // Get unique user/class combinations
    const uniqueCombos = new Map<string, { user_id: string; class_id: number }>();
    if (allDigestItems) {
      for (const item of allDigestItems) {
        const key = `${item.user_id}|${item.class_id}`;
        if (!uniqueCombos.has(key)) {
          uniqueCombos.set(key, { user_id: item.user_id, class_id: item.class_id });
        }
      }
    }
    const readyDigests = Array.from(uniqueCombos.values());

    if (digestQueryError) {
      scope.setContext("digest_query_error", { error: digestQueryError.message });
      Sentry.captureException(digestQueryError, scope);
      console.error(`Error querying digest items: ${digestQueryError.message}`);
    } else if (readyDigests && readyDigests.length > 0) {
      // Check each user/class combination to see if it's time to send
      for (const { user_id, class_id } of readyDigests) {
        // Get last send time for this user/class
        const { data: lastSend } = await adminSupabase
          .schema("public")
          .from("discussion_digest_send_times")
          .select("last_sent_at")
          .eq("user_id", user_id)
          .eq("class_id", class_id)
          .single();

        const shouldSend = !lastSend || new Date(lastSend.last_sent_at) < new Date(oneHourAgo);

        if (shouldSend) {
          // Fetch all digest items for this user/class
          const { data: digestItems, error: itemsError } = await adminSupabase
            .schema("public")
            .from("discussion_digest_items")
            .select("*")
            .eq("user_id", user_id)
            .eq("class_id", class_id)
            .order("created_at", { ascending: true });

          if (itemsError || !digestItems || digestItems.length === 0) {
            if (itemsError) {
              scope.setContext("digest_items_fetch_error", {
                user_id,
                class_id,
                error: itemsError.message
              });
              Sentry.captureException(itemsError, scope);
            }
            continue;
          }

          // Send the digest
          const recipient = recipientByUserId(user_id, class_id);
          const course = courses?.find((c) => c.id === class_id);
          type MaybeClonableScope = { clone?: () => Sentry.Scope };
          const baseScope = scope as unknown as MaybeClonableScope;
          const emailScope: Sentry.Scope =
            typeof baseScope.clone === "function" ? baseScope.clone!() : new Sentry.Scope();
          emailScope.setTag("digest", "discussion_thread");
          emailScope.setContext("digest_meta", { user_id, class_id, count: digestItems.length });

          if (!recipient || !recipient.email) {
            // User is disabled or has no email - delete items anyway
            await adminSupabase
              .schema("public")
              .from("discussion_digest_items")
              .delete()
              .eq("user_id", user_id)
              .eq("class_id", class_id);
            continue;
          }

          if (isInternalTestEmail(recipient.email) && !isInbucketEmail) {
            // Skip internal test emails - delete items
            await adminSupabase
              .schema("public")
              .from("discussion_digest_items")
              .delete()
              .eq("user_id", user_id)
              .eq("class_id", class_id);
            continue;
          }

          const subject = `${course?.name || "Course"} - Discussion digest (${digestItems.length})`;
          const lines: string[] = [];
          lines.push(`You have ${digestItems.length} new discussion notification(s) from the past hour.`);
          lines.push("");

          // Group by notification reason
          const topicFollows = digestItems.filter((it) => it.notification_reason === "topic_follow");
          const threadWatches = digestItems.filter((it) => it.notification_reason === "thread_watch");

          if (topicFollows.length > 0) {
            lines.push(`New posts in topics you follow (${topicFollows.length}):`);
            for (const it of topicFollows) {
              const teaser = it.teaser ? ` - ${it.teaser}` : "";
              const urlLine = it.thread_url ? `\n  ${it.thread_url}` : "";
              lines.push(`- ${it.thread_name} by ${it.author_name}${teaser}${urlLine}`);
            }
            lines.push("");
          }

          if (threadWatches.length > 0) {
            lines.push(`Replies to posts you follow (${threadWatches.length}):`);
            for (const it of threadWatches) {
              const teaser = it.teaser ? ` - ${it.teaser}` : "";
              const urlLine = it.thread_url ? `\n  ${it.thread_url}` : "";
              lines.push(`- ${it.thread_name} by ${it.author_name}${teaser}${urlLine}`);
            }
            lines.push("");
          }

          // Add footer with unsubscribe links
          const appUrl = Deno.env.get("APP_URL");
          const courseUrl = `https://${appUrl}/course/${class_id}`;
          lines.push("---");
          lines.push("You received this hourly digest because you have discussion notifications set to 'digest' mode.");
          lines.push(`Change notification settings: ${courseUrl}`);
          lines.push(`View all discussions: ${courseUrl}/discussion`);

          const bodyText = lines.join("\n");

          const sent = await sendEmailViaTransporter(
            transporter,
            recipient.email,
            subject,
            bodyText,
            [],
            undefined,
            emailScope
          );

          if (sent) {
            // Update last send time
            await adminSupabase.schema("public").from("discussion_digest_send_times").upsert({
              user_id,
              class_id,
              last_sent_at: new Date().toISOString()
            });

            // Delete sent items
            await adminSupabase
              .schema("public")
              .from("discussion_digest_items")
              .delete()
              .eq("user_id", user_id)
              .eq("class_id", class_id);
          } else {
            emailScope.setContext("email_not_sent", {
              reason: "smtp_send_failed",
              user_id,
              class_id,
              count: digestItems.length
            });
            Sentry.captureMessage("Discussion digest email not sent", emailScope);
            // Don't delete items on failure - will retry next batch
          }
        }
      }
    }

    // Process standard notifications in parallel
    await Promise.all(
      standard.map((notification) => {
        type MaybeClonableScope = { clone?: () => Sentry.Scope };
        const baseScope = scope as unknown as MaybeClonableScope;
        const emailScope: Sentry.Scope =
          typeof baseScope.clone === "function" ? baseScope.clone!() : new Sentry.Scope();
        emailScope.setTag("msg_id", notification.msg_id);
        return sendEmail({
          adminSupabase,
          transporter,
          notification,
          emails: filteredEmails,
          courses,
          userRoles: transformedUserRoles,
          activeUserClassSet,
          scope: emailScope
        });
      })
    );

    return true; // Work was processed
  } else {
    // No messages in queue
    return false;
  }
}

export async function runBatchHandler() {
  const scope = new Sentry.Scope();
  scope.setTag("function", "notification_queue_processor");

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let isRunning = true;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  // Handle graceful shutdown
  const controller = new AbortController();
  const shutdownHandler = () => {
    console.log("Received shutdown signal, stopping email batch handler...");
    isRunning = false;
    controller.abort();
  };

  // Listen for termination signals (if supported in edge runtime)
  try {
    Deno.addSignalListener("SIGINT", shutdownHandler);
    Deno.addSignalListener("SIGTERM", shutdownHandler);
  } catch (e) {
    console.error("Error adding signal listeners:", e);
    // Signal listeners might not be available in edge runtime
    console.log("Signal listeners not available in this environment");
  }

  while (isRunning) {
    try {
      const hasWork = await processBatch(adminSupabase, scope);
      consecutiveErrors = 0; // Reset error count on successful processing

      // If there was work, check again immediately, otherwise wait 15 seconds
      if (!hasWork) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    } catch (error) {
      consecutiveErrors++;
      scope.setTag("consecutive_errors", consecutiveErrors);
      console.error(`Email batch processing error (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
      Sentry.captureException(error, scope);

      if (consecutiveErrors >= maxConsecutiveErrors) {
        Sentry.captureMessage("Too many consecutive errors, stopping email batch handler", scope);
        console.error("Too many consecutive errors, stopping email batch handler");
        break;
      }

      // Wait before retrying on error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  console.log("Email batch handler stopped");
}

Deno.serve((req) => {
  const headers = req.headers;
  const secret = headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
  if (secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Invalid secret" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  EdgeRuntime.waitUntil(runBatchHandler());

  // Return immediately to acknowledge the start request
  return Promise.resolve(
    new Response(
      JSON.stringify({
        message: "Email batch handler started",
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    )
  );
});
