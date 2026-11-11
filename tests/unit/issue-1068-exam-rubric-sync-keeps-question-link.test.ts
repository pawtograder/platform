// Skipped unless RUN_SUPABASE_INTEGRATION_TESTS=true (needs local Supabase).
import { addDays } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { Database, Json } from "@/utils/supabase/SupabaseTypes";

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

// The generated rows, found by criterion so a copy that lost its link would still be counted.
async function examChecks(rubricId: number) {
  const { data: criteria, error: critErr } = await supabase
    .from("rubric_criteria")
    .select("id")
    .eq("rubric_id", rubricId)
    .not("exam_question_id", "is", null);
  throwIfSetError(critErr, "select rubric_criteria");
  const { data, error } = await supabase
    .from("rubric_checks")
    .select("id, name, points, data, exam_question_id, rubric_criteria_id")
    .in(
      "rubric_criteria_id",
      (criteria ?? []).map((c) => c.id)
    );
  throwIfSetError(error, "select rubric_checks");
  return data ?? [];
}

const totalPoints = (checks: { points: number }[]) => checks.reduce((sum, c) => sum + c.points, 0);

type CheckRow = Database["public"]["Tables"]["rubric_checks"]["Row"];

async function instructorClient(classId: number): Promise<SupabaseClient<Database>> {
  const instructor = await createUserInClass({ role: "instructor", class_id: classId });
  return createAuthenticatedClient(instructor);
}

// Saves the rubric the way the rubric editor does: the whole tree through update_rubric_full,
// with the same fields the editor sends (app/.../rubric/page.tsx), after editCheck changes one check.
async function saveThroughEditor(
  client: SupabaseClient<Database>,
  rubricId: number,
  checkId: number,
  editCheck: (check: CheckRow) => CheckRow
) {
  const { data: rubric, error: readErr } = await supabase
    .from("rubrics")
    .select("*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))")
    .eq("id", rubricId)
    .single();
  throwIfSetError(readErr, "read rubric");
  const payload = {
    id: rubric!.id,
    class_id: rubric!.class_id,
    assignment_id: rubric!.assignment_id,
    review_round: rubric!.review_round,
    name: rubric!.name,
    description: rubric!.description,
    is_private: rubric!.is_private,
    cap_score_to_assignment_points: rubric!.cap_score_to_assignment_points,
    hide_unless_assigned: rubric!.hide_unless_assigned,
    parts: rubric!.rubric_parts.map((part) => ({
      id: part.id,
      name: part.name,
      description: part.description,
      ordinal: part.ordinal,
      data: part.data,
      is_individual_grading: part.is_individual_grading,
      is_assign_to_student: part.is_assign_to_student,
      criteria: part.rubric_criteria.map((crit) => ({
        id: crit.id,
        name: crit.name,
        description: crit.description,
        ordinal: crit.ordinal,
        data: crit.data,
        is_additive: crit.is_additive,
        is_deduction_only: crit.is_deduction_only,
        total_points: crit.total_points,
        max_checks_per_submission: crit.max_checks_per_submission,
        min_checks_per_submission: crit.min_checks_per_submission,
        checks: crit.rubric_checks.map((original) => {
          const check = original.id === checkId ? editCheck(original) : original;
          return {
            id: check.id,
            name: check.name,
            description: check.description,
            ordinal: check.ordinal,
            data: check.data,
            file: check.file,
            artifact: check.artifact,
            group: check.group,
            is_annotation: check.is_annotation,
            is_comment_required: check.is_comment_required,
            is_required: check.is_required,
            max_annotations: check.max_annotations,
            points: check.points,
            annotation_target: check.annotation_target,
            student_visibility: check.student_visibility,
            kpi_category: check.kpi_category,
            references: []
          };
        })
      }))
    }))
  };
  const { error } = await client.rpc("update_rubric_full", { p_rubric: payload as unknown as Json });
  throwIfSetError(error, "update_rubric_full");
}

describeIntegration("#1068: exam rubric rebuild does not duplicate checks", () => {
  test("an editor save that clears a generated check's data leaves one check after a rebuild", async () => {
    const exam = await buildExamWithRubric();
    const client = await instructorClient(exam.classId);
    const before = await examChecks(exam.rubricId);
    expect(totalPoints(before)).toBe(20);
    const item1 = before.find((c) => c.name === "Item 1")!;

    await saveThroughEditor(client, exam.rubricId, item1.id, (c) => ({ ...c, data: null }));
    await sync(exam.examId, exam.rubricId);

    const after = await examChecks(exam.rubricId);
    expect(after).toHaveLength(before.length);
    expect(totalPoints(after)).toBe(20);
  });

  test("an editor save keeps the check's exam_question_id", async () => {
    const exam = await buildExamWithRubric();
    const client = await instructorClient(exam.classId);
    const item1 = (await examChecks(exam.rubricId)).find((c) => c.name === "Item 1")!;
    expect(item1.exam_question_id).not.toBeNull();

    await saveThroughEditor(client, exam.rubricId, item1.id, (c) => ({
      ...c,
      data: {
        options: [
          { label: "Full", points: 5 },
          { label: "None", points: 0 }
        ]
      }
    }));

    const saved = (await examChecks(exam.rubricId)).find((c) => c.id === item1.id)!;
    expect(saved.exam_question_id).toBe(item1.exam_question_id);
  });

  test("a check renamed in the editor after its data was cleared still isn't duplicated", async () => {
    const exam = await buildExamWithRubric();
    const client = await instructorClient(exam.classId);
    const before = await examChecks(exam.rubricId);
    const item1 = before.find((c) => c.name === "Item 1")!;

    await saveThroughEditor(client, exam.rubricId, item1.id, (c) => ({ ...c, name: "Item 1 (renamed)", data: null }));
    await sync(exam.examId, exam.rubricId);

    const after = await examChecks(exam.rubricId);
    expect(after).toHaveLength(before.length);
    expect(after.filter((c) => c.exam_question_id === item1.exam_question_id)).toHaveLength(1);
  });

  test("the database refuses a second generated check for the same question", async () => {
    const exam = await buildExamWithRubric();
    const item1 = (await examChecks(exam.rubricId)).find((c) => c.name === "Item 1")!;

    const { error } = await supabase.from("rubric_checks").insert({
      class_id: exam.classId,
      assignment_id: exam.assignmentId,
      rubric_id: exam.rubricId,
      rubric_criteria_id: item1.rubric_criteria_id,
      name: "Item 1",
      ordinal: 1,
      points: 5,
      is_annotation: false,
      is_comment_required: false,
      exam_question_id: item1.exam_question_id
    });
    expect(error?.code).toBe("23505");
  });

  test("deleting a question removes its generated criterion and check", async () => {
    const exam = await buildExamWithRubric();
    const { data: questions, error: qErr } = await supabase
      .from("exam_questions")
      .select("id, label")
      .eq("exam_id", exam.examId);
    throwIfSetError(qErr, "select exam_questions");
    const idOf = (label: string) => questions!.find((q) => q.label === label)!.id;
    const { data: q2Criterion } = await supabase
      .from("rubric_criteria")
      .select("id")
      .eq("exam_question_id", idOf("Q2"))
      .single();
    const item2 = (await examChecks(exam.rubricId)).find((c) => c.name === "Item 2")!;

    // Save the structure again without Q2 and its Item 2, keeping the other ids.
    const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: exam.examId,
      p_questions: [
        { id: idOf("Part A"), client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
        { id: idOf("Q1"), client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
        {
          id: idOf("Item 1"),
          client_id: "c1",
          parent_client_id: "q1",
          level: 3,
          ordinal: 0,
          label: "Item 1",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: []
    });
    throwIfSetError(structErr, "exam_upsert_questions_and_regions");

    const { data: criteriaLeft } = await supabase.from("rubric_criteria").select("id").eq("id", q2Criterion!.id);
    expect(criteriaLeft).toHaveLength(0);
    const { data: checksLeft } = await supabase.from("rubric_checks").select("id").eq("id", item2.id);
    expect(checksLeft).toHaveLength(0);
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
