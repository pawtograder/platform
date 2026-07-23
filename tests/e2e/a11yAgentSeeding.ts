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
  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Agent Assignment",
    assignment_slug: `e2e-a11y-agent-${course.id}`
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
  // the write-task creates a NEW request whose text must land in the DB.
  const helpRequest = await insertHelpRequest({
    class_id: course.id,
    student_profile_id: student.private_profile_id,
    request: "Seeded question: my tests pass locally but fail on the autograder."
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
