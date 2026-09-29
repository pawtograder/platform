/**
 * `canarySeed` (spec §7.2): a class whose every PII field holds a unique canary, with the registry
 * that says where each canary lives. The taint trace (package 2a) and the leak tests (package 3)
 * scan pages and uploads for these values.
 *
 * The seed goes through the ordinary helpers in `TestingUtils.ts` with their `canary` option, and
 * adds rows those helpers don't create: a help request message, a discussion thread and reply, a
 * rubric comment, a released grade, and a manual gradebook column with a score override note.
 */
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertHelpRequest,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "../TestingUtils";
import {
  canaryGrade,
  canarySentence,
  registerCanary,
  resolveCanary,
  canaryVariants,
  type CanaryEntry,
  type CanaryRegistry
} from "./canaryRegistry";

export type CanarySeed = {
  course: Awaited<ReturnType<typeof createClass>>;
  instructor: TestingUser;
  grader: TestingUser;
  students: TestingUser[];
  /** Canary value → kind, `table.column`, row id */
  registry: CanaryRegistry;
  /** Normalized strings a canary can appear as (first/last tokens, "Last, First", email local part, ...) */
  variants: (value: string) => string[];
  /** Pages that render the seeded rows, keyed by a short name */
  routes: Record<string, string>;
  ids: {
    assignmentId: number;
    submissionId: number;
    helpRequestId: number;
    threadId: number;
  };
};

function check<R extends { data: unknown; error: { message: string } | null }>(
  label: string,
  result: R
): NonNullable<R["data"]> {
  if (result.error || result.data === null) {
    throw new Error(`canarySeed: ${label} failed: ${result.error?.message ?? "no row"}`);
  }
  return result.data as NonNullable<R["data"]>;
}

/** Seeds a canary class. Pass `studentCount` for more students (default 3). */
export async function seedCanaryClass({ studentCount = 3 }: { studentCount?: number } = {}): Promise<CanarySeed> {
  const registry: CanaryRegistry = new Map();
  const canary = { registry, githubUsername: true, discordUsername: true };
  const resolved = resolveCanary(canary)!;
  const register = (value: string, entry: CanaryEntry) => registerCanary(resolved, value, entry);
  const sentence = (column: string, rowId: string | number) => {
    const s = canarySentence();
    return {
      text: s.text,
      register: (id: string | number = rowId) =>
        register(s.text, { kind: "free_text", column, rowId: id, anchors: [s.anchor] })
    };
  };

  const course = await createClass({ name: "E2E Canary Class", canary });
  const users = await createUsersInClass([
    { role: "instructor", class_id: course.id, canary },
    { role: "grader", class_id: course.id, canary },
    ...Array.from({ length: studentCount }, () => ({ role: "student" as const, class_id: course.id, canary }))
  ]);
  const [instructor, grader, ...students] = users;

  // Office hours: a request and a message, with staff on duty so the queue renders normally.
  const request = canarySentence();
  const helpRequest = await insertHelpRequest({
    class_id: course.id,
    student_profile_id: students[0].private_profile_id,
    request: request.text,
    active_staff_profile_id: instructor.private_profile_id,
    canary
  });
  register(request.text, {
    kind: "free_text",
    column: "help_requests.request",
    rowId: helpRequest.id,
    anchors: [request.anchor]
  });
  const message = sentence("help_request_messages.message", 0);
  const messageRow = check(
    "help request message",
    await supabase
      .from("help_request_messages")
      .insert({
        class_id: course.id,
        help_request_id: helpRequest.id,
        author: students[0].private_profile_id,
        message: message.text
      })
      .select("id")
      .single()
  );
  message.register(messageRow.id);

  // Discussion: a root thread by a student and a staff reply.
  const topic = check(
    "discussion topic lookup",
    await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", course.id)
      .order("ordinal", { ascending: true })
      .limit(1)
      .single()
  );
  const subject = sentence("discussion_threads.subject", 0);
  const body = sentence("discussion_threads.body", 0);
  const thread = check(
    "discussion thread",
    await supabase
      .from("discussion_threads")
      .insert({
        subject: subject.text,
        body: body.text,
        topic_id: topic.id,
        is_question: true,
        instructors_only: false,
        author: students[1 % students.length].private_profile_id,
        class_id: course.id,
        draft: false,
        root_class_id: course.id
      })
      .select("id")
      .single()
  );
  subject.register(thread.id);
  body.register(thread.id);
  const replyBody = sentence("discussion_threads.body", 0);
  const reply = check(
    "discussion reply",
    await supabase
      .from("discussion_threads")
      .insert({
        subject: "Re: question",
        body: replyBody.text,
        topic_id: topic.id,
        parent: thread.id,
        root: thread.id,
        is_question: false,
        instructors_only: false,
        author: instructor.private_profile_id,
        class_id: course.id,
        draft: false
      })
      .select("id")
      .single()
  );
  replyBody.register(reply.id);

  // An assignment with a graded, released submission for the first student.
  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Canary Assignment",
    assignment_slug: `e2e-canary-${course.id}`
  });
  const submission = await insertPreBakedSubmission({
    student_profile_id: students[0].private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  const comment = sentence("submission_comments.comment", 0);
  const commentRow = check(
    "rubric comment",
    await supabase
      .from("submission_comments")
      .insert({
        class_id: course.id,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        author: grader.private_profile_id,
        comment: comment.text,
        rubric_check_id: assignment.rubricChecks[0]?.id ?? null,
        points: assignment.rubricChecks[0]?.points ?? null,
        released: true,
        eventually_visible: true
      })
      .select("id")
      .single()
  );
  comment.register(commentRow.id);

  const total = canaryGrade();
  check(
    "release review",
    await supabase
      .from("submission_reviews")
      .update({
        total_score: total.value,
        released: true,
        completed_by: grader.private_profile_id,
        completed_at: new Date().toISOString()
      })
      .eq("id", submission.grading_review_id)
      .select("id")
  );
  register(total.text, {
    kind: "grade",
    column: "submission_reviews.total_score",
    rowId: submission.grading_review_id,
    anchors: [total.text]
  });
  // The gradebook cell draws from the released review through an async recalculation; write it
  // directly so the seed is deterministic (same approach as tests/e2e/a11yAgentSeeding.ts).
  const assignmentColumn = check(
    "assignment gradebook column",
    await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", course.id)
      .eq("slug", `assignment-${assignment.slug}`)
      .single()
  );
  check(
    "assignment gradebook cells",
    await supabase
      .from("gradebook_column_students")
      .update({ score: total.value, released: true, is_missing: false })
      .eq("gradebook_column_id", assignmentColumn.id)
      .eq("student_id", students[0].private_profile_id)
      .select("id")
  );

  // A manual column: a distinct score per student, and an override with a note for the second.
  const gradebook = check(
    "gradebook lookup",
    await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()
  );
  const manual = check(
    "manual gradebook column",
    await supabase
      .from("gradebook_columns")
      .insert({
        class_id: course.id,
        gradebook_id: gradebook.id,
        name: "Canary Participation",
        slug: `canary-participation-${course.id}`,
        max_score: 100,
        released: true
      })
      .select("id")
      .single()
  );
  for (const [i, student] of students.entries()) {
    const score = canaryGrade();
    const cells = check(
      "manual gradebook cells",
      await supabase
        .from("gradebook_column_students")
        .update({ score: score.value, released: true, is_missing: false })
        .eq("gradebook_column_id", manual.id)
        .eq("student_id", student.private_profile_id)
        .select("id, is_private")
    );
    const cellId = cells.find((c) => c.is_private)?.id ?? cells[0]?.id ?? 0;
    register(score.text, {
      kind: "grade",
      column: "gradebook_column_students.score",
      rowId: cellId,
      anchors: [score.text]
    });
    if (i === 1 % students.length && students.length > 1) {
      const override = canaryGrade();
      const note = canarySentence();
      check(
        "score override",
        await supabase
          .from("gradebook_column_students")
          .update({ score_override: override.value, score_override_note: note.text })
          .eq("id", cellId)
          .select("id")
      );
      register(override.text, {
        kind: "grade",
        column: "gradebook_column_students.score_override",
        rowId: cellId,
        anchors: [override.text]
      });
      register(note.text, {
        kind: "free_text",
        column: "gradebook_column_students.score_override_note",
        rowId: cellId,
        anchors: [note.anchor]
      });
    }
  }

  const base = `/course/${course.id}`;
  const routes = {
    studentDashboard: base,
    studentAssignments: `${base}/assignments`,
    studentAssignment: `${base}/assignments/${assignment.id}`,
    studentSubmission: `${base}/assignments/${assignment.id}/submissions/${submission.submission_id}`,
    studentGrade: `${base}/assignments/${assignment.id}/submissions/${submission.submission_id}/grade`,
    studentGradebook: `${base}/gradebook`,
    officeHours: `${base}/office-hours`,
    helpRequest: `${base}/office-hours/request/${helpRequest.id}`,
    discussion: `${base}/discussion`,
    discussionThread: `${base}/discussion/${thread.id}`,
    manageDashboard: `${base}/manage`,
    manageAssignments: `${base}/manage/assignments`,
    manageAssignment: `${base}/manage/assignments/${assignment.id}`,
    manageGroups: `${base}/manage/assignments/${assignment.id}/groups`,
    graderSubmission: `${base}/grade/assignments/${assignment.id}/submissions/${submission.submission_id}`,
    graderSubmissionFiles: `${base}/grade/assignments/${assignment.id}/submissions/${submission.submission_id}/files`,
    manageGradebook: `${base}/manage/gradebook`,
    manageEnrollments: `${base}/manage/course/enrollments`,
    manageStudent: `${base}/manage/student/${students[0].private_profile_id}`,
    manageOfficeHours: `${base}/manage/office-hours`,
    manageHelpRequest: `${base}/manage/office-hours/request/${helpRequest.id}`,
    manageDiscussionEngagement: `${base}/manage/discussion-engagement`
  };

  return {
    course,
    instructor,
    grader,
    students,
    registry,
    variants: (value: string) => canaryVariants(value, registry.get(value)),
    routes,
    ids: {
      assignmentId: assignment.id,
      submissionId: submission.submission_id,
      helpRequestId: helpRequest.id,
      threadId: thread.id
    }
  };
}
