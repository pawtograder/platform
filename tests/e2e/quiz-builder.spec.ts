import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, createUserInClass, insertAssignment, loginAsUser, supabase } from "./TestingUtils";

/**
 * Phase 3: the question-first quiz builder. An instructor authors a question + answer key
 * in the browser, saves, and we assert the generated assessment definition landed in the
 * DB: a 'generated'/'in_app' exam, the question with its answer key, an answer region per
 * leaf (laid out by us, not OCR'd), and a rubric scaffolded from the tree.
 *
 * Requires the app server + Edge Functions (full e2e harness), like the other UI specs.
 */
test.describe("Quiz builder", () => {
  test("instructor builds a quiz; generate persists exam + questions + regions + rubric", async ({ page }) => {
    test.setTimeout(120_000);

    const course = await createClass({ name: "Quiz builder E2E" });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Built Quiz",
      due_date: addDays(new Date(), 7).toISOString()
    });
    await supabase.from("assignments").update({ assignment_type: "quiz" }).eq("id", assignment.id);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/quiz`);

    // add a single (leaf) numeric question with an answer key
    await page.getByRole("button", { name: "+ Part (level 1)" }).click();
    await page.getByPlaceholder("Label").first().fill("6 * 7 = ?");
    await page.getByPlaceholder("Prompt (shown to students / printed)").first().fill("Compute the product.");
    // the answer-type select is the first NativeSelect inside the leaf config
    await page.locator("select").filter({ hasText: "free_text" }).first().selectOption("numeric");
    await page.getByPlaceholder("correct value").fill("42");
    await page.getByPlaceholder("± tolerance").fill("0.5");
    await page.getByPlaceholder("pts").first().fill("4");

    await page.getByRole("button", { name: "Save & generate" }).click();

    // wait for the exam to be created by the builder
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("exams")
            .select("id, template_source_type, delivery_mode")
            .eq("assignment_id", assignment.id)
            .maybeSingle();
          return data?.template_source_type ?? null;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("generated");

    const { data: exam } = await supabase
      .from("exams")
      .select("id, delivery_mode, num_pages")
      .eq("assignment_id", assignment.id)
      .single();
    expect(exam?.delivery_mode).toBe("in_app");
    expect(Number(exam?.num_pages)).toBeGreaterThanOrEqual(1);

    // the question persisted with its objective answer key
    const { data: qs } = await supabase
      .from("exam_questions")
      .select("answer_type, points, correct_answer, grading_tolerance")
      .eq("exam_id", exam!.id);
    expect(qs?.length).toBe(1);
    expect(qs![0].answer_type).toBe("numeric");
    expect(Number(qs![0].points)).toBe(4);
    expect((qs![0].correct_answer as { value: number }).value).toBe(42);

    // we laid out the page, so an answer region exists for the leaf + identity regions
    const { data: regions } = await supabase
      .from("exam_question_regions")
      .select("kind, exam_question_id")
      .eq("exam_id", exam!.id);
    expect((regions ?? []).some((r) => r.kind === "answer" && r.exam_question_id != null)).toBe(true);
    expect((regions ?? []).some((r) => r.kind === "name")).toBe(true);
    expect((regions ?? []).some((r) => r.kind === "student_id")).toBe(true);

    // rubric scaffolded from the question tree (back-reference present)
    const { data: checks } = await supabase
      .from("rubric_checks")
      .select("data")
      .eq("rubric_id", assignment.grading_rubric_id as number);
    expect((checks ?? []).some((c) => (c.data as { exam_question_id?: number } | null)?.exam_question_id)).toBe(true);
  });
});
