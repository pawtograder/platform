import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";

/**
 * A finalized paper exam submission as the exam worker leaves it: the scanned page as a binary PNG
 * submission file, plus the exam_v1 artifact. The artifact has no page images, so the renderer
 * shows "(page image unavailable)" next to the OCR text, which is enough to tell students apart.
 */
async function examSubmission(classId: number, assignmentId: number, ocrText: string) {
  const student = await createUserInClass({ role: "student", class_id: classId });
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
