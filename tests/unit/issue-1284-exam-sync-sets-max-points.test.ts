/**
 * Regression for GitHub issue #1284: "Build rubric from exam" kept the rubric in step with the
 * questions but never updated the assignment's max points, so after a points change Configure
 * Rubric said the rubric didn't add up and told the instructor to remove points.
 *
 * exam_sync_rubric_from_questions now sets assignments.total_points to the exam total, but only for
 * a paper exam, only when syncing into the grading rubric, and only before there are submissions.
 * The last three tests cover each of those limits.
 *
 * Requires local Supabase, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * RUN_SUPABASE_INTEGRATION_TESTS=true (avoids failures when .env.local points at
 * a stopped local API). Example:
 *   RUN_SUPABASE_INTEGRATION_TESTS=true npx jest tests/unit/issue-1284-exam-sync-sets-max-points.test.ts
 *
 * Leaves the created class and related rows in the database (use db reset or manual cleanup).
 */
import { addDays } from "date-fns";
import { createClass, createUserInClass, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local" });
} catch {
  /* optional */
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const integrationEnabled = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

function throwIfSetError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

type Fixture = {
  classId: number;
  assignmentId: number;
  examId: number;
  gradingRubricId: number;
  selfReviewRubricId: number;
};

// A 20-point exam: Item 1 is worth 5 and Item 2 is worth 15. Not synced yet.
async function buildExam(deliveryMode: "paper" | "in_app"): Promise<Fixture> {
  const course = await createClass({ name: "Exam max points #1284" });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1,
    p_delivery_mode: deliveryMode
  });
  throwIfSetError(examErr, "exam_create");

  await saveQuestions(examId as number, 5);
  return {
    classId: course.id,
    assignmentId: assignment.id,
    examId: examId as number,
    gradingRubricId: assignment.grading_rubric_id as number,
    selfReviewRubricId: assignment.self_review_rubric_id as number
  };
}

async function saveQuestions(examId: number, item1Points: number) {
  const { error } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId,
    p_questions: [
      { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
      { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
      {
        client_id: "c1",
        parent_client_id: "q1",
        level: 3,
        ordinal: 0,
        label: "Item 1",
        answer_type: "free_text",
        points: item1Points
      },
      { client_id: "q2", parent_client_id: "p1", level: 2, ordinal: 1, label: "Q2" },
      {
        client_id: "c2",
        parent_client_id: "q2",
        level: 3,
        ordinal: 0,
        label: "Item 2",
        answer_type: "free_text",
        points: 15
      }
    ],
    p_regions: []
  });
  throwIfSetError(error, "exam_upsert_questions_and_regions");
}

async function sync(examId: number, rubricId: number) {
  const { error } = await supabase.rpc("exam_sync_rubric_from_questions", {
    p_exam_id: examId,
    p_rubric_id: rubricId
  });
  throwIfSetError(error, "exam_sync_rubric_from_questions");
}

async function setMaxPoints(assignmentId: number, points: number) {
  const { error } = await supabase.from("assignments").update({ total_points: points }).eq("id", assignmentId);
  throwIfSetError(error, "set total_points");
}

async function maxPoints(assignmentId: number): Promise<number> {
  const { data, error } = await supabase.from("assignments").select("total_points").eq("id", assignmentId).single();
  throwIfSetError(error, "read total_points");
  return Number(data!.total_points);
}

async function addSubmission(f: Fixture) {
  const student = await createUserInClass({ role: "student", class_id: f.classId });
  const { error } = await supabase.from("submissions").insert({
    assignment_id: f.assignmentId,
    class_id: f.classId,
    profile_id: student.private_profile_id,
    sha: "exam",
    repository: `exam/${f.assignmentId}/${student.private_profile_id}`,
    run_attempt: 0,
    run_number: 1,
    is_active: true,
    submitted_via: "manual"
  });
  throwIfSetError(error, "insert submission");
}

describeIntegration("issue #1284: rebuilding an exam's rubric sets the assignment's max points", () => {
  test("a rebuild after a points change moves the max to the new exam total", async () => {
    const f = await buildExam("paper");
    await sync(f.examId, f.gradingRubricId);

    await saveQuestions(f.examId, 10);
    await sync(f.examId, f.gradingRubricId);

    expect(await maxPoints(f.assignmentId)).toBe(25);
  });

  test("the first build replaces a max that was set before the questions existed", async () => {
    const f = await buildExam("paper");
    await setMaxPoints(f.assignmentId, 100);

    await sync(f.examId, f.gradingRubricId);

    expect(await maxPoints(f.assignmentId)).toBe(20);
  });

  // Each case: the instructor sets the max to 100 by hand after the first build, which differs from the
  // 20-point exam total, so a sync that wrongly rewrites it would leave 20.
  test.each([
    {
      name: "once a submission exists",
      // The questions are frozen by then, so the risk is a rebuild undoing a max set during grading.
      setup: async (f: Fixture) => addSubmission(f),
      delivery: "paper" as const,
      rubric: (f: Fixture) => f.gradingRubricId
    },
    {
      name: "when the sync targets the self-review rubric",
      setup: async () => {},
      delivery: "paper" as const,
      rubric: (f: Fixture) => f.selfReviewRubricId
    },
    {
      name: "for an in-app quiz",
      setup: async () => {},
      delivery: "in_app" as const,
      rubric: (f: Fixture) => f.gradingRubricId
    }
  ])("the max is left alone $name", async ({ setup, delivery, rubric }) => {
    const f = await buildExam(delivery);
    await sync(f.examId, f.gradingRubricId);
    await setup(f);
    await setMaxPoints(f.assignmentId, 100);

    await sync(f.examId, rubric(f));

    expect(await maxPoints(f.assignmentId)).toBe(100);
  });
});
