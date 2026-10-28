import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";

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

type Option = { label: string; points: number };
type ExamQuestion = {
  id?: number;
  client_id: string;
  parent_client_id: string | null;
  level: number;
  ordinal: number;
  label: string;
  answer_type?: string;
  points?: number;
};

function questionsWith(item1Points: number, ids: Record<string, number> = {}): ExamQuestion[] {
  const q = (client_id: string, rest: Omit<ExamQuestion, "client_id">): ExamQuestion => ({
    ...(ids[rest.label] ? { id: ids[rest.label] } : {}),
    client_id,
    ...rest
  });
  return [
    q("p1", { parent_client_id: null, level: 1, ordinal: 0, label: "Part A" }),
    q("q1", { parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" }),
    q("c1", {
      parent_client_id: "q1",
      level: 3,
      ordinal: 0,
      label: "Item 1",
      answer_type: "free_text",
      points: item1Points
    }),
    q("q2", { parent_client_id: "p1", level: 2, ordinal: 1, label: "Q2" }),
    q("c2", { parent_client_id: "q2", level: 3, ordinal: 0, label: "Item 2", answer_type: "free_text", points: 100 })
  ];
}

async function buildExam() {
  const course = await createClass({ name: "Exam partial credit #1069" });
  const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  throwIfSetError(examErr, "exam_create");
  const exam = {
    course,
    instructor,
    assignment,
    examId: examId as number,
    rubricId: assignment.grading_rubric_id as number
  };
  await saveStructure(exam.examId, questionsWith(10));
  await sync(exam);
  return exam;
}

async function saveStructure(examId: number, questions: ExamQuestion[]) {
  const { error } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId,
    p_questions: questions,
    p_regions: []
  });
  throwIfSetError(error, "exam_upsert_questions_and_regions");
}

async function sync(exam: { examId: number; rubricId: number }) {
  const { error } = await supabase.rpc("exam_sync_rubric_from_questions", {
    p_exam_id: exam.examId,
    p_rubric_id: exam.rubricId
  });
  throwIfSetError(error, "exam_sync_rubric_from_questions");
}

async function questionIds(examId: number): Promise<Record<string, number>> {
  const { data, error } = await supabase.from("exam_questions").select("id, label").eq("exam_id", examId);
  throwIfSetError(error, "select exam_questions");
  return Object.fromEntries((data ?? []).map((q) => [q.label, q.id]));
}

async function checkFor(exam: { examId: number; rubricId: number }, label: string) {
  const ids = await questionIds(exam.examId);
  const { data, error } = await supabase
    .from("rubric_checks")
    .select("id, points, data")
    .eq("rubric_id", exam.rubricId)
    .eq("data->>exam_question_id", String(ids[label]))
    .single();
  throwIfSetError(error, `select check for ${label}`);
  return { ...data!, options: (data!.data as { options?: Option[] }).options };
}

describeIntegration("#1069: partial credit on generated exam checks", () => {
  test("a 10-point question gets options from 10 down to 0", async () => {
    const exam = await buildExam();
    const check = await checkFor(exam, "Item 1");
    expect(check.options?.map((o) => o.points)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("choosing the 6-point option adds 6 to the score", async () => {
    const exam = await buildExam();
    const check = await checkFor(exam, "Item 1");
    const student = await createUserInClass({ role: "student", class_id: exam.course.id });
    const sub = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: exam.assignment.id,
      class_id: exam.course.id
    });
    const six = check.options!.find((o) => o.points === 6)!;
    const { error } = await supabase.from("submission_comments").insert({
      submission_id: sub.submission_id,
      submission_review_id: sub.grading_review_id,
      author: exam.instructor.private_profile_id,
      class_id: exam.course.id,
      rubric_check_id: check.id,
      points: six.points,
      comment: six.label,
      released: true
    });
    throwIfSetError(error, "apply option");

    const { data: review } = await supabase
      .from("submission_reviews")
      .select("total_score, total_autograde_score")
      .eq("id", sub.grading_review_id)
      .single();
    expect(Number(review?.total_score) - Number(review?.total_autograde_score)).toBe(6);
  });

  test("options follow the question's points while the exam is a draft", async () => {
    const exam = await buildExam();
    await saveStructure(exam.examId, questionsWith(8, await questionIds(exam.examId)));
    await sync(exam);
    const check = await checkFor(exam, "Item 1");
    expect(check.points).toBe(8);
    expect(check.options?.map((o) => o.points)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("leaves options alone once there are submissions", async () => {
    const exam = await buildExam();
    const check = await checkFor(exam, "Item 1");
    const custom = [
      { label: "Full credit", points: 10 },
      { label: "Half", points: 5 },
      { label: "No credit", points: 0 }
    ];
    const ids = await questionIds(exam.examId);
    const { error: editErr } = await supabase
      .from("rubric_checks")
      .update({ data: { exam_question_id: ids["Item 1"], options: custom } })
      .eq("id", check.id);
    throwIfSetError(editErr, "edit options");
    const student = await createUserInClass({ role: "student", class_id: exam.course.id });
    await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: exam.assignment.id,
      class_id: exam.course.id
    });

    await sync(exam);
    expect((await checkFor(exam, "Item 1")).options).toEqual(custom);
  });

  test("a 100-point question gets at most 21 options, from 100 down to 0", async () => {
    const exam = await buildExam();
    const points = (await checkFor(exam, "Item 2")).options?.map((o) => o.points) ?? [];
    expect(points.length).toBeLessThanOrEqual(21);
    expect(points[0]).toBe(100);
    expect(points[points.length - 1]).toBe(0);
  });
});
