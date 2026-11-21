import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

// Regression coverage for #1125 / #983 (PR 1 of the error-surfacing stack).
//
// When RLS refuses an UPDATE, PostgREST matches 0 rows and answers `200 []`. `@refinedev/supabase`
// turned that into `{ data: undefined }` with no error, so Edit Assignment showed the green
// "Assignment Updated" toast for a save that never happened. `lib/refineDataProvider.ts` now throws
// a 403 when an update returns no row, so the page's existing catch shows "Update Error" instead.
//
// Since #1199, edit/layout.tsx sends anyone without manage_assignments back to the assignment list,
// so a default grader can no longer reach Save. The page can still be out of date, though: here a
// grader on a custom role that holds manage_assignments opens Edit Assignment, and the capability is
// then taken off that role (an instructor editing the role, in real life) before Save is clicked.
// The page still renders the form, but RLS on `assignments` now refuses the UPDATE. Before the
// provider fix that showed "Assignment Updated".
//
// The unit tests in tests/unit/refine-data-provider.test.ts cover the provider logic with stubbed
// responses; this test is the end-to-end proof against real RLS.
//
// Save is clicked WITHOUT editing any field. The edit page renders the form twice (responsive
// variants in ManageAssignmentNav.tsx) and react-hook-form binds to the last-mounted one, so typed
// edits are unreliable under Playwright (see assignment-repo-config-form.test.tsx). An unchanged
// save still issues the UPDATE, which is all RLS needs to refuse.
//
// The assignment is created with repo_mode "none", so it has no handout repo. With a handout, a
// save that the provider wrongly treats as successful goes on to call githubRepoConfigureWebhook,
// and that call's failure also shows "Update Error". The Update Error check then passed even with
// the fix reverted. With no handout, the unfixed page reaches "Assignment Updated", which is the
// bug in #983.
//
// The second test covers deletes (#1127): Delete on Manage Review Assignments said "Review
// assignment deleted" when RLS refused the delete, because upstream `deleteOne` never asks for rows
// back. Same setup: the grader's role holds manage_review_assignments while the page loads, and
// loses it before Delete is confirmed. The review assignment is assigned to the grader. That
// matters: SELECT and DELETE on review_assignments share the manage_review_assignments check, so
// without the capability the grader can still see (and so the provider can still find) only the
// reviews assigned to them, through "Assignees can view their own review assignments". For a
// review assigned to someone else the row is invisible after the revoke, and the provider can't
// tell a refused delete from an already-deleted row (see withBlockedDeleteErrors).

const RUN_PREFIX = getTestRunPrefix();
const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let course: Course;
let grader: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: Assignment;
let editorRoleId: number;
let reviewAssignmentId: number;

const futureDue = addDays(new TZDate(new Date(), "America/New_York"), 14);
futureDue.setHours(9, 0, 0, 0);

test.describe("Writes refused by RLS surface an error", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    course = await createClass({ name: `Refused Writes ${RUN_PREFIX}` });
    grader = await createUserInClass({
      role: "grader",
      class_id: course.id,
      email: `refused-writes-grader-${SAFE_ID}@pawtograder.net`,
      name: `Refused Writes Grader ${RUN_PREFIX}`,
      useMagicLink: true
    });
    assignment = await insertAssignment({
      class_id: course.id,
      name: `Refused Writes Target ${RUN_PREFIX}`,
      assignment_slug: `rw-${SAFE_ID.slice(-8)}`,
      due_date: futureDue.toUTCString(),
      repo_mode: "none"
    });

    // A review assignment for the delete test, assigned to the grader (see the header comment).
    student = await createUserInClass({
      role: "student",
      class_id: course.id,
      email: `refused-writes-student-${SAFE_ID}@pawtograder.net`,
      name: `Refused Writes Student ${RUN_PREFIX}`
    });
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    const { data: reviewAssignment, error: reviewAssignmentError } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: grader.private_profile_id,
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        rubric_id: assignment.grading_rubric_id!,
        due_date: addDays(new Date(), 1).toUTCString()
      })
      .select("id")
      .single();
    expect(reviewAssignmentError).toBeNull();
    reviewAssignmentId = reviewAssignment!.id;

    // A custom role holding manage_assignments and manage_review_assignments, with the grader on it,
    // so edit/layout.tsx lets them in and Manage Review Assignments shows the Delete button. Each
    // test takes away only the capability it needs gone.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: `Assignment Editor ${SAFE_ID}` })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    editorRoleId = role!.id;

    const { error: capabilityError } = await supabase.from("role_capabilities").insert([
      { role_id: editorRoleId, capability: "manage_assignments" },
      { role_id: editorRoleId, capability: "manage_review_assignments" }
    ]);
    expect(capabilityError).toBeNull();

    const { error: assignError } = await supabase
      .from("user_roles")
      .update({ class_role_id: editorRoleId })
      .eq("user_id", grader!.user_id)
      .eq("class_id", course.id);
    expect(assignError).toBeNull();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([grader]);
  });

  async function revokeCapability(capability: "manage_assignments" | "manage_review_assignments") {
    const { error } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", editorRoleId)
      .eq("capability", capability);
    expect(error).toBeNull();
  }

  test("saving Edit Assignment after losing manage_assignments shows an error, not 'Assignment Updated'", async ({
    page
  }) => {
    const { data: before, error: beforeError } = await supabase
      .from("assignments")
      .select("title, updated_at")
      .eq("id", assignment.id)
      .single();
    expect(beforeError).toBeNull();

    await loginAsUser(page, grader!, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Assignment" }).first()).toBeVisible();
    // Wait for the loaded row to reach the form, so Save sends a real UPDATE for this id.
    await expect(page.getByLabel("Title", { exact: false }).first()).toHaveValue(assignment.title);
    // The self-evaluation settings load in a second query (edit/page.tsx). Until they arrive,
    // eval_config is empty, its `required` check fails, and Save never submits: the form only
    // marks "Require self-evaluation" invalid. That was the chromium flake on 7dd3dde6. insertAssignment
    // creates the settings with enabled: true, so "use_eval" means they reached the form.
    await expect(page.locator('select[name="eval_config"]:visible').first()).toHaveValue("use_eval");

    // The page is open; now take manage_assignments away, as an instructor editing the role would.
    await revokeCapability("manage_assignments");

    // The visual-test fixture hides the toaster (display:none); turn it off so the toast is visible.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    await page
      .locator("button:visible", { hasText: /^Save$/ })
      .first()
      .click();

    // The refusal is reported with the provider's message.
    await expect(page.getByText("Update Error").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/don't have permission to change this/).first()).toBeVisible();
    // ...and the false success the bug produced is gone.
    await expect(page.getByText("Assignment Updated")).toHaveCount(0);

    // The database agrees nothing changed.
    const { data: after } = await supabase
      .from("assignments")
      .select("title, updated_at")
      .eq("id", assignment.id)
      .single();
    expect(after).toEqual(before);
  });

  test("deleting a review assignment after losing manage_review_assignments shows an error, not 'deleted'", async ({
    page
  }) => {
    await loginAsUser(page, grader!, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/reviews`);
    await expect(page.getByRole("heading", { name: "Manage Review Assignments" }).first()).toBeVisible();
    await page.getByRole("tab", { name: "All Assignments" }).click();
    // The row is loaded and the grader still holds the capability, so its Delete button is there.
    const row = page.getByRole("row").filter({ hasText: student!.private_profile_name });
    const deleteButton = row.getByRole("button", { name: "Delete review assignment" });
    await expect(deleteButton).toBeVisible({ timeout: 30_000 });

    // The page is open; now take manage_review_assignments away.
    await revokeCapability("manage_review_assignments");

    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    await deleteButton.click();
    await page.getByRole("button", { name: "Confirm action" }).click();

    // RLS refused the delete, and the row is still visible to the grader as its assignee, so the
    // provider reports a refusal and the page's onError shows it.
    await expect(page.getByText("Error deleting review assignment").first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText("You don't have permission to delete this. Nothing was changed.").first()
    ).toBeVisible();
    await expect(page.getByText("Review assignment deleted")).toHaveCount(0);

    // The database agrees nothing was deleted.
    const { data: after, error: afterError } = await supabase
      .from("review_assignments")
      .select("id")
      .eq("id", reviewAssignmentId);
    expect(afterError).toBeNull();
    expect(after).toEqual([{ id: reviewAssignmentId }]);
  });
});
