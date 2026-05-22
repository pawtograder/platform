/**
 * Submission history realtime review updates (issue #598).
 *
 * Bug: the "Submission History" popover shows a "Total Score" column sourced from
 * submission_reviews, but the only realtime listener on that list fired on
 * `submissions` is_active changes — not on submission_review completion. So when
 * an instructor completed manual grading (e.g. after reactivating an older
 * submission), the manually-graded total stayed stale in the history until a
 * full page reload, even though the gradebook and the big "Overall Score" on the
 * page updated correctly.
 *
 * This test opens the student-facing submission history popover, then completes
 * the grading review out-of-band (DB), and asserts the Total Score cell *inside
 * the history table* updates without a reload. The assertion is deliberately
 * scoped to the history table: the page-level "Overall Score" already updated via
 * its own realtime subscription, so an unscoped assertion would pass even with
 * the bug present.
 *
 * Chromium only (default project). Requires: local Supabase + `npm run dev` on
 * port 3000 (or BASE_URL for deployed E2E).
 */
import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  dismissTimeZonePreferenceModal,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";
import type { TestingUser } from "./TestingUtils";

const GRADED_TOTAL = 42;
const GRADED_TOTAL_TEXT = `${GRADED_TOTAL}/100`; // total_points defaults to 100 in insertAssignment.

test.describe("Submission history review realtime (issue #598)", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let assignmentId: number;
  let instructor: TestingUser;
  let student: TestingUser;
  let submissionId: number;
  let gradingReviewId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Submission History RT ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Sub History Instructor ${suffix}`,
      email: `e2e-subhist-inst-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Sub History Student ${suffix}`,
      email: `e2e-subhist-stu-${suffix}@pawtograder.net`
    });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -1).toISOString(),
      name: `E2E Sub History Assignment ${suffix}`,
      assignment_slug: `e2e-sub-history-${suffix}`
    });
    assignmentId = assignment.id;

    const submission = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `sub-history-rt-${classId}`
    });
    submissionId = submission.submission_id;
    gradingReviewId = submission.grading_review_id;
  });

  test("history Total Score updates in realtime when grading is completed", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium only (matches the rest of the realtime UI e2e suite)");

    await loginAsUser(page, student);

    await page.goto(`/course/${classId}/assignments/${assignmentId}/submissions/${submissionId}/results`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForLoadState("networkidle");
    await dismissTimeZonePreferenceModal(page, 10_000);

    // Open the submission history popover.
    const historyButton = page.getByRole("button", { name: "Submission History" });
    await expect(historyButton).toBeVisible({ timeout: 30_000 });
    await historyButton.click();

    // Scope every assertion to the popover content so the page-level "Overall
    // Score" / rubric totals can't mask the bug — the page-level review score
    // updates via its own subscription, but the history popover is the surface
    // that regressed in #598.
    const historyPopover = page
      .locator('[data-scope="popover"][data-part="content"]')
      .filter({ hasText: "Submission History" });
    await expect(historyPopover).toBeVisible({ timeout: 15_000 });

    // Wait for the history row to load (autograder score 5/10 from the prebaked
    // submission) so the absence check below is meaningful rather than racing the
    // initial query, and so the realtime channel is set up before grading.
    await expect(historyPopover.getByText("5/10")).toBeVisible({ timeout: 30_000 });

    // Grading has not been completed yet, so the history shows no graded total.
    await expect(historyPopover.getByText(GRADED_TOTAL_TEXT)).toHaveCount(0);

    // Complete the manual grading review out-of-band, the same way the gradebook
    // recalc flow does. With the popover open, this must propagate to the history
    // table via the submission_reviews realtime channel. We re-apply inside a
    // toPass loop so a broadcast that arrives before the realtime channel has
    // finished subscribing is retried rather than flaking — without the fix, no
    // listener exists at all and the cell never updates regardless of retries.
    await expect(async () => {
      const { error } = await supabase
        .from("submission_reviews")
        .update({
          completed_at: new Date().toISOString(),
          completed_by: instructor.private_profile_id,
          released: true,
          total_score: GRADED_TOTAL
        })
        .eq("id", gradingReviewId);
      expect(error).toBeNull();

      await expect(historyPopover.getByText(GRADED_TOTAL_TEXT)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
  });
});
