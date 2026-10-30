// Skipped unless RUN_SUPABASE_INTEGRATION_TESTS=true (needs local Supabase).
import { addDays } from "date-fns";
import { createClass, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";

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

type ExamFixture = { classId: number; assignmentId: number; examId: number; rubricId: number };

async function buildExamWithRubric(): Promise<ExamFixture> {
  const course = await createClass({ name: "Exam rubric sync #1068" });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const rubricId = assignment.grading_rubric_id as number;

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  throwIfSetError(examErr, "exam_create");

  const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId as number,
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
        points: 5
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
  throwIfSetError(structErr, "exam_upsert_questions_and_regions");

  await sync(examId as number, rubricId);
  return { classId: course.id, assignmentId: assignment.id, examId: examId as number, rubricId };
}

async function sync(examId: number, rubricId: number) {
  const { error } = await supabase.rpc("exam_sync_rubric_from_questions", {
    p_exam_id: examId,
    p_rubric_id: rubricId
  });
  throwIfSetError(error, "exam_sync_rubric_from_questions");
}

// By criterion, so it skips insertAssignment's default checks but still finds a check that lost its key.
async function examChecks(rubricId: number) {
  const { data: criteria, error: critErr } = await supabase
    .from("rubric_criteria")
    .select("id")
    .eq("rubric_id", rubricId)
    .not("data->exam_question_id", "is", null);
  throwIfSetError(critErr, "select rubric_criteria");
  const { data, error } = await supabase
    .from("rubric_checks")
    .select("id, name, points, data, rubric_criteria_id")
    .in(
      "rubric_criteria_id",
      (criteria ?? []).map((c) => c.id)
    );
  throwIfSetError(error, "select rubric_checks");
  return data ?? [];
}

const totalPoints = (checks: { points: number }[]) => checks.reduce((sum, c) => sum + c.points, 0);

describeIntegration("#1068: exam rubric rebuild does not duplicate checks", () => {
  test("refuses to rebuild when a generated check has lost its exam_question_id", async () => {
    const exam = await buildExamWithRubric();
    const before = await examChecks(exam.rubricId);
    expect(totalPoints(before)).toBe(20);

    const item1 = before.find((c) => c.name === "Item 1")!;
    const { error: nullErr } = await supabase.from("rubric_checks").update({ data: null }).eq("id", item1.id);
    throwIfSetError(nullErr, "null check data");

    const { error } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: exam.examId,
      p_rubric_id: exam.rubricId
    });
    expect(error?.message).toMatch(/exam_question_id/);

    const after = await examChecks(exam.rubricId);
    expect(after).toHaveLength(before.length);
    expect(totalPoints(after)).toBe(20);
  });

  test("still rebuilds when an instructor added their own check to a generated criterion", async () => {
    const exam = await buildExamWithRubric();
    const before = await examChecks(exam.rubricId);
    const item1 = before.find((c) => c.name === "Item 1")!;

    const { error: insertErr } = await supabase.from("rubric_checks").insert({
      class_id: exam.classId,
      assignment_id: exam.assignmentId,
      rubric_id: exam.rubricId,
      rubric_criteria_id: item1.rubric_criteria_id,
      name: "Showed work",
      ordinal: 1,
      points: 1,
      is_annotation: false,
      is_comment_required: false
    });
    throwIfSetError(insertErr, "insert instructor check");

    await sync(exam.examId, exam.rubricId);

    const after = await examChecks(exam.rubricId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((c) => c.name === "Item 1")).toHaveLength(1);
    expect(after.filter((c) => c.name === "Item 2")).toHaveLength(1);
  });
});
