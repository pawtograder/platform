/**
 * #1010: the grading screens follow grade_submissions and release_grades
 * (20261124150200_grading_and_release_by_capability.sql), so a control shows exactly when the
 * database allows it.
 *
 * On a released, completed grading review:
 *   - a default grader (grade_submissions only) sees "Grading is locked" in the rubric sidebar, sees
 *     "Released to student: Yes" without an Unrelease button, and on the assignment page sees
 *     Finalize grading but not Release all, Unrelease all or the per-submission release controls;
 *   - a Head TA on a custom role with release_grades (#1353) sees no lock, sees Unrelease, and sees
 *     the release controls; pressing Unrelease works;
 *   - an instructor sees the same as before.
 */
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

test.describe.configure({ mode: "serial" });

test.describe("grading and release controls gated by grade_submissions and release_grades", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  let submissionId: number;
  let gradingReviewId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Grading Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id });
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), -1).toISOString(),
      name: `E2E Grading Gates ${suffix}`,
      assignment_slug: `e2e-grading-gates-${suffix}`
    });
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = submission.submission_id;
    gradingReviewId = submission.grading_review_id;

    // A rubric check from the grader, then the review completed and released.
    const check = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2")!;
    expect(
      (
        await supabase.from("submission_comments").insert({
          submission_id: submissionId,
          submission_review_id: gradingReviewId,
          class_id: course.id,
          author: grader.private_profile_id,
          comment: "Applied before release",
          rubric_check_id: check.id,
          points: check.points,
          released: false,
          eventually_visible: true
        })
      ).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("submission_reviews")
          .update({
            completed_at: new Date().toISOString(),
            completed_by: grader.private_profile_id,
            released: true
          })
          .eq("id", gradingReviewId)
      ).error
    ).toBeNull();

    // Head TA: a copy of the grader role with release_grades turned on.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Head TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "release_grades" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", headTa.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();
  });

  const submissionUrl = () => `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}`;
  const dashboardUrl = () => `/course/${course.id}/manage/assignments/${assignment.id}`;

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  async function waitForCapabilities(page: Page, url: string) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await page.goto(url);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached({ timeout: 60_000 });
  }

  async function openFiles(page: Page) {
    await waitForCapabilities(page, `${submissionUrl()}/files`);
    await expect(page.getByRole("region", { name: "Grading check Grading Review Check 2" }).first()).toBeVisible({
      timeout: 60_000
    });
  }

  async function openSubmission(page: Page) {
    await waitForCapabilities(page, submissionUrl());
    await expect(page.getByText(/Released to student/).first()).toBeVisible({ timeout: 60_000 });
  }

  async function openDashboard(page: Page) {
    await waitForCapabilities(page, dashboardUrl());
    await expect(page.getByRole("button", { name: "Finalize grading" })).toBeVisible({ timeout: 60_000 });
  }

  const releaseControls = ["Release all", "Unrelease all"];

  test("a default grader's marks are locked on a released review, and they can't release", async ({ page }) => {
    await loginAsUser(page, grader, course);

    await openFiles(page);
    await expect(page.getByText("Grading is locked").first()).toBeVisible();

    await openSubmission(page);
    await expect(page.getByText("Released to studentYes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unrelease", exact: true })).toHaveCount(0);

    await openDashboard(page);
    for (const name of releaseControls) {
      await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(0);
    }
    await expect(page.getByText("Select submissions below to release or unrelease their grading.")).toHaveCount(0);
  });

  test("an instructor still edits released grades and sees the release controls", async ({ page }) => {
    await loginAsUser(page, instructor, course);

    await openFiles(page);
    await expect(page.getByText("Grading is locked")).toHaveCount(0);

    await openSubmission(page);
    await expect(page.getByRole("button", { name: "Unrelease", exact: true })).toBeVisible();

    await openDashboard(page);
    for (const name of releaseControls) {
      await expect(page.getByRole("button", { name, exact: true }).first(), name).toBeVisible();
    }
    await expect(
      page.getByText("Select submissions below to release or unrelease their grading.").first()
    ).toBeVisible();
  });

  test("a Head TA with release_grades isn't locked, sees the release controls, and can unrelease", async ({ page }) => {
    await loginAsUser(page, headTa, course);

    await openFiles(page);
    await expect(page.getByText("Grading is locked")).toHaveCount(0);

    await openDashboard(page);
    for (const name of releaseControls) {
      await expect(page.getByRole("button", { name, exact: true }).first(), name).toBeVisible();
    }
    await expect(
      page.getByText("Select submissions below to release or unrelease their grading.").first()
    ).toBeVisible();

    await openSubmission(page);
    await page.getByRole("button", { name: "Unrelease", exact: true }).click();
    await expect(async () => {
      const { data, error } = await supabase
        .from("submission_reviews")
        .select("released")
        .eq("id", gradingReviewId)
        .single();
      expect(error).toBeNull();
      expect(data!.released).toBe(false);
    }).toPass({ timeout: 30_000 });
  });
});
