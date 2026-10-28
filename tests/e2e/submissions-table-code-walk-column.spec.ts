/**
 * Browser coverage for the code-walk release column of the instructor submissions table
 * (assignmentsTable.tsx).
 *
 * Code walks are released separately from the grading review, so on an assignment with a
 * code-walk rubric the table labels the grading column "Grading released" and adds "Code walk
 * released". An assignment without a code-walk rubric keeps the single "Released" column. After
 * "Release code walks" on the grading status panel, the panel's refetch must flip the completed
 * code walk's cell while the grading column stays as it was.
 *
 * Chromium only: the suite checks one table render and one panel action.
 */
import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import type { Locator, Page } from "@playwright/test";
import type { Course } from "@/utils/supabase/DatabaseTypes";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

/** The submissions table; the dashboard renders other tables, but only this one has bulk selection. */
function submissionsTable(page: Page): Locator {
  return page
    .locator("table")
    .filter({ has: page.getByRole("checkbox", { name: "Select all rows matching current filters" }) });
}

function headers(page: Page): Locator {
  return submissionsTable(page).locator("thead th");
}

function rowFor(page: Page, studentName: string): Locator {
  return submissionsTable(page).locator("tbody tr").filter({ hasText: studentName });
}

/** The body cell for `studentName` under the header whose text starts with `headerText`. */
async function cellFor(page: Page, studentName: string, headerText: string): Promise<Locator> {
  const texts = await headers(page).allInnerTexts();
  const index = texts.findIndex((t) => t.trim().startsWith(headerText));
  expect(index, `header "${headerText}" in ${JSON.stringify(texts)}`).toBeGreaterThanOrEqual(0);
  return rowFor(page, studentName).locator("td").nth(index);
}

/** Open the confirm popover for `label` and click its confirm button. */
async function confirmPanelAction(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  const popover = page.locator('[data-scope="popover"][data-part="content"][data-state="open"]');
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: label, exact: true }).click();
}

test.describe("Submissions table: code walk released column", () => {
  test.describe.configure({ timeout: 180_000 });

  let course: Course;
  let instructor: TestingUser;
  /** [0] completed code walk, [1] incomplete code walk, [2] no submission. */
  let students: TestingUser[];
  let plainAssignmentId: number;
  let codeWalkAssignmentId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: "Code walk column e2e" });
    const stamp = Date.now();
    [instructor] = await createUsersInClass([
      {
        name: "Column Code Walk Instructor",
        email: `column-codewalk-instructor-${stamp}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    students = await createUsersInClass(
      [0, 1, 2].map((i) => ({
        name: `Column Code Walk Student ${i}`,
        email: `column-codewalk-student-${i}-${stamp}@pawtograder.net`,
        role: "student" as const,
        class_id: course.id,
        useMagicLink: true
      }))
    );

    const plain = await insertAssignment({
      class_id: course.id,
      name: "No code walk assignment",
      due_date: addDays(new Date(), 3).toUTCString(),
      release_date: addDays(new Date(), -3).toUTCString()
    });
    plainAssignmentId = plain.id;
    await insertPreBakedSubmission({
      assignment_id: plain.id,
      class_id: course.id,
      student_profile_id: students[0].private_profile_id
    });

    const withCodeWalk = await insertAssignment({
      class_id: course.id,
      name: "Code walk assignment",
      due_date: addDays(new Date(), 3).toUTCString(),
      release_date: addDays(new Date(), -3).toUTCString()
    });
    codeWalkAssignmentId = withCodeWalk.id;
    const submissions = [];
    for (const s of students.slice(0, 2)) {
      submissions.push(
        await insertPreBakedSubmission({
          assignment_id: withCodeWalk.id,
          class_id: course.id,
          student_profile_id: s.private_profile_id
        })
      );
    }

    // Inserting the rubric backfills a code-walk review for each existing submission.
    const { data: rubric, error: rubricError } = await supabase
      .from("rubrics")
      .insert({ class_id: course.id, assignment_id: withCodeWalk.id, name: "Code Walk", review_round: "code-walk" })
      .select("id")
      .single();
    if (rubricError) throw new Error(`code walk rubric insert failed: ${rubricError.message}`);

    const { data: completedReview, error: lookupError } = await supabase
      .from("submission_reviews")
      .select("id")
      .eq("submission_id", submissions[0].submission_id)
      .eq("rubric_id", rubric.id)
      .single();
    if (lookupError) throw new Error(`code walk review lookup failed: ${lookupError.message}`);
    const { error: completeError } = await supabase
      .from("submission_reviews")
      .update({ completed_at: new Date().toISOString(), completed_by: instructor.private_profile_id })
      .eq("id", completedReview.id);
    if (completeError) throw new Error(`complete code walk failed: ${completeError.message}`);
  });

  test("without a code-walk rubric the table keeps a single Released column", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium only");
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${plainAssignmentId}`);
    await expect(rowFor(page, students[0].private_profile_name)).toBeVisible({
      timeout: 60_000
    });
    await expect(headers(page).filter({ hasText: /^Released/ })).toHaveCount(1);
    await expect(headers(page).filter({ hasText: "Grading released" })).toHaveCount(0);
    await expect(headers(page).filter({ hasText: "Code walk released" })).toHaveCount(0);
  });

  test("Release code walks flips the code walk column and leaves the grading column alone", async ({
    page,
    browserName
  }) => {
    test.skip(browserName !== "chromium", "Chromium only");
    const [completed, incomplete, nonSubmitter] = students.map((s) => s.private_profile_name);
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${codeWalkAssignmentId}`);
    await expect(rowFor(page, completed)).toBeVisible({ timeout: 60_000 });

    await expect(headers(page).filter({ hasText: /^Released/ })).toHaveCount(0);
    await expect(headers(page).filter({ hasText: "Grading released" })).toHaveCount(1);
    await expect(headers(page).filter({ hasText: "Code walk released" })).toHaveCount(1);

    const completedCodeWalk = await cellFor(page, completed, "Code walk released");
    await expect(completedCodeWalk.locator('[aria-label="Not released"]')).toBeVisible();
    await expect(await cellFor(page, incomplete, "Code walk released")).toHaveText("Incomplete");
    await expect(await cellFor(page, nonSubmitter, "Code walk released")).toHaveText("—");

    const gradingCell = await cellFor(page, completed, "Grading released");
    const gradingBefore = await gradingCell.innerHTML();

    await confirmPanelAction(page, "Release code walks");
    await expect(page.getByText("Released 1 code walk in this assignment.").first()).toBeVisible({
      timeout: 30_000
    });

    await expect(completedCodeWalk.locator('[aria-label="Released"]')).toBeVisible({ timeout: 15_000 });
    await expect(await cellFor(page, incomplete, "Code walk released")).toHaveText("Incomplete");
    expect(await (await cellFor(page, completed, "Grading released")).innerHTML()).toBe(gradingBefore);
  });
});
