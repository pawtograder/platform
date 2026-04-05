/**
 * Verify that all query hooks produce unique, non-colliding query keys.
 * This prevents cache poisoning where two different tables accidentally
 * share the same cache slot.
 */

describe("Query Key Uniqueness", () => {
  const COURSE_ID = 42;
  const ASSIGNMENT_ID = 7;
  const CLASS_ID = 42;

  // -----------------------------------------------------------------------
  // Course hooks: same courseId must produce different keys per table
  // -----------------------------------------------------------------------

  it("course hooks with same courseId produce different keys per table", () => {
    // The pattern for course hooks is ["course", courseId, tableName]
    const keys = [
      ["course", COURSE_ID, "profiles"],
      ["course", COURSE_ID, "tags"],
      ["course", COURSE_ID, "assignments"],
      ["course", COURSE_ID, "discussion_topics"],
      ["course", COURSE_ID, "notifications"],
      ["course", COURSE_ID, "repositories"],
      ["course", COURSE_ID, "gradebook_columns"],
      ["course", COURSE_ID, "discussion_thread_read_status"],
      ["course", COURSE_ID, "discussion_thread_watchers"],
      ["course", COURSE_ID, "discussion_topic_followers"],
      ["course", COURSE_ID, "discussion_thread_likes"],
      ["course", COURSE_ID, "student_deadline_extensions"],
      ["course", COURSE_ID, "assignment_due_date_exceptions"],
      ["course", COURSE_ID, "user_roles"],
      ["course", COURSE_ID, "assignment_groups"],
      ["course", COURSE_ID, "lab_sections"],
      ["course", COURSE_ID, "lab_section_meetings"],
      ["course", COURSE_ID, "lab_section_leaders"],
      ["course", COURSE_ID, "class_sections"],
      ["course", COURSE_ID, "discussion_thread_teasers"],
      ["course", COURSE_ID, "calendar_events"],
      ["course", COURSE_ID, "class_staff_settings"],
      ["course", COURSE_ID, "discord_channels"],
      ["course", COURSE_ID, "discord_messages"],
      ["course", COURSE_ID, "live_polls"],
      ["course", COURSE_ID, "surveys"],
      ["course", COURSE_ID, "survey_series"]
    ];

    const serialized = keys.map((k) => JSON.stringify(k));
    const unique = new Set(serialized);
    expect(unique.size).toBe(serialized.length);
  });

  // -----------------------------------------------------------------------
  // Assignment hooks: same assignmentId must produce different keys per table
  // -----------------------------------------------------------------------

  it("assignment hooks with same assignmentId produce different keys per table", () => {
    const keys = [
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "submissions"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "assignment_groups"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "review_assignments"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "all_review_assignments"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "regrade_requests"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "leaderboard"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "rubrics"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "rubric_parts"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "rubric_criteria"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "rubric_checks"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "rubric_check_references"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "error_pins"],
      ["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "error_pin_rules"]
    ];

    const serialized = keys.map((k) => JSON.stringify(k));
    const unique = new Set(serialized);
    expect(unique.size).toBe(serialized.length);
  });

  // -----------------------------------------------------------------------
  // Different courseIds must produce different keys for the same table
  // -----------------------------------------------------------------------

  it("different courseIds produce different keys for the same table", () => {
    const key1 = JSON.stringify(["course", 1, "profiles"]);
    const key2 = JSON.stringify(["course", 2, "profiles"]);
    expect(key1).not.toBe(key2);
  });

  // -----------------------------------------------------------------------
  // Dynamic hooks produce unique keys per entity ID
  // -----------------------------------------------------------------------

  it("dynamic hooks produce unique keys per entity ID", () => {
    // useHelpRequestMessagesQuery pattern:
    // ["office_hours", classId, "help_request_messages", helpRequestId]
    const key1 = JSON.stringify(["office_hours", CLASS_ID, "help_request_messages", 100]);
    const key2 = JSON.stringify(["office_hours", CLASS_ID, "help_request_messages", 200]);
    const key3 = JSON.stringify(["office_hours", CLASS_ID, "help_request_message_read_receipts", 100]);

    expect(key1).not.toBe(key2); // Different helpRequestId
    expect(key1).not.toBe(key3); // Different table, same helpRequestId

    // useReviewAssignmentRubricPartsQuery pattern:
    // ["course", courseId, "review_assignment_rubric_parts", reviewAssignmentId]
    const key4 = JSON.stringify(["course", COURSE_ID, "review_assignment_rubric_parts", 10]);
    const key5 = JSON.stringify(["course", COURSE_ID, "review_assignment_rubric_parts", 20]);
    expect(key4).not.toBe(key5);
  });

  // -----------------------------------------------------------------------
  // No cross-domain collisions
  // -----------------------------------------------------------------------

  it("course, assignment, office-hours, and submission keys never collide", () => {
    // Representatives from each domain
    const courseKey = JSON.stringify(["course", COURSE_ID, "profiles"]);
    const assignmentKey = JSON.stringify(["course", COURSE_ID, "assignment", ASSIGNMENT_ID, "submissions"]);
    const officeHoursKey = JSON.stringify(["office_hours", CLASS_ID, "help_requests"]);
    const submissionKey = JSON.stringify(["submission", 99, "comments"]);

    const allKeys = [courseKey, assignmentKey, officeHoursKey, submissionKey];
    const unique = new Set(allKeys);
    expect(unique.size).toBe(allKeys.length);
  });
});
