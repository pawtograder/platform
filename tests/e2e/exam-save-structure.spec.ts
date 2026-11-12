import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  supabase
} from "./TestingUtils";

// A 1x1 transparent PNG, enough for the template page to load.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A 20-point exam whose structure is saved, and the instructor on its template page. */
async function openExamEditor(page: Page, { emptyRubric }: { emptyRubric: boolean }) {
  const course = await createClass({ name: "Exam save structure E2E" });
  // Paper exams are off unless a course opts in (#1196), and a new class has no `features`
  // entries at all, so without this the template route renders the "not enabled" notice
  // instead of the editor. Opting in here is what an instructor does before using the feature.
  await setCourseFeature(course.id, COURSE_FEATURES.EXAMS, true);
  const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const rubricId = assignment.grading_rubric_id as number;
  // insertAssignment fills the grading rubric with demo parts. A new assignment's rubric starts empty.
  if (emptyRubric) {
    for (const table of ["rubric_checks", "rubric_criteria", "rubric_parts"] as const) {
      const { error } = await supabase.from(table).delete().eq("rubric_id", rubricId);
      expect(error).toBeNull();
    }
  }

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  expect(examErr).toBeNull();
  const imagePath = `classes/${course.id}/exams/${examId}/template/page-1.png`;
  const up = await supabase.storage.from("exam-templates").upload(imagePath, PNG_1x1, {
    contentType: "image/png",
    upsert: true
  });
  expect(up.error).toBeNull();
  await supabase.from("exam_template_pages").insert({
    class_id: course.id,
    exam_id: examId as number,
    page_number: 1,
    image_path: imagePath,
    width: 1000,
    height: 1400
  });
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
  expect(structErr).toBeNull();

  await loginAsUser(page, instructor, course);
  await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/exam/template`);
  await expect(page.getByText("L3").first()).toBeVisible();

  const examChecks = async () => {
    const { data } = await supabase
      .from("rubric_checks")
      .select("points, exam_question_id")
      .eq("rubric_id", rubricId)
      .not("exam_question_id", "is", null);
    return data ?? [];
  };
  return { examChecks };
}

test.describe("Exam structure editor", () => {
  test("Save structure builds an empty grading rubric", async ({ page }) => {
    const { examChecks } = await openExamEditor(page, { emptyRubric: true });
    expect(await examChecks()).toHaveLength(0);

    await page.getByRole("button", { name: "Save structure" }).click();
    await expect(page.getByText("Saved exam structure and built the rubric")).toBeVisible();

    const checks = await examChecks();
    expect(checks).toHaveLength(2);
    expect(checks.reduce((sum, c) => sum + Number(c.points), 0)).toBe(20);
  });

  test("Save structure leaves a rubric that already has parts alone", async ({ page }) => {
    const { examChecks } = await openExamEditor(page, { emptyRubric: false });

    await page.getByRole("button", { name: "Save structure" }).click();
    await expect(page.getByText(/To apply question changes to the rubric/)).toBeVisible();
    expect(await examChecks()).toHaveLength(0);
  });

  test("lists each question under its parent (#1264)", async ({ page }) => {
    await openExamEditor(page, { emptyRubric: true });
    // Each question row's only textbox is its label. The points inputs are spinbuttons.
    const labels = () => page.getByRole("textbox").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

    // Loaded by level then ordinal, Item 1 used to show under Q2.
    await expect.poll(labels).toEqual(["Part A", "Q1", "Item 1", "Q2", "Item 2"]);

    // A new child of Q1 goes under Q1, not at the bottom of the list. Rows render Part A, Q1, Q2 with "+ child".
    await page.getByRole("button", { name: "+ child" }).nth(1).click();
    await expect.poll(labels).toEqual(["Part A", "Q1", "Item 1", "Item 3", "Q2", "Item 2"]);

    await page.getByRole("button", { name: "Save structure" }).click();
    await expect(page.getByText("Saved exam structure and built the rubric")).toBeVisible();
    await page.reload();
    await expect.poll(labels).toEqual(["Part A", "Q1", "Item 1", "Item 3", "Q2", "Item 2"]);
  });
});
