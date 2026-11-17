import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

/**
 * A finalized paper exam submission as the exam worker leaves it: the scanned page as a binary PNG
 * submission file, plus the exam_v1 artifact. The artifact has no page images, so the renderer
 * shows "(page image unavailable)" next to the OCR text, which is enough to tell students apart.
 */
async function examSubmission(classId: number, assignmentId: number, ocrText: string, owner?: TestingUser) {
  const student = owner ?? (await createUserInClass({ role: "student", class_id: classId }));
  const submission = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignmentId,
    class_id: classId,
    files: [{ name: "exam-page-1.png", contents: "" }]
  });
  const { error: fileErr } = await supabase
    .from("submission_files")
    .update({ is_binary: true, mime_type: "image/png" })
    .eq("submission_id", submission.submission_id);
  expect(fileErr).toBeNull();
  const { error: artErr } = await supabase.from("submission_artifacts").insert({
    submission_id: submission.submission_id,
    class_id: classId,
    profile_id: student.private_profile_id,
    name: "Exam",
    data: {
      format: "exam_v1",
      pages: [],
      questions: [
        {
          exam_question_id: 1,
          page_number: 1,
          region: { x: 0, y: 0, width: 1, height: 1 },
          ocr_text: ocrText,
          structured_value: null
        }
      ]
    }
  });
  expect(artErr).toBeNull();
  return submission.submission_id;
}

test.describe("Grader view of a paper exam (#1267)", () => {
  test("opens on the Exam artifact, and Next opens the next student's", async ({ page }) => {
    const course = await createClass({ name: "Exam grader default view E2E" });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Midterm Exam",
      assignment_type: "exam",
      due_date: addDays(new Date(), 7).toISOString()
    });
    const answers = new Map<number, string>();
    for (const text of ["First student's answer", "Second student's answer"]) {
      answers.set(await examSubmission(course.id, assignment.id, text), text);
    }

    await loginAsUser(page, instructor, course);
    const filesUrl = (id: number) => `/course/${course.id}/assignments/${assignment.id}/submissions/${id}/files`;
    const next = page.getByRole("link", { name: "Next" });
    // Start on whichever submission the toolbar puts first, so there is a Next to click.
    const [a, b] = [...answers.keys()];
    await page.goto(filesUrl(a));
    // With two submissions, exactly one of Previous and Next shows. Wait for the toolbar first.
    await expect(next.or(page.getByRole("link", { name: "Previous" }))).toBeVisible();
    if (!(await next.isVisible())) await page.goto(filesUrl(b));
    const first = page.url().includes(`/submissions/${a}/`) ? a : b;
    const second = first === a ? b : a;

    // The crops, not the scanned page. Before the fix this showed exam-page-1.png.
    await expect(page.getByText(answers.get(first)!)).toBeVisible();
    await expect(page.getByText("(page image unavailable)")).toBeVisible();

    await next.click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${second}/files`));
    await expect(page.getByText(answers.get(second)!)).toBeVisible();
  });
});

test.describe("The rubric line above a paper exam (#1269)", () => {
  async function examAssignment(name: string) {
    const course = await createClass({ name });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Midterm Exam",
      assignment_type: "exam",
      due_date: addDays(new Date(), 7).toISOString()
    });
    return { course, instructor, assignment };
  }
  // Records whether a wrong line ever reached the page, from the first paint on: a message that is
  // only right once everything has loaded must not flash the wrong one first.
  async function watchFor(page: Page, texts: string[]) {
    await page.addInitScript((wrong: string[]) => {
      const w = window as unknown as { __wrongRubricLine?: string };
      new MutationObserver(() => {
        const text = document.body?.innerText ?? "";
        for (const t of wrong) if (text.includes(t)) w.__wrongRubricLine ??= t;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, texts);
    return async () => page.evaluate(() => (window as unknown as { __wrongRubricLine?: string }).__wrongRubricLine);
  }
  const filesUrl = (courseId: number, assignmentId: number, id: number) =>
    `/course/${courseId}/assignments/${assignmentId}/submissions/${id}/files`;

  test("staff see that the exam's questions are graded in the rubric panel", async ({ page }) => {
    const { course, instructor, assignment } = await examAssignment("Exam rubric line E2E");
    // The exam's rubric as the template editor builds it: one question, one generated check.
    const { data: examId } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "pdf",
      p_num_pages: 1
    });
    const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
      p_exam_id: examId as number,
      p_questions: [
        {
          client_id: "q1",
          parent_client_id: null,
          level: 1,
          ordinal: 0,
          label: "Q1",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: [{ question_client_id: "q1", kind: "answer", page_number: 1, x: 0.1, y: 0.3, width: 0.8, height: 0.2 }]
    });
    expect(structErr).toBeNull();
    const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId as number,
      p_rubric_id: assignment.grading_rubric_id as number
    });
    expect(syncErr).toBeNull();
    const id = await examSubmission(course.id, assignment.id, "An answer");

    await loginAsUser(page, instructor, course);
    const sawWrongLine = await watchFor(page, [
      "No rubric checks available for this artifact.",
      "This review has no rubric.",
      "This review's rubric has no checks yet."
    ]);
    await page.goto(filesUrl(course.id, assignment.id, id));
    await expect(page.getByText("An answer")).toBeVisible();
    await expect(page.getByText("Grade this exam's questions in the rubric panel.")).toBeVisible();
    expect(await sawWrongLine()).toBeUndefined();
  });

  test("staff see that the rubric has no checks yet, and the student sees no rubric line after release", async ({
    page
  }) => {
    const { course, instructor, assignment } = await examAssignment("Exam no rubric line E2E");
    // New assignments come with a template grading rubric that has checks; empty it.
    const { error: delErr } = await supabase
      .from("rubric_checks")
      .delete()
      .eq("rubric_id", assignment.grading_rubric_id as number);
    expect(delErr).toBeNull();
    const student = await createUserInClass({ role: "student", class_id: course.id });
    const id = await examSubmission(course.id, assignment.id, "Another answer", student);

    await loginAsUser(page, instructor, course);
    await page.goto(filesUrl(course.id, assignment.id, id));
    await expect(page.getByText("Another answer")).toBeVisible();
    await expect(page.getByText("This review's rubric has no checks yet.")).toBeVisible();

    // The student's own view of the same submission once grades are released: the review and its
    // rubric load for them, so the role check is the only thing keeping staff guidance off the page.
    const { data: released, error: relErr } = await supabase
      .from("submission_reviews")
      .update({ released: true })
      .eq("submission_id", id)
      .select("id");
    expect(relErr).toBeNull();
    expect(released?.length).toBeGreaterThan(0);
    await page.context().clearCookies();
    await loginAsUser(page, student, course);
    const sawStaffLine = await watchFor(page, [
      "No rubric checks available for this artifact.",
      "This review has no rubric.",
      "This review's rubric has no checks yet.",
      "Grade this exam's questions in the rubric panel.",
      "None of this rubric's checks apply to artifacts."
    ]);
    await page.goto(filesUrl(course.id, assignment.id, id));
    await expect(page.getByText("Another answer")).toBeVisible();
    // Let the review and rubric finish loading before judging that nothing appeared.
    await page.waitForLoadState("networkidle");
    expect(await sawStaffLine()).toBeUndefined();
  });
});
