/**
 * Variables:
 * {course_name} - The name of the course
 */
export const emailTemplates = {
  /**
   * Assignment group variables:
   * {assignment_group_name} - The name of the assignment group
   * {assignment_name} - The name of the assignment
   * {assignment_url} - The URL of the assignment
   * {inviter_name} - The name of the inviter
   * {group_name} - The name of the group
   * {requestor_name} - The name of the requestor
   * {decision_maker_name} - The name of the decision maker
   * {status} - The status of the request
   *
   * Emailer variables:
   * {assignment_group_name} - The name of the assignment group
   * {assignemnt_name} - The name of the assignment group
   * {assignment_slug} - The slug of the assignment
   * {body} - The general body of the email, which may contain additional variables
   * {due_date} - The due date of the assignment for this student at time of email sent
   */
  assignment_group_member: {
    join: {
      subject: "{course_name} - You've been added to group {assignment_group_name} for assignment {assignment_name}",
      body: "You've been added to a group for assignment {assignment_name}. Read more details in Pawtograder at {assignment_url}"
    },
    leave: {
      subject:
        "{course_name} - You've been removed from group {assignment_group_name} for assignment {assignment_name}",
      body: "You've been removed from a group for assignment {assignment_name}. Read more details in Pawtograder at {assignment_url}"
    }
  },
  assignment_group_invitations: {
    create: {
      subject:
        "{course_name} - You've been invited by {inviter_name} to join group {assignment_group_name} for assignment {assignment_name}",
      body: "You've been invited by {inviter_name} to join a group for assignment {assignment_name}. Read more details in Pawtograder at {assignment_url}"
    }
  },
  assignment_group_join_request: {
    create: {
      subject:
        "{course_name} - {requestor_name} has requested to join group {assignment_group_name} for assignment {assignment_name}",
      body: "{requestor_name} has requested to join a group for assignment {assignment_name}. Read more details in Pawtograder at {assignment_url}"
    },
    update: {
      subject:
        "{course_name} - Update on {requestor_name}'s request to join {assignment_group_name} for assignment {assignment_name}",
      body: "{decision_maker_name} has updated {requestor_name}'s request to join {assignment_group_name} for assignment {assignment_name}, the current status is {status}. Read more details in Pawtograder at {assignment_url}"
    }
  },
  /**
   * Discussion thread variables:
   * {thread_name} - The name of the thread
   * {reply_author_name} - The name of the reply author
   * {thread_url} - The URL of the thread
   */
  discussion_thread: {
    reply: {
      subject: "{course_name} - {thread_name} has a new reply from {reply_author_name}",
      body: "{reply_author_name} has replied to your post in {thread_name}. Read more details in Pawtograder at {thread_url}"
    }
  },
  email: {
    create: {
      subject: "{course_name} - {subject}",
      body: "{body}"
    }
  }
};
