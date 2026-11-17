/**
 * #1091 part 2: the Repository host picker on Create/Edit Assignment, Forgejo's disabled options
 * (#1119), and the GitHub link prompt on Forgejo assignments.
 *
 * Test users have no linked GitHub identity, so the "Connect to GitHub" banner is the prompt to
 * look for. Screenshots are attached to the test results.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../global-setup";
import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

const BANNER = "Connect to GitHub to access assignments";

test.describe("Repository host picker and GitHub prompts", () => {
  test.describe.configure({ timeout: 180_000 });
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let flagOn: Awaited<ReturnType<typeof createClass>>;
  let flagOff: Awaited<ReturnType<typeof createClass>>;
  let instructorOn: TestingUser;
  let instructorOff: TestingUser;
  let student: TestingUser;
  let githubAssignment: { id: number; title: string };
  let forgejoAssignment: { id: number; title: string };
  let emptyAssignment: { id: number; title: string };

  test.beforeAll(async () => {
    flagOn = await createClass({ name: `E2E Host Picker On ${suffix}` });
    flagOff = await createClass({ name: `E2E Host Picker Off ${suffix}` });
    await setCourseFeature(flagOn.id, "cloud-workspaces", true);
    instructorOn = await createUserInClass({ role: "instructor", class_id: flagOn.id });
    instructorOff = await createUserInClass({ role: "instructor", class_id: flagOff.id });
    student = await createUserInClass({ role: "student", class_id: flagOn.id });
    const due = addDays(new Date(), 14).toISOString();
    // insertAssignment gives a GitHub assignment a handout, which locks its host.
    githubAssignment = await insertAssignment({
      class_id: flagOn.id,
      due_date: due,
      name: `GitHub HW ${suffix}`,
      assignment_slug: `gh-${suffix}`
    });
    forgejoAssignment = await insertAssignment({
      class_id: flagOn.id,
      due_date: due,
      name: `Forgejo HW ${suffix}`,
      assignment_slug: `fj-${suffix}`,
      git_provider: "forgejo"
    });
    // A code assignment with no repository of any kind, so its host can still change.
    emptyAssignment = await insertAssignment({
      class_id: flagOn.id,
      due_date: due,
      name: `No Repo HW ${suffix}`,
      assignment_slug: `nr-${suffix}`,
      repo_mode: "none"
    });
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([instructorOn, instructorOff, student]);
  });

  // The assignment layout renders its page twice, once hidden for narrow screens.
  const visiblePicker = (page: Page) => page.getByLabel("Repository host").filter({ visible: true });

  async function openStudentAssignment(page: Page, assignment: { id: number; title: string }) {
    await page.goto(`/course/${flagOn.id}/assignments/${assignment.id}`);
    await expect(page.getByRole("heading", { name: assignment.title })).toBeVisible({ timeout: 60_000 });
  }

  test("a student sees no GitHub banner on a Forgejo assignment and still sees it on a GitHub one", async ({
    page
  }) => {
    await loginAsUser(page, student, flagOn);

    await openStudentAssignment(page, githubAssignment);
    await expect(page.getByText(BANNER)).toBeVisible();

    await openStudentAssignment(page, forgejoAssignment);
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("student-forgejo-assignment.png"), fullPage: true });

    // Back on the GitHub assignment, so the hidden banner above wasn't just slow to load.
    await openStudentAssignment(page, githubAssignment);
    await expect(page.getByText(BANNER)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("student-github-assignment.png"), fullPage: true });
  });

  test("an instructor in a flag-off class sees no host picker", async ({ page }) => {
    await loginAsUser(page, instructorOff, flagOff);
    await page.goto(`/course/${flagOff.id}/manage/assignments/new`);
    await expect(page.getByRole("heading", { name: "Create New Assignment" })).toBeVisible();
    await expect(page.locator('select[name="repo_mode"]')).toBeVisible();
    await expect(page.getByLabel("Repository host")).toHaveCount(0);
  });

  test("an instructor in a flag-on class picks Forgejo and sees the unsupported options disabled", async ({ page }) => {
    await loginAsUser(page, instructorOn, flagOn);
    await page.goto(`/course/${flagOn.id}/manage/assignments/new`);
    await expect(page.getByRole("heading", { name: "Create New Assignment" })).toBeVisible();

    const host = page.getByLabel("Repository host");
    await expect(host).toHaveValue("github");
    await expect(host).toBeEnabled();
    await host.selectOption("forgejo");

    const repoMode = page.locator('select[name="repo_mode"]');
    await expect(repoMode.locator('option[value="template_with_student_forks"]')).toBeDisabled();
    await expect(repoMode.locator('option[value="fork_from_prior_assignment"]')).toBeDisabled();
    await expect(repoMode.locator('option[value="template_only_staff"]')).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: /Enable autograder/i })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: /Block force-push to default branch/i })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: /Block force-push to default branch/i })).not.toBeChecked();
    await expect(page.getByText("Branch protection is only applied to GitHub repositories.")).toBeVisible();
    await page
      .locator(".chakra-card__root")
      .filter({ has: page.getByLabel("Repository host") })
      .screenshot({ path: test.info().outputPath("create-form-forgejo.png") });

    // Fill the rest and save: the row is Forgejo, with the disabled settings off.
    const slug = `fjnew${suffix}`.slice(0, 15);
    await page.getByLabel("Title", { exact: false }).fill(`Forgejo Created ${suffix}`);
    await page.getByLabel("Slug", { exact: false }).fill(slug);
    // datetime-local values in the class's time zone, as the form reads them.
    const local = (d: Date) => new TZDate(d, "America/New_York").toISOString().slice(0, 16);
    await page.getByLabel(/^Release date/i).fill(local(addDays(new Date(), 1)));
    await page.getByLabel(/^Due date/i).fill(local(addDays(new Date(), 14)));
    await page.getByLabel("Points possible", { exact: false }).fill("100");
    await page.getByRole("button", { name: "Save" }).click();
    // Forgejo skips GitHub handout setup and lands on the assignment, not the GitHub Autograder page.
    await expect(page).toHaveURL(new RegExp(`/course/${flagOn.id}/manage/assignments/\\d+$`), { timeout: 60_000 });

    const { data: created, error } = await supabase
      .from("assignments")
      .select("git_provider, has_autograder, protect_block_force_push, enable_repo_analytics, template_repo")
      .eq("class_id", flagOn.id)
      .eq("slug", slug)
      .single();
    expect(error).toBeNull();
    expect(created).toEqual({
      git_provider: "forgejo",
      has_autograder: false,
      protect_block_force_push: false,
      enable_repo_analytics: false,
      template_repo: null
    });
  });

  test("a fork mode chosen on GitHub blocks the save after switching to Forgejo", async ({ page }) => {
    await loginAsUser(page, instructorOn, flagOn);
    await page.goto(`/course/${flagOn.id}/manage/assignments/new`);
    await expect(page.getByRole("heading", { name: "Create New Assignment" })).toBeVisible();
    await page.locator('select[name="repo_mode"]').selectOption("template_with_student_forks");
    await page.getByLabel("Repository host").selectOption("forgejo");
    await expect(page.getByTestId("repository-host-conflict")).toContainText("Forgejo can't fork the handout");
  });

  test("the host is locked on an assignment that has repositories", async ({ page }) => {
    await loginAsUser(page, instructorOn, flagOn);
    await page.goto(`/course/${flagOn.id}/manage/assignments/${githubAssignment.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Assignment" })).toBeVisible();
    await expect(
      page.getByText("This assignment already has repositories, so its host can't change.").filter({ visible: true })
    ).toBeVisible({
      timeout: 30_000
    });
    await expect(visiblePicker(page)).toBeDisabled();
    await expect(visiblePicker(page)).toHaveValue("github");
  });

  test("the host can still change on an assignment without repositories", async ({ page }) => {
    await loginAsUser(page, instructorOn, flagOn);
    await page.goto(`/course/${flagOn.id}/manage/assignments/${emptyAssignment.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Assignment" })).toBeVisible();
    await expect(visiblePicker(page)).toHaveValue("github", { timeout: 30_000 });
    await expect(visiblePicker(page)).toBeEnabled({ timeout: 30_000 });
  });

  test("the instructor's assignment list badges the Forgejo assignment", async ({ page }) => {
    await loginAsUser(page, instructorOn, flagOn);
    await page.goto(`/course/${flagOn.id}/manage/assignments`);
    const forgejoRow = page.getByRole("row").filter({ hasText: forgejoAssignment.title });
    await expect(forgejoRow.getByText("Forgejo", { exact: true })).toBeVisible({ timeout: 60_000 });
    const githubRow = page.getByRole("row").filter({ hasText: githubAssignment.title });
    await expect(githubRow.getByText("Forgejo", { exact: true })).toHaveCount(0);
  });
});
