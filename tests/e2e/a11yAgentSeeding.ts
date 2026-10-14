/**
 * Shared seeding for the agentic SR-driving runs AND the deterministic replay
 * specs generated from their trajectories (a11y-judge v2, Wave 4).
 *
 * One call seeds all nine student pages exactly like a11y-evidence.spec.ts
 * and returns routes + the seed bindings that task predicates and spoken-
 * phrase normalization key on. Seed NAMES are constants: recorded and fresh
 * runs differ only in ids/dates, which normalize to placeholders.
 */
import { addDays } from "date-fns";
import {
  createClass,
  createRegradeRequest,
  createUsersInClass,
  insertAssignment,
  insertHelpRequest,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";
import type { TaskContext } from "../../tools/a11y-judge/agent/tasks";

/**
 * The released hand-grade on the seeded submission. Chosen to collide with
 * nothing else in the seed: it is not the autograder's 5/10, not a heading
 * level, and not a count that turns up in page chrome — so when it is heard,
 * it came from the gradebook.
 */
const GRADEBOOK_SCORE = 45;
/** `insertAssignment` hard-codes `total_points: 100`, which becomes the auto-created column's `max_score`. */
const ASSIGNMENT_TOTAL_POINTS = 100;

/**
 * Put a released, student-visible score on the assignment's gradebook column.
 *
 * Two writes, because the production path between them is asynchronous and this
 * seed has to be deterministic:
 *
 *  1. Release the submission review. This is the real upstream gate — the
 *     `is_private = false` gradebook cell draws from `scores_by_round_public`,
 *     which filters on `submission_reviews.released`.
 *  2. Write the student-visible cell directly. In production a pg_cron job
 *     drains a queue into the `gradebook-column-recalculate` Edge Function,
 *     which can take a minute or more to land; polling for it would add a
 *     worker dependency and a long timeout to every a11y seed. Writing it here
 *     is safe precisely *because* step 1 happened: if the worker does run, it
 *     recomputes the same score from the released review and converges.
 *
 * Note the `is_private = false` filter. Both rows exist per (column, student);
 * the staff-facing `is_private = true` row is ungated and is not what the
 * student gradebook reads (`hooks/useGradebook.tsx`, RLS policy
 * "student views non-private only").
 */
async function releaseGradebookScore({
  class_id,
  assignment_slug,
  grading_review_id,
  student_profile_id,
  grader_profile_id,
  score
}: {
  class_id: number;
  assignment_slug: string;
  grading_review_id: number;
  student_profile_id: string;
  grader_profile_id: string;
  score: number;
}) {
  const { error: reviewErr } = await supabase
    .from("submission_reviews")
    .update({
      total_score: score,
      released: true,
      completed_by: grader_profile_id,
      completed_at: new Date().toISOString()
    })
    .eq("id", grading_review_id);
  if (reviewErr) throw new Error(`release review failed: ${reviewErr.message}`);

  const { data: column, error: columnErr } = await supabase
    .from("gradebook_columns")
    .select("id")
    .eq("class_id", class_id)
    .eq("slug", `assignment-${assignment_slug}`)
    .single();
  if (columnErr || !column) {
    throw new Error(`assignment gradebook column lookup failed: ${columnErr?.message ?? "missing row"}`);
  }

  const { data: updated, error: cellErr } = await supabase
    .from("gradebook_column_students")
    .update({ score, released: true, is_missing: false })
    .eq("gradebook_column_id", column.id)
    .eq("student_id", student_profile_id)
    .eq("is_private", false)
    .select("id");
  if (cellErr) throw new Error(`gradebook cell seed failed: ${cellErr.message}`);
  if (!updated || updated.length === 0) {
    throw new Error(`gradebook cell seed matched no student-visible row for column ${column.id}`);
  }
}

export const AGENT_SURVEY_JSON = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "text", name: "q1", title: "What is your name?", isRequired: true },
        {
          type: "radiogroup",
          name: "q2",
          title: "How is the course pace?",
          choices: ["Too slow", "Just right", "Too fast"]
        },
        { type: "checkbox", name: "q3", title: "Which topics were hardest?", choices: ["Graphs", "DP", "Systems"] },
        { type: "comment", name: "q4", title: "Any other feedback?" }
      ]
    }
  ]
};

/**
 * Submission files for the Monaco-backed files page (shared with
 * a11y-evidence.spec.ts). The marker comment is seed-derived ground truth for
 * the submission-files read-task: reaching it proves the SR user can get at
 * the code *content*, not just the page chrome.
 */
export const A11Y_CODE_MARKER_TEXT = "the hidden treasure is calibrated precision";
export const A11Y_CODE_FILE_NAME = "Calculator.java";
export const A11Y_CODE_FILES = [
  {
    name: A11Y_CODE_FILE_NAME,
    contents: [
      "public class Calculator {",
      `  // A11Y-MARKER: ${A11Y_CODE_MARKER_TEXT}`,
      "  public int add(int a, int b) {",
      "    return a + b;",
      "  }",
      "",
      "  public int subtract(int a, int b) {",
      "    return a - b;",
      "  }",
      "}",
      ""
    ].join("\n")
  },
  {
    name: "CalculatorTest.java",
    contents: [
      "public class CalculatorTest {",
      "  public void testAdd() {",
      "    assert new Calculator().add(2, 2) == 4;",
      "  }",
      "}",
      ""
    ].join("\n")
  }
];

export interface AgentSeed {
  course: Awaited<ReturnType<typeof createClass>>;
  student: TestingUser;
  instructor: TestingUser;
  routes: Record<string, string>;
  seedValues: Record<string, string>;
}

export async function seedAgentPages(): Promise<AgentSeed> {
  const course = await createClass({ name: "E2E A11y Agent Class" });
  const [student, instructor] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Agent Student", useMagicLink: true },
    { role: "instructor", class_id: course.id, name: "Agent Instructor", useMagicLink: true }
  ]);

  const routes: Record<string, string> = {};
  const seedValues: Record<string, string> = {};

  const { data: survey, error: surveyErr } = await supabase
    .from("surveys")
    .insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: true,
      json: AGENT_SURVEY_JSON,
      version: 1,
      status: "published",
      title: "Agent Survey",
      description: "Survey for agentic SR-driving runs"
    })
    .select("id")
    .single();
  if (surveyErr) throw new Error(`survey seed failed: ${surveyErr.message}`);
  routes["survey-taking"] = `/course/${course.id}/surveys/${survey!.id}`;
  seedValues.surveyId = String(survey!.id);
  seedValues.studentProfileId = student.private_profile_id;
  seedValues.classId = String(course.id);
  seedValues.studentName = "Agent Student";
  seedValues.className = "E2E A11y Agent Class";
  seedValues.surveyTitle = "Agent Survey";

  // insertPreBakedSubmission seeds grader_results score 5/10 with passing
  // tests "test 1" and "test 2" (TestingUtils) — the read-task ground truth.
  const assignmentSlug = `e2e-a11y-agent-${course.id}`;
  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Agent Assignment",
    assignment_slug: assignmentSlug
  });
  const sub = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id,
    files: A11Y_CODE_FILES
  });
  routes["autograder-results"] =
    `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}/results`;
  routes["grade-summary"] = routes["autograder-results"].replace(/results$/, "grade");
  routes["gradebook"] = `/course/${course.id}/gradebook`;
  routes["assignments-list"] = `/course/${course.id}/assignments`;
  routes["submission-files"] = routes["autograder-results"].replace(/results$/, "files");
  seedValues.assignmentName = "Agent Assignment";
  seedValues.autograderScore = "5";
  seedValues.autograderMax = "10";

  // A RELEASED hand-grade, so the gradebook has an actual score to announce.
  // Without this the student-visible cell has score = null and the page renders
  // the "Submitted" status for everyone — which is why the gradebook read-task
  // could only ever needle the assignment name (issue #915).
  await releaseGradebookScore({
    class_id: course.id,
    assignment_slug: assignmentSlug,
    grading_review_id: sub.grading_review_id,
    student_profile_id: student.private_profile_id,
    grader_profile_id: instructor.private_profile_id,
    score: GRADEBOOK_SCORE
  });
  seedValues.gradebookScore = String(GRADEBOOK_SCORE);
  seedValues.gradebookMaxScore = String(ASSIGNMENT_TOTAL_POINTS);
  // The needle the gradebook read-task keys on. It is the exact phrase the score
  // cell exposes to a screen reader (<SpokenValue> in whatIf.tsx), and it is
  // deliberately the whole phrase rather than a bare "45": normalizePhrase
  // substitutes seed values as whole tokens, so a lone number still matches
  // incidental digits elsewhere in the journey ("heading, level 5"). See the
  // memo in docs/a11y-session-memo-2026-08.md.
  seedValues.gradebookSpokenScore = `${GRADEBOOK_SCORE} of ${ASSIGNMENT_TOTAL_POINTS} points`;
  seedValues.codeFileName = A11Y_CODE_FILE_NAME;
  seedValues.codeMarkerText = A11Y_CODE_MARKER_TEXT;

  // Regrade request on the seeded submission (status "opened" so it shows on
  // the student's regrade-requests dashboard).
  await createRegradeRequest(
    sub.submission_id,
    assignment.id,
    student.private_profile_id,
    instructor.private_profile_id,
    assignment.rubricChecks[0]!.id,
    course.id,
    "opened"
  );
  routes["regrade-requests"] = `/course/${course.id}/regrade-requests`;

  // Office hours: one pre-existing open request so the queue page has content;
  // the write-task creates a NEW request whose text must land in the DB. The
  // instructor is put on duty — without active staff the New Request button is
  // disabled and the write-task is unreachable.
  const helpRequest = await insertHelpRequest({
    class_id: course.id,
    student_profile_id: student.private_profile_id,
    request: "Seeded question: my tests pass locally but fail on the autograder.",
    active_staff_profile_id: instructor.private_profile_id
  });
  routes["office-hours"] = `/course/${course.id}/office-hours`;
  seedValues.seededHelpRequestId = String(helpRequest.id);

  const { data: topicRow } = await supabase
    .from("discussion_topics")
    .select("id")
    .eq("class_id", course.id)
    .order("ordinal", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: thread, error: threadErr } = await supabase
    .from("discussion_threads")
    .insert({
      subject: "Office hours schedule question",
      body: "Will office hours continue during the exam week? A body long enough to render the two-pane discussion shell.",
      topic_id: topicRow!.id,
      is_question: false,
      instructors_only: false,
      author: student.private_profile_id,
      class_id: course.id,
      draft: false,
      root_class_id: course.id
    })
    .select("id")
    .single();
  if (threadErr) throw new Error(`thread seed failed: ${threadErr.message}`);
  routes["discussion"] = `/course/${course.id}/discussion/${thread!.id}`;
  seedValues.threadId = String(thread!.id);
  seedValues.threadSubject = "Office hours schedule question";

  return { course, student, instructor, routes, seedValues };
}

export function makeTaskContext(seedValues: Record<string, string>): TaskContext {
  return {
    seed: seedValues,
    queryRow: async (table, match) => {
      let query = supabase.from(table as never).select("*");
      for (const [k, v] of Object.entries(match)) query = query.eq(k, v);
      const { data } = await query.maybeSingle();
      return (data as Record<string, unknown> | null) ?? null;
    },
    queryRowContains: async (table, contains, match) => {
      let query = supabase
        .from(table as never)
        .select("*")
        .ilike(contains.column, `%${contains.needle}%`);
      for (const [k, v] of Object.entries(match)) query = query.eq(k, v);
      const { data } = await query.limit(1).maybeSingle();
      return (data as Record<string, unknown> | null) ?? null;
    }
  };
}
