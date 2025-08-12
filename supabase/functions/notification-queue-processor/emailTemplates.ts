/**
 * Variables:
 * {course_name} - The name of the course
 * {class_section} - The name of the student's class section (user-specific)
 * {lab_section} - The name of the student's lab section (user-specific)
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
   * {subject} - The slug of the assignment
   * {body} - The general body of the email, which may contain additional variables
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
  },
  /**
   * Course enrollment variables:
   * {course_name} - The name of the course
   * {course_url} - The URL of the course
   * {inviter_name} - The name of the person who added them
   * {inviter_email} - The email of the person who added them
   */
  course_enrollment: {
    create: {
      subject: "You've been added to {course_name} on Pawtograder",
      body: 'Hello!\n\n{inviter_name} ({inviter_email}) has added you to the course "{course_name}" on Pawtograder.\n\nYou can access the course here: {course_url}\n\nIf you have any questions, please contact {inviter_name} or your course instructor.\n\nWelcome to Pawtograder!'
    }
  },
  /**
   * Help request variables:
   * {help_queue_name} - The name of the help queue
   * {creator_name} - The name of the student who created the request
   * {assignee_name} - The name of the staff member assigned (if any)
   * {status} - The status of the request
   * {request_preview} - A short preview of the request text
   * {help_request_url} - Direct link to the help request
   * {help_queue_url} - Link to the help queue
   */
  help_request: {
    created: {
      subject: "{course_name} - New help request in {help_queue_name}",
      body: "{creator_name} created a new help request.\n\nSubject: {request_subject}\n\n{request_body}\n\nOpen it in Pawtograder at {help_request_url}"
    },
    assigned: {
      subject: "{course_name} - Help request assigned in {help_queue_name}",
      body: "{assignee_name} is now working on {creator_name}'s help request.\n\nSubject: {request_subject}\n\n{request_body}\n\nOpen it in Pawtograder at {help_request_url}"
    },
    status_changed: {
      subject: "{course_name} - Help request in {help_queue_name} updated to {status}",
      body: "Help request by {creator_name} is now {status}.\n\nSubject: {request_subject}\n\n{request_body}\n\nOpen it in Pawtograder at {help_request_url}"
    }
  },
  /**
   * Help request message variables:
   * {help_queue_name} - The name of the help queue
   * {author_name} - The name of the message author
   * {help_request_creator_name} - The name of the original help request creator
   * {help_request_url} - Direct link to the help request
   */
  help_request_message: {
    subject: "{course_name} - New message in help request ({help_queue_name})",
    body: "{author_name} replied to {help_request_creator_name}'s help request. Read more details in Pawtograder at {help_request_url}"
  },
  /**
   * Regrade request variables:
   * {action} - One of comment_challenged | status_change | escalated | new_comment
   * {new_status} - New status when applicable
   * {assignment_url} - Link to the related assignment (when available)
   * {course_url} - Fallback link to the course
   */
  regrade_request: {
    comment_challenged: {
      subject: "{course_name} - A regrade request has been opened",
      body: "{opened_by_name} opened a regrade request on your grading comment. Read more details in Pawtograder at {assignment_url}"
    },
    status_change: {
      subject: "{course_name} - Regrade request status updated to {new_status}",
      body: "{updated_by_name} updated a regrade request to {new_status}. Read more details in Pawtograder at {assignment_url}"
    },
    escalated: {
      subject: "{course_name} - Regrade request escalated",
      body: "{escalated_by_name} escalated a regrade request. Read more details in Pawtograder at {assignment_url}"
    },
    new_comment: {
      subject: "{course_name} - New comment on a regrade request",
      body: "{comment_author_name} commented on a regrade request you're involved in. Read more details in Pawtograder at {assignment_url}"
    }
  }
};
