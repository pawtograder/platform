/**
 * #1010: the Repository Status actions need manage_student_repositories
 * (20261120140200_repository_status_by_capability.sql). Without it the Repository Status nav item
 * is hidden, and someone who opens the page by URL sees the table but not Retry creation, Fix
 * Permissions or Cleanup individual repositories. A Head TA on a custom role with
 * manage_student_repositories sees them and can fix permissions. Instructors see no change.
 *
 * Sync (one row, or Sync Selected) calls queue_repository_syncs, which checks manage_assignments, so
 * its button and the row checkboxes show only with manage_assignments: the instructor sees them, the
 * grader and the Head TA (who holds manage_student_repositories only) don't.
 *
 * The default instructor role holds manage_student_repositories, the default grader role doesn't.
 *
 * Nothing here reaches GitHub: the one repository is a row that was never created there, with a
 * creation_error (so Retry creation shows and the repo reconciler leaves it alone). Fix Permissions
 * skips it as not ready, and the test never presses Retry or Cleanup.
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("Repository Status actions gated by manage_student_repositories", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  let repositoryName: string;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Repo Status Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    const student = await createUserInClass({ role: "student", class_id: course.id });
    // Released next week, so nothing creates student repositories for it in the meantime.
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      name: `E2E Repo Status Gates ${suffix}`,
      assignment_slug: `e2e-repo-status-${suffix}`
    });

    repositoryName = `not-actually/e2e-repo-status-gates-${suffix}`;
    const { error: repoError } = await supabase.from("repositories").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      profile_id: student.private_profile_id,
      repository: repositoryName,
      creation_error: "E2E fixture: never created on GitHub"
    });
    expect(repoError).toBeNull();

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Repository TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .insert({ role_id: role!.id, capability: "manage_student_repositories" })
      ).error
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

  const repositoriesUrl = () => `/course/${course.id}/manage/assignments/${assignment.id}/repositories`;

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  // The table row showing means the page has loaded too.
  async function openRepositoriesPage(page: Page) {
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(page, repositoriesUrl(), `Assignment: ${assignment.title}`);
    await capabilities;
    await expect(page.getByRole("link", { name: repositoryName }).first()).toBeVisible({ timeout: 60_000 });
  }

  const actions = ["Retry creation", "Fix Permissions", "Cleanup individual repositories"];

  async function expectSyncControls(page: Page, visible: boolean) {
    const count = visible ? 1 : 0;
    await expect(page.getByRole("button", { name: "Sync", exact: true }), "Sync").toHaveCount(count);
    await expect(page.getByRole("checkbox", { name: "Select all repositories" }), "row checkboxes").toHaveCount(count);
  }

  test("a grader sees the table but not the actions or the nav item", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openRepositoriesPage(page);
    await expect(page).toHaveURL(new RegExp(`${repositoriesUrl()}$`));
    for (const name of actions) {
      await expect(page.getByRole("button", { name }), name).toHaveCount(0);
    }
    await expect(page.getByRole("link", { name: "Repository Status" })).toHaveCount(0);
    await expectSyncControls(page, false);
  });

  test("an instructor still sees the actions and the nav item", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRepositoriesPage(page);
    for (const name of actions) {
      await expect(page.getByRole("button", { name }).first(), name).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Repository Status" }).first()).toBeVisible();
    await expectSyncControls(page, true);
  });

  test("a Head TA with manage_student_repositories sees the actions and can fix permissions", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openRepositoriesPage(page);
    for (const name of actions) {
      await expect(page.getByRole("button", { name }).first(), name).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Repository Status" }).first()).toBeVisible();
    await expectSyncControls(page, false);

    // The repository isn't ready on GitHub, so this queues nothing and reports it as skipped.
    await page.getByRole("button", { name: "Fix Permissions" }).first().click();
    await expect(page.getByText(/Audited 1 repositories: 0 syncs enqueued/).first()).toBeVisible({
      timeout: 30_000
    });
  });
});
