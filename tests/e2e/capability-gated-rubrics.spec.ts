/**
 * #1010: editing rubrics needs manage_rubrics (20261119120100_rubrics_by_capability.sql). Without
 * it the Configure Rubric nav item is hidden, and opening the rubric page by URL sends you back to
 * the assignment page. A Head TA on a custom role with manage_rubrics sees it and can save a rubric.
 * Instructors see no change.
 *
 * The default instructor role holds manage_rubrics, the default grader role doesn't.
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

test.describe("rubric editing gated by manage_rubrics", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Rubric Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Rubric Gates ${suffix}`,
      assignment_slug: `e2e-rub-${suffix}`
    });

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Rubric TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_rubrics" })).error
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

  const assignmentUrl = () => `/course/${course.id}/manage/assignments/${assignment.id}`;

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  // The nav sets data-capabilities-loaded in the same render that applies the answer.
  async function openGroupsPage(page: Page) {
    await gotoCourseUrlWhenHeadingVisible(page, `${assignmentUrl()}/groups`, "Configure Groups");
    await expect(page.locator('nav[data-capabilities-loaded="true"]').first()).toBeAttached();
  }

  // The manage layout renders the page twice (mobile and desktop); the region picks the visible copy.
  const rubricEditor = (page: Page) => page.getByRole("region", { name: "Rubric Editor" });

  test("a grader doesn't see Configure Rubric", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openGroupsPage(page);
    await expect(page.getByRole("link", { name: "Configure Rubric" })).toHaveCount(0);
  });

  test("a grader who opens the rubric page by URL is sent back to the assignment page", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await page.goto(`${assignmentUrl()}/rubric`);
    await expect(page).toHaveURL(new RegExp(`${assignmentUrl()}$`));
    await expect(rubricEditor(page)).toHaveCount(0);
  });

  test("a Head TA with manage_rubrics who opens the rubric page by URL gets the editor", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await page.goto(`${assignmentUrl()}/rubric`);
    await expect(rubricEditor(page)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(new RegExp(`${assignmentUrl()}/rubric$`));
  });

  test("an instructor still sees Configure Rubric", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openGroupsPage(page);
    await expect(page.getByRole("link", { name: "Configure Rubric" }).first()).toBeVisible();
  });

  test("a Head TA with manage_rubrics sees Configure Rubric and saves an edit", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openGroupsPage(page);
    await page.getByRole("link", { name: "Configure Rubric" }).first().click();

    await rubricEditor(page)
      .getByRole("tab", { name: /^\s*Grading Review(\*?\s*\(Unsaved Changes\))?\s*$/i })
      .click();
    const firstPart = rubricEditor(page).getByRole("region", { name: /^Part 1:/ });
    await firstPart.scrollIntoViewIfNeeded();
    const newName = `Head TA part ${Date.now().toString(36)}`;
    await firstPart.getByLabel("Name").first().fill(newName);
    await rubricEditor(page).getByRole("button", { name: "Save" }).click();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("rubric_parts")
            .select("name")
            .eq("rubric_id", assignment.grading_rubric_id!);
          return (data ?? []).map((part) => part.name);
        },
        { timeout: 30_000 }
      )
      .toContain(newName);
  });
});
