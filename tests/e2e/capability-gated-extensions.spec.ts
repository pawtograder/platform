/**
 * #1010: the extension controls follow grant_extensions (20261123040200_extensions_by_capability.sql).
 *
 * - The course-wide Due Date Extensions page and its Course Settings link need grant_extensions;
 *   without it, the page sends a staff member back to the course page. Gift Tokens and Edit Late
 *   Token Allocation stay instructor-only there.
 * - Every staff member can read an assignment's Due Date Exceptions page. Adjust Due Date and the
 *   bulk actions need grant_extensions.
 *
 * The default instructor and grader roles hold grant_extensions.
 */
import { addDays } from "date-fns";
import { expect, test, type Page } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("extension controls gated by grant_extensions", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let coordinator: TestingUser;
  let assignmentId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Extension Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    coordinator = await createUserInClass({ role: "grader", class_id: course.id });
    await createUserInClass({ role: "student", class_id: course.id });

    // A custom role starts as a copy of the default grader role; this one turns grant_extensions off.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Course coordinator" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", "grant_extensions"))
        .error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", coordinator.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Extension gates"
    });
    assignmentId = assignment.id;
  });

  // useCapability is false while loading, so a hidden control only means "not held" once the answer is in.
  async function gotoWithCapabilities(page: Page, url: string) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await page.goto(url);
    await capabilities;
    await expect(page.locator("[data-capabilities-loaded]")).toBeAttached({ timeout: 30_000 });
  }

  async function expectSettingsLink(page: Page, visible: boolean) {
    await page.getByRole("button", { name: "Course Settings" }).first().click();
    await expect(page.getByRole("menuitem", { name: "Discord" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Due Date Extensions" })).toHaveCount(visible ? 1 : 0);
    await page.keyboard.press("Escape");
  }

  async function expectAssignmentPage(page: Page, canGrant: boolean) {
    await gotoWithCapabilities(page, `/course/${course.id}/manage/assignments/${assignmentId}/due-date-exceptions`);
    await expect(page.getByText("Toggle Column Visibility:").first()).toBeVisible({ timeout: 60_000 });
    // Wait for the student rows, so a missing Adjust Due Date means "hidden", not "not loaded yet".
    await expect(page.getByRole("row", { name: /for bulk actions/ }).first()).toBeVisible({ timeout: 60_000 });
    const adjust = page.getByRole("button", { name: "Adjust Due Date" });
    if (canGrant) {
      await expect(adjust.first()).toBeVisible();
      await expect(
        page.getByText("Select students below to extend or set their deadline in bulk.").first()
      ).toBeVisible();
    } else {
      await expect(adjust).toHaveCount(0);
      await expect(page.getByText("Select students below to extend or set their deadline in bulk.")).toHaveCount(0);
    }
  }

  test("an instructor sees every control", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await gotoWithCapabilities(page, `/course/${course.id}/manage/course/due-date-extensions`);
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible({
      timeout: 60_000
    });
    await expect(page.getByRole("button", { name: "Add Exception" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gift Tokens" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Late Token Allocation" })).toBeVisible();
    await expectSettingsLink(page, true);
    await expectAssignmentPage(page, true);
  });

  test("a default grader grants extensions, but can't gift tokens or change the allocation", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await gotoWithCapabilities(page, `/course/${course.id}/manage/course/due-date-extensions`);
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible({
      timeout: 60_000
    });
    await expect(page.getByRole("button", { name: "Add Exception" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gift Tokens" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit Late Token Allocation" })).toHaveCount(0);
    // The instructor-only allocation card is left out, not replaced with an "access denied" message.
    await expect(page.getByRole("heading", { name: "Class Late Token Settings" })).toHaveCount(0);
    await expect(page.getByText(/Access denied/)).toHaveCount(0);
    await expectSettingsLink(page, true);
    await expectAssignmentPage(page, true);
  });

  test("a grader whose role turns grant_extensions off is sent away, and sees no extension controls", async ({
    page
  }) => {
    await loginAsUser(page, coordinator, course);
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}$`), { timeout: 60_000 });
    await gotoWithCapabilities(page, `/course/${course.id}`);
    await expectSettingsLink(page, false);
    await expectAssignmentPage(page, false);
  });
});
