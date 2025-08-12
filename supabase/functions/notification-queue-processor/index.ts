import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { emailTemplates } from "./emailTemplates.ts";
import { Notification } from "../_shared/FunctionTypes.d.ts";
import nodemailer from "npm:nodemailer";
import * as Sentry from "npm:@sentry/deno";

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("SUPABASE_URL")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0
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
  scope: Sentry.Scope;
}) {
  const { adminSupabase, transporter, notification, emails, courses, userRoles, scope } = params;

  // Set up Sentry scope context
  scope.setTag("notification_id", notification.message.id);
  scope.setTag("class_id", notification.message.class_id);
  scope.setTag("user_id", notification.message.user_id);
  scope.setContext("notification", {
    msg_id: notification.msg_id,
    notification_id: notification.message.id,
    class_id: notification.message.class_id,
    user_id: notification.message.user_id
  });

  if (!notification.message.body) {
    const error = new Error(`No body found for notification ${notification.message.id}`);
    scope.setContext("error_details", { missing: "notification.message.body" });
    Sentry.captureException(error, scope);
    console.error(`No body found for notification ${notification.message.id}`);
    return;
  }
  const body = notification.message.body as NotificationEnvelope;
  const cc_emails: string[] = [];
  if ("cc_emails" in body) {
    const data = body.cc_emails as { emails: string[] };
    data.emails.forEach((email) => cc_emails.push(email));
  }

  let emailTemplate = emailTemplates[body.type as keyof typeof emailTemplates];
  if (!emailTemplate) {
    const error = new Error(`No email template found for notification type ${body.type}`);
    scope.setContext("error_details", { missing_template_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No email template found for notification type ${body.type}`);
    return;
  }
  if ("action" in body) {
    emailTemplate = emailTemplate[body.action as keyof typeof emailTemplate];
  }
  if (!("subject" in emailTemplate)) {
    const error = new Error(`No subject found for email template ${body.type}`);
    scope.setContext("error_details", { missing_subject_for_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No subject found for email template ${body.type}`);
    return;
  }
  if (!("body" in emailTemplate)) {
    const error = new Error(`No body found for email template ${body.type}`);
    scope.setContext("error_details", { missing_body_for_type: body.type });
    Sentry.captureException(error, scope);
    console.error(`No body found for email template ${body.type}`);
    return;
  }
  let emailSubject = emailTemplate.subject as string;
  let emailBody = emailTemplate.body as string;
  //Fill in the variables using the keys of body
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
  //Replace course_slug and course_name
  const course_slug = courses.find((course) => course.id === notification.message.class_id)?.slug;
  const course_name = courses.find((course) => course.id === notification.message.class_id)?.name;
  if ("assignment_id" in body) {
    // Build the assignment link
    const assignment_link = `https://${Deno.env.get("APP_URL")}/course/${notification.message.class_id}/assignments/${body.assignment_id}`;
    emailBody = emailBody.replaceAll("{assignment_url}", assignment_link);
    emailSubject = emailSubject.replaceAll("{assignment_url}", assignment_link);
  }
  if (course_slug) {
    emailBody = emailBody.replaceAll("{course_slug}", course_slug);
    emailSubject = emailSubject.replaceAll("{course_slug}", course_slug);
  }
  if (course_name) {
    emailBody = emailBody.replaceAll("{course_name}", course_name);
    emailSubject = emailSubject.replaceAll("{course_name}", course_name);
  }
  if ("root_thread_id" in body) {
    const thread_url = `https://${Deno.env.get("APP_URL")}/course/${notification.message.class_id}/discussion/${body.root_thread_id}`;
    emailBody = emailBody.replaceAll("{thread_url}", thread_url);
    emailSubject = emailSubject.replaceAll("{thread_url}", thread_url);
  }
  if (body.type === "course_enrollment") {
    // Build the course link
    const course_url = `https://${Deno.env.get("APP_URL")}/course/${notification.message.class_id}`;
    emailBody = emailBody.replaceAll("{course_url}", course_url);
    emailSubject = emailSubject.replaceAll("{course_url}", course_url);
  }
  const recipient = emails.find((email) => email.email);
  if (!recipient) {
    const error = new Error(`No recipient found for notification ${notification.msg_id}`);
    scope.setContext("error_details", {
      notification_msg_id: notification.msg_id,
      available_emails: emails.length,
      notification: notification
    });
    Sentry.captureException(error, scope);
    console.error(`No recipient found for notification ${notification.msg_id}, ${JSON.stringify(notification)}`);
    return;
  }

  // Skip sending/logging for internal test emails and archive the message
  const recipientEmailLower = recipient.email?.toLowerCase() ?? "";
  if (recipientEmailLower.endsWith("@pawtograder.net")) {
    await adminSupabase.schema("pgmq_public").rpc("archive", {
      queue_name: "notification_emails",
      message_id: notification.msg_id
    });
    return;
  }

  // Replace user-specific template variables
  const userRole = userRoles.find((role) => role.user_id === recipient.user_id);
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
  // Add email context to scope
  scope.setContext("email", {
    recipient: recipient.email,
    subject: emailSubject,
    cc_count: cc_emails.length,
    template_type: body.type
  });

  try {
    console.log(`Sending email to ${recipient.email}`);
    console.log(transporter);
    await transporter.sendMail({
      from: "Pawtograder <" + Deno.env.get("SMTP_FROM") + ">",
      to: recipient.email,
      cc: cc_emails,
      replyTo: body["reply_to" as keyof NotificationEnvelope] ?? Deno.env.get("SMTP_REPLY_TO"),
      subject: emailSubject,
      text: emailBody
    });
  } catch (error) {
    scope.setContext("smtp_error", {
      recipient: recipient.email,
      error_message: error instanceof Error ? error.message : String(error),
      smtp_host: Deno.env.get("SMTP_HOST"),
      smtp_port: Deno.env.get("SMTP_PORT")
    });
    Sentry.captureException(error, scope);
    console.error(`Error sending email: ${error}`);
    return;
  }
  console.log(`Email sent to ${recipient.email}`);
  await adminSupabase.schema("pgmq_public").rpc("archive", {
    queue_name: "notification_emails",
    message_id: notification.msg_id
  });
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
    sleep_seconds: 30, // Longer sleep for email processing
    n: 100 // Process up to 100 emails at once
  });

  if (result.error) {
    Sentry.captureException(result.error, scope);
    console.error("Queue read error:", result.error);
    return false;
  }

  scope.setTag("queue_length", result.data?.length || 0);
  if (result.data && result.data.length > 0) {
    console.log(`Processing ${result.data.length} email notifications`);

    //Fetch all context: emails and course names
    const notifications = result.data as QueueMessage<Notification>[];
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
    const { data: userRoles, error: userRolesError } = await adminSupabase
      .schema("public")
      .from("user_roles")
      .select(
        `
        user_id,
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
      );

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

    const transporter = nodemailer.createTransport({
      pool: false,
      host: Deno.env.get("SMTP_HOST") || "",
      port: parseInt(Deno.env.get("SMTP_PORT") || "465"),
      secure: true, // use TLS
      auth: {
        user: Deno.env.get("SMTP_USER") || "",
        pass: Deno.env.get("SMTP_PASSWORD") || ""
      }
    });

    // Process emails in parallel
    await Promise.all(
      notifications.map((notification) => {
        // Create a new scope for each email to isolate context
        const emailScope = scope.clone();
        emailScope.setTag("msg_id", notification.msg_id);
        return sendEmail({
          adminSupabase,
          transporter,
          notification,
          emails,
          courses,
          userRoles: transformedUserRoles,
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
        console.log("No emails to process, waiting 15 seconds before next poll...");
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
