import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { emailTemplates } from "./emailTemplates.ts";
import { Notification } from "../_shared/FunctionTypes.d.ts";
import nodemailer from "npm:nodemailer";

export type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
}
export type NotificationEnvelope = {
  type: string;
}
export type DiscussionThreadNotification = NotificationEnvelope & {
  type: "discussion_thread";
  new_comment_number: number;
  new_comment_id: number;
  root_thread_id: number;
  reply_author_profile_id: string;
  teaser: string;

  thread_name: string;
  reply_author_name: string;
}

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
}

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
}

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
}

async function sendEmail(params: {
  adminSupabase: SupabaseClient<Database>,
  transporter: nodemailer.Transporter,
  notification: QueueMessage<Notification>,
  emails: { email: string | null, user_id: string }[],
  courses: { name: string | null, slug: string | null, id: number }[]
}) {
  const { adminSupabase, transporter, notification, emails, courses } = params;

  if (!notification.message.body) {
    console.error(`No body found for notification ${notification.message.id}`);
    return;
  }
  const body = notification.message.body as NotificationEnvelope;
  let emailTemplate = emailTemplates[body.type as keyof typeof emailTemplates];
  if (!emailTemplate) {
    console.error(`No email template found for notification type ${body.type}`);
    return;
  }
  if ('action' in body) {
    emailTemplate = emailTemplate[body.action as keyof typeof emailTemplate];
  }
  if (!('subject' in emailTemplate)) {
    console.error(`No subject found for email template ${body.type}`);
    return;
  }
  if (!('body' in emailTemplate)) {
    console.error(`No body found for email template ${body.type}`);
    return;
  }
  let emailSubject = emailTemplate.subject as string;
  let emailBody = emailTemplate.body as string;
  //Fill in the variables using the keys of body
  const variables = Object.keys(body);
  for (const variable of variables) {
    emailSubject = emailSubject.replace(`{${variable}}`, body[variable as keyof NotificationEnvelope]);
    emailBody = emailBody.replace(`{${variable}}`, body[variable as keyof NotificationEnvelope]);
  }
  //Replace course_slug and course_name
  const course_slug = courses.find((course) => course.id === notification.message.class_id)?.slug;
  const course_name = courses.find((course) => course.id === notification.message.class_id)?.name;
  if ('assignment_id' in body) {
    // Build the assignment link
    const assignment_link = `https://${Deno.env.get('APP_URL')}/course/${notification.message.class_id}/assignments/${body.assignment_id}`;
    emailBody = emailBody.replace('{assignment_url}', assignment_link);
    emailSubject = emailSubject.replace('{assignment_url}', assignment_link);
  }
  if (course_slug) {
    emailBody = emailBody.replace('{course_slug}', course_slug);
    emailSubject = emailSubject.replace('{course_slug}', course_slug);
  }
  if (course_name) {
    emailBody = emailBody.replace('{course_name}', course_name);
    emailSubject = emailSubject.replace('{course_name}', course_name);
  }
  if('root_thread_id' in body)
  {
    const thread_url = `https://${Deno.env.get('APP_URL')}/course/${notification.message.class_id}/discussion/${body.root_thread_id}`;
    emailBody = emailBody.replace('{thread_url}', thread_url);
    emailSubject = emailSubject.replace('{thread_url}', thread_url);
  }
  const recipient = emails.find((email) => email.email);
  if (!recipient) {
    console.error(`No recipient found for notification ${notification.msg_id}, ${JSON.stringify(notification)}`);
    return;
  }
  try {
    console.log(`Sending email to ${recipient.email}`);
    console.log(transporter);
    await transporter.sendMail({
      from: 'Pawtograder <' + Deno.env.get('SMTP_FROM') + '>',
      to: recipient.email,
      replyTo: Deno.env.get('SMTP_REPLY_TO'),
      subject: emailSubject,
      text: emailBody,
    });
  } catch (error) {
    console.error(`Error sending email: ${error}`);
    return;
  }
  console.log(`Email sent to ${recipient.email}`);
  await adminSupabase.schema('pgmq_public').rpc('archive', {
    queue_name: 'notification_emails',
    message_id: notification.msg_id,
  });
}
async function processNotificationQueue() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const result = await adminSupabase.schema('pgmq_public').rpc('read', {
    queue_name: 'notification_emails',
    sleep_seconds: 5,
    n: 20,
  });
  if (result.data) {
    //Fetch all context: emails and course names
    const notifications = result.data as { message: Notification }[];
    const uniqueEmails = new Set<string>();
    notifications.forEach((notification) => {
      uniqueEmails.add(notification.message.user_id);
    });
    const uniqueCourseIds = new Set<number>();
    notifications.forEach((notification) => {
      uniqueCourseIds.add(notification.message.class_id);
    });
    const { data: emails, error: emailsError } = await adminSupabase.schema('public').from('users').select('email, user_id').in('user_id', Array.from(uniqueEmails).filter((email) => email));
    const { data: courses, error: coursesError } = await adminSupabase.schema('public').from('classes').select('name, id, slug').in('id', Array.from(uniqueCourseIds).filter((id) => id));
    if (emailsError) {
      console.error(`Error fetching emails: ${emailsError?.message}`);
      return;
    }
    if (coursesError) {
      console.error(`Error fetching courses: ${coursesError?.message}`);
      return;
    }
    const transporter = nodemailer.createTransport({
      pool: false,
      host: Deno.env.get('SMTP_HOST') || '',
      port: parseInt(Deno.env.get('SMTP_PORT') || '465'),
      secure: false, // use TLS
      auth: {
        user: Deno.env.get('SMTP_USER') || '',
        pass: Deno.env.get('SMTP_PASSWORD') || '',
      },
    });
    await Promise.all(result.data.map((notification) => sendEmail({ adminSupabase, transporter, notification: (notification as QueueMessage<Notification>), emails, courses })));
  }
}
Deno.serve(async (req) => {
  await processNotificationQueue();
  return new Response(
    JSON.stringify({}),
    { headers: { "Content-Type": "application/json" } },
  )
})
