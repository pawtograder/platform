/**
 * Browser coverage for the "Release code walks" / "Unrelease code walks" actions on the assignment
 * dashboard's grading status panel (GradingStatusPanel.tsx).
 *
 * The panel shows the actions only when the assignment has a code-walk rubric. Releasing goes
 * through release_code_walk_reviews_for_assignment, which publishes completed code walks only; the
 * student's own RLS-scoped client is the check that a released code walk is actually readable by
 * the student and an incomplete one is not. The RPC's row-level scoping is covered in
 * release-code-walk-reviews-db.spec.ts.
 *
 * Chromium only: the suite checks one confirm-popover flow and does not need a second engine.
 */
import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import type { Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { Course } from "@/utils/supabase/DatabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

/** Code-walk review ids the student's own client can read (RLS: released reviews only). */
async function codeWalkReviewsVisibleTo(client: SupabaseClient<Database>, reviewIds: number[]): Promise<number[]> {
  const { data, error } = await client.from("submission_reviews").select("id").in("id", reviewIds);
  if (error) throw new Error(`student read failed: ${error.message}`);
  return data.map((r) => r.id).sort((a, b) => a - b);
}

/** Open the confirm popover for `label` and click its confirm button. */
async function confirmPanelAction(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  // Every ConfirmButton mounts its (closed, hidden) popover content, so select the open one.
  const popover = page.locator('[data-scope="popover"][data-part="content"][data-state="open"]');
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: label, exact: true }).click();
}

test.describe("Grading status panel: release code walks", () => {
  test.describe.configure({ timeout: 180_000 });

  let course: Course;
  let instructor: TestingUser;
  let students: TestingUser[];
  let studentClients: SupabaseClient<Database>[];
  let plainAssignmentId: number;
  let codeWalkAssignmentId: number;
  /** [0] completed, [1] incomplete. */
  let codeWalkReviewIds: number[];

  test.beforeAll(async () => {
    course = await createClass({ name: "Release code walks panel e2e" });
    const stamp = Date.now();
    [instructor] = await createUsersInClass([
      {
        name: "Panel Code Walk Instructor",
        email: `panel-codewalk-instructor-${stamp}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    students = await createUsersInClass(
      [0, 1].map((i) => ({
        name: `Panel Code Walk Student ${i}`,
        email: `panel-codewalk-student-${i}-${stamp}@pawtograder.net`,
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
    for (const s of students) {
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

    codeWalkReviewIds = [];
    for (const s of submissions) {
      const { data, error } = await supabase
        .from("submission_reviews")
        .select("id")
        .eq("submission_id", s.submission_id)
        .eq("rubric_id", rubric.id)
        .single();
      if (error) throw new Error(`code walk review lookup failed: ${error.message}`);
      codeWalkReviewIds.push(data.id);
    }

    const { error: completeError } = await supabase
      .from("submission_reviews")
      .update({ completed_at: new Date().toISOString(), completed_by: instructor.private_profile_id })
      .eq("id", codeWalkReviewIds[0]);
    if (completeError) throw new Error(`complete code walk failed: ${completeError.message}`);

    studentClients = await Promise.all(students.map((s) => createAuthenticatedClient(s)));
  });

  test("the code walk actions are absent without a code-walk rubric", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium only");
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${plainAssignmentId}`);
    await expect(page.getByRole("button", { name: "Release all", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Release code walks", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unrelease code walks", exact: true })).toHaveCount(0);
  });

  test("Release code walks publishes completed code walks only, and Unrelease reverses it", async ({
    page,
    browserName
  }) => {
    test.skip(browserName !== "chromium", "Chromium only");
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${codeWalkAssignmentId}`);
    await expect(page.getByRole("button", { name: "Release code walks", exact: true })).toBeVisible({
      timeout: 60_000
    });
    await expect(page.getByRole("button", { name: "Unrelease code walks", exact: true })).toBeVisible();

    expect(await codeWalkReviewsVisibleTo(studentClients[0], codeWalkReviewIds)).toEqual([]);

    await confirmPanelAction(page, "Release code walks");
    await expect(page.getByText("Released 1 code walk in this assignment.").first()).toBeVisible({
      timeout: 30_000
    });

    // The completed code walk is now readable by its student; the incomplete one stays hidden.
    await expect(async () => {
      expect(await codeWalkReviewsVisibleTo(studentClients[0], codeWalkReviewIds)).toEqual([codeWalkReviewIds[0]]);
    }).toPass({ timeout: 15_000 });
    expect(await codeWalkReviewsVisibleTo(studentClients[1], codeWalkReviewIds)).toEqual([]);

    await confirmPanelAction(page, "Unrelease code walks");
    await expect(page.getByText("Unreleased 1 code walk in this assignment.").first()).toBeVisible({
      timeout: 30_000
    });
    await expect(async () => {
      expect(await codeWalkReviewsVisibleTo(studentClients[0], codeWalkReviewIds)).toEqual([]);
    }).toPass({ timeout: 15_000 });
  });
});
