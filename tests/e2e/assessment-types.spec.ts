import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createAuthenticatedClient, createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

/**
 * Phase 1 of the unified assessment builder: schema + RPCs.
 *
 * Covers the new assignment_type discriminator, the generalized exam definition
 * (delivery_mode + objective answer key), and the in-app quiz path:
 *   quiz_get_for_student (answer-key-safe) -> quiz_submit -> quiz_autograde -> gradebook.
 * Also the survey-completion -> assignment credit trigger.
 */
test.describe("Assessment types (quiz + survey)", () => {
  test("assignment_type defaults to 'code'", async () => {
    const course = await createClass({ name: "Assessment types default" });
    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 7).toISOString()
    });
    const { data, error } = await supabase
      .from("assignments")
      .select("assignment_type")
      .eq("id", assignment.id)
      .single();
    expect(error).toBeNull();
    expect(data?.assignment_type).toBe("code");
  });

  test("in-app quiz: get-for-student hides the key, submit + autograde post objective score to gradebook", async () => {
    test.setTimeout(120_000);

    const course = await createClass({ name: "In-app quiz E2E" });
    await createUserInClass({ role: "instructor", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id, name: "Quiz Taker" });

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Unit Quiz",
      due_date: addDays(new Date(), 7).toISOString()
    });
    expect(assignment.grading_rubric_id).toBeTruthy();

    // Mark the assignment as a quiz.
    await supabase.from("assignments").update({ assignment_type: "quiz" }).eq("id", assignment.id);

    // Create the assessment definition in in_app delivery mode.
    const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "generated",
      p_num_pages: 0,
      p_delivery_mode: "in_app"
    });
    expect(examErr).toBeNull();
    expect(examId).toBeTruthy();

    // 3 objective questions (auto-graded) + 1 free-text (manual). Points: 3 + 2 + 4 (+5 manual).
    const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [
        {
          client_id: "mc1",
          parent_client_id: null,
          level: 1,
          ordinal: 0,
          label: "Capital of France?",
          answer_type: "multiple_choice",
          choices: ["London", "Paris", "Rome", "Berlin"],
          points: 3,
          correct_answer: { choice: "Paris" }
        },
        {
          client_id: "tf1",
          parent_client_id: null,
          level: 1,
          ordinal: 1,
          label: "The sky is blue.",
          answer_type: "true_false",
          points: 2,
          correct_answer: { value: true }
        },
        {
          client_id: "num1",
          parent_client_id: null,
          level: 1,
          ordinal: 2,
          label: "6 * 7 = ?",
          answer_type: "numeric",
          points: 4,
          correct_answer: { value: 42 },
          grading_tolerance: 0.5
        },
        {
          client_id: "ft1",
          parent_client_id: null,
          level: 1,
          ordinal: 3,
          label: "Explain your reasoning.",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: []
    });
    expect(structErr).toBeNull();

    // --- quiz_get_for_student must NOT leak the answer key ---
    const studentClient = await createAuthenticatedClient(student);
    const { data: forStudent, error: getErr } = await studentClient.rpc("quiz_get_for_student", {
      p_assignment_id: assignment.id
    });
    expect(getErr).toBeNull();
    const payload = forStudent as { exam_id: number; questions: Array<Record<string, unknown>> };
    expect(payload.questions.length).toBe(4);
    for (const q of payload.questions) {
      expect(q).not.toHaveProperty("correct_answer");
      expect(q).not.toHaveProperty("grading_tolerance");
    }
    // choices ARE delivered (the student needs them to answer)
    const mc = payload.questions.find((q) => q.label === "Capital of France?");
    expect(mc?.choices).toBeTruthy();

    // map our client ids -> db ids
    const { data: qrows } = await supabase
      .from("exam_questions")
      .select("id, label, answer_type")
      .eq("exam_id", examId as number);
    const idByLabel = new Map((qrows ?? []).map((q) => [q.label as string, q.id as number]));

    // --- student submits: all 3 objective correct (+ within tolerance), free-text filled ---
    const { data: submissionId, error: submitErr } = await studentClient.rpc("quiz_submit", {
      p_assignment_id: assignment.id,
      p_answers: [
        { exam_question_id: idByLabel.get("Capital of France?"), value: "Paris" },
        { exam_question_id: idByLabel.get("The sky is blue."), value: true },
        { exam_question_id: idByLabel.get("6 * 7 = ?"), value: 42.3 },
        { exam_question_id: idByLabel.get("Explain your reasoning."), value: "Because arithmetic." }
      ]
    });
    expect(submitErr).toBeNull();
    expect(submissionId).toBeTruthy();

    // submission row created with the quiz discriminator + a grading review
    const { data: sub } = await supabase
      .from("submissions")
      .select("id, sha, is_active, profile_id, grading_review_id")
      .eq("id", submissionId as number)
      .single();
    expect(sub?.sha).toBe("quiz");
    expect(sub?.is_active).toBe(true);
    expect(sub?.profile_id).toBe(student.private_profile_id);
    expect(sub?.grading_review_id).toBeTruthy();

    // exam_v1 artifact with the captured answers
    const { data: artifact } = await supabase
      .from("submission_artifacts")
      .select("data")
      .eq("submission_id", submissionId as number)
      .single();
    const artData = artifact?.data as { format: string; questions: Array<{ exam_question_id: number }> };
    expect(artData.format).toBe("exam_v1");
    expect(artData.questions.length).toBe(4);

    // objective auto-grade => 3 + 2 + 4 = 9 (free-text contributes 0 until hand-graded)
    const { data: review } = await supabase
      .from("submission_reviews")
      .select("total_score, total_autograde_score")
      .eq("id", sub?.grading_review_id as number)
      .single();
    expect(Number(review?.total_score)).toBe(9);

    // per-question autograder breakdown exists
    const { data: grTests } = await supabase
      .from("grader_result_tests")
      .select("name, score, max_score, grader_results!inner(submission_id)")
      .eq("grader_results.submission_id", submissionId as number);
    expect((grTests ?? []).length).toBe(3);

    // A gradebook column exists for this assignment and its score_expression resolves to
    // the grading review's total_score (asserted above). The per-cell value is filled by
    // an async pgmq worker (gradebook_row_recalculate), so we don't poll the cell here.
    const { data: cols } = await supabase
      .from("gradebook_columns")
      .select("id, score_expression, dependencies")
      .eq("class_id", course.id);
    const col = (cols ?? []).find((c) => {
      const deps = c.dependencies as { assignments?: number[] } | null;
      return deps?.assignments?.includes(assignment.id);
    });
    expect(col).toBeTruthy();
    expect(col?.score_expression).toContain("assignments(");
  });

  test("wrong answers earn zero; numeric outside tolerance is incorrect", async () => {
    const course = await createClass({ name: "Quiz wrong answers" });
    const student = await createUserInClass({ role: "student", class_id: course.id, name: "Wrong Answerer" });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Quiz B",
      due_date: addDays(new Date(), 7).toISOString()
    });
    const { data: examId } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "generated",
      p_num_pages: 0,
      p_delivery_mode: "in_app"
    });
    await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [
        {
          client_id: "n1",
          parent_client_id: null,
          level: 1,
          ordinal: 0,
          label: "pi?",
          answer_type: "numeric",
          points: 5,
          correct_answer: { value: 3.14159 },
          grading_tolerance: 0.001
        }
      ],
      p_regions: []
    });
    const { data: q } = await supabase
      .from("exam_questions")
      .select("id")
      .eq("exam_id", examId as number)
      .single();

    const studentClient = await createAuthenticatedClient(student);
    const { data: submissionId } = await studentClient.rpc("quiz_submit", {
      p_assignment_id: assignment.id,
      p_answers: [{ exam_question_id: q!.id, value: 3.2 }] // outside 0.001 tolerance
    });
    const { data: sub } = await supabase
      .from("submissions")
      .select("grading_review_id")
      .eq("id", submissionId as number)
      .single();
    const { data: review } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", sub?.grading_review_id as number)
      .single();
    expect(Number(review?.total_score)).toBe(0);
  });

  test("survey completion on a linked assignment awards full credit", async () => {
    const course = await createClass({ name: "Survey credit E2E" });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id, name: "Survey Filler" });

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Required Survey",
      due_date: addDays(new Date(), 7).toISOString()
    });
    await supabase.from("assignments").update({ assignment_type: "survey" }).eq("id", assignment.id);

    // a published survey linked to the assignment
    const { data: survey, error: surveyErr } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.private_profile_id,
        title: "Reflection",
        json: { pages: [] },
        status: "published",
        assignment_id: assignment.id
      })
      .select("id")
      .single();
    expect(surveyErr).toBeNull();

    // student submits a response -> trigger should award credit
    const { error: respErr } = await supabase.from("survey_responses").insert({
      survey_id: survey!.id,
      profile_id: student.private_profile_id,
      response: { q1: "done" },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    expect(respErr).toBeNull();

    const { data: sub } = await supabase
      .from("submissions")
      .select("id, sha, grading_review_id")
      .eq("assignment_id", assignment.id)
      .eq("profile_id", student.private_profile_id)
      .single();
    expect(sub?.sha).toBe("survey");

    const { data: review } = await supabase
      .from("submission_reviews")
      .select("total_score, released")
      .eq("id", sub?.grading_review_id as number)
      .single();
    expect(Number(review?.total_score)).toBe(100); // insertAssignment sets total_points = 100
    expect(review?.released).toBe(true);
  });

  test("manual free-text grading composes with objective auto-grade", async () => {
    test.setTimeout(120_000);

    const course = await createClass({ name: "Quiz manual+auto compose" });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id, name: "Composer" });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Mixed Quiz",
      due_date: addDays(new Date(), 7).toISOString()
    });

    const { data: examId } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "generated",
      p_num_pages: 0,
      p_delivery_mode: "in_app"
    });
    // 3-level tree so exam_sync_rubric_from_questions produces graded checks for the leaves
    await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [
        { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
        { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Section", points: 10 },
        {
          client_id: "num",
          parent_client_id: "q1",
          level: 3,
          ordinal: 0,
          label: "2+2?",
          answer_type: "numeric",
          points: 4,
          correct_answer: { value: 4 }
        },
        {
          client_id: "ft",
          parent_client_id: "q1",
          level: 3,
          ordinal: 1,
          label: "Explain",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: []
    });
    await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId as number,
      p_rubric_id: assignment.grading_rubric_id as number
    });

    const { data: qrows } = await supabase
      .from("exam_questions")
      .select("id, answer_type")
      .eq("exam_id", examId as number);
    const numQ = (qrows ?? []).find((q) => q.answer_type === "numeric")!;
    const ftQ = (qrows ?? []).find((q) => q.answer_type === "free_text")!;

    // student submits: numeric correct (+4), free-text filled (0 from auto-grade)
    const studentClient = await createAuthenticatedClient(student);
    const { data: submissionId } = await studentClient.rpc("quiz_submit", {
      p_assignment_id: assignment.id,
      p_answers: [
        { exam_question_id: numQ.id, value: 4 },
        { exam_question_id: ftQ.id, value: "my essay" }
      ]
    });
    const { data: sub } = await supabase
      .from("submissions")
      .select("grading_review_id")
      .eq("id", submissionId as number)
      .single();

    // auto-grade only so far => 4
    const { data: r1 } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", sub!.grading_review_id as number)
      .single();
    expect(Number(r1?.total_score)).toBe(4);

    // instructor hand-grades the free-text question by applying its rubric check (+5)
    const { data: ftCheck } = await supabase
      .from("rubric_checks")
      .select("id, data")
      .eq("rubric_id", assignment.grading_rubric_id as number);
    const check = (ftCheck ?? []).find(
      (c) => (c.data as { exam_question_id?: number } | null)?.exam_question_id === ftQ.id
    )!;
    expect(check).toBeTruthy();

    await supabase.from("submission_comments").insert({
      submission_id: submissionId as number,
      submission_review_id: sub!.grading_review_id as number,
      author: instructor.private_profile_id,
      class_id: course.id,
      rubric_check_id: check.id,
      points: 5,
      comment: "Full marks",
      released: true
    });

    // total = objective auto-grade (4) + manual rubric (5) = 9
    const { data: r2 } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", sub!.grading_review_id as number)
      .single();
    expect(Number(r2?.total_score)).toBe(9);
  });

  // Regression for #19: exam_upsert_questions_and_regions used to delete+reinsert the whole
  // tree, minting new exam_questions.id every save. exam_sync_rubric_from_questions matches
  // rubric rows by {exam_question_id}, so it could never re-match and re-scaffolded a fresh
  // rubric generation on every draft re-save (the `locked` guard only kicks in after a
  // submission exists). The fix UPSERTs by id, keeping ids stable across re-saves.
  test("re-saving a draft keeps question ids stable and does not duplicate the rubric (#19)", async () => {
    test.setTimeout(120_000);

    const course = await createClass({ name: "Quiz rubric re-save" });
    await createUserInClass({ role: "instructor", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Re-save Quiz",
      due_date: addDays(new Date(), 7).toISOString()
    });
    expect(assignment.grading_rubric_id).toBeTruthy();
    const rubricId = assignment.grading_rubric_id as number;

    const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "generated",
      p_num_pages: 0,
      p_delivery_mode: "in_app"
    });
    expect(examErr).toBeNull();

    // First save: a 3-level tree authored fresh — client_ids only, no db ids.
    const { error: e1 } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [
        { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
        { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Section", points: 10 },
        {
          client_id: "i1",
          parent_client_id: "q1",
          level: 3,
          ordinal: 0,
          label: "2+2?",
          answer_type: "numeric",
          points: 4,
          correct_answer: { value: 4 }
        },
        {
          client_id: "i2",
          parent_client_id: "q1",
          level: 3,
          ordinal: 1,
          label: "Explain",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: []
    });
    expect(e1).toBeNull();

    const loadQuestions = async () => {
      const { data } = await supabase
        .from("exam_questions")
        .select("id, parent_id, level, ordinal, label, answer_type, points, correct_answer")
        .eq("exam_id", examId as number)
        .order("level")
        .order("ordinal");
      return data ?? [];
    };
    const countRubric = async () => ({
      parts:
        (await supabase.from("rubric_parts").select("id", { count: "exact", head: true }).eq("rubric_id", rubricId))
          .count ?? 0,
      criteria:
        (await supabase.from("rubric_criteria").select("id", { count: "exact", head: true }).eq("rubric_id", rubricId))
          .count ?? 0,
      checks:
        (await supabase.from("rubric_checks").select("id", { count: "exact", head: true }).eq("rubric_id", rubricId))
          .count ?? 0
    });

    // The assignment's grading rubric ships with default scaffolding, so assert on the DELTA
    // the sync adds (not absolute counts), measured against a pre-sync baseline.
    const rubricBefore = await countRubric();
    expect(
      (await supabase.rpc("exam_sync_rubric_from_questions", { p_exam_id: examId as number, p_rubric_id: rubricId }))
        .error
    ).toBeNull();

    const afterFirst = await loadQuestions();
    const idsAfterFirst = new Set(afterFirst.map((q) => q.id));
    const rubricAfterFirst = await countRubric();
    // sync scaffolds exactly +1 part (the L1) + 1 criteria (the L2) + 2 checks (the two L3 leaves)
    expect({
      parts: rubricAfterFirst.parts - rubricBefore.parts,
      criteria: rubricAfterFirst.criteria - rubricBefore.criteria,
      checks: rubricAfterFirst.checks - rubricBefore.checks
    }).toEqual({ parts: 1, criteria: 1, checks: 2 });

    // Re-load exactly as the client does: fresh client_ids, db id echoed back, parent remapped.
    // Tweak a label to prove the matched rubric row is UPDATEd (not duplicated).
    const idToClient = new Map<number, string>();
    afterFirst.forEach((q, i) => idToClient.set(q.id, `c${i}`));
    const secondPayload = afterFirst.map((q) => ({
      id: q.id,
      client_id: idToClient.get(q.id)!,
      parent_client_id: q.parent_id != null ? (idToClient.get(q.parent_id) ?? null) : null,
      level: q.level,
      ordinal: q.ordinal,
      label: q.label === "Part A" ? "Part A (edited)" : q.label,
      answer_type: q.answer_type ?? undefined,
      points: q.points ?? undefined,
      correct_answer: q.correct_answer ?? undefined
    }));
    const { error: e2 } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: secondPayload,
      p_regions: []
    });
    expect(e2).toBeNull();
    expect(
      (await supabase.rpc("exam_sync_rubric_from_questions", { p_exam_id: examId as number, p_rubric_id: rubricId }))
        .error
    ).toBeNull();

    // ids preserved across the re-save (the heart of #19)...
    const afterSecond = await loadQuestions();
    expect(new Set(afterSecond.map((q) => q.id))).toEqual(idsAfterFirst);
    // ...rubric did NOT grow (no duplicate generation)...
    expect(await countRubric()).toEqual(rubricAfterFirst);
    // ...and the edit propagated to the existing (matched) rubric part.
    const { data: parts } = await supabase.from("rubric_parts").select("name").eq("rubric_id", rubricId);
    expect(parts?.map((p) => p.name)).toContain("Part A (edited)");
  });
});
