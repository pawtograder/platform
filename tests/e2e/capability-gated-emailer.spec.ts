/**
 * #1010: the Emailer needs send_announcements (20261123160000_announcements_by_capability.sql).
 * Without it the Emailer item is hidden from the Course Settings menu, and opening the page by its
 * address sends you to the course home page. A Head TA on a custom role with send_announcements
 * sees the item and the page. Instructors see no change.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("The Emailer is gated by send_announcements", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Emailer Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    await createUserInClass({ role: "student", class_id: course.id });

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Announcements TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "send_announcements" })).error
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

  const emailerUrl = () => `/course/${course.id}/manage/course/emails`;

  // useCapability is false while loading, so a hidden item only means something once the answer
  // is in. ClassCapabilitiesProvider adds data-capabilities-loaded in the same render that applies
  // it, and also after the lookup fails a few times, so the test first waits for a successful lookup.
  async function openCourseSettingsMenu(page: Page, user: TestingUser) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await loginAsUser(page, user, course);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
    await page.getByRole("button", { name: "Course Settings menu" }).click();
    // An item every staff member sees, so the menu is open.
    await expect(page.getByRole("menuitem", { name: "Grading Conflicts" })).toBeVisible();
  }

  test("a grader doesn't see the Emailer and is sent home from its address", async ({ page }) => {
    await openCourseSettingsMenu(page, grader);
    await expect(page.getByRole("menuitem", { name: "Emailer" })).toHaveCount(0);

    await page.goto(emailerUrl());
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}$`));
    await expect(page.getByRole("heading", { name: "Create and Send Emails" })).toHaveCount(0);
  });

  test("a Head TA with send_announcements sees the Emailer and opens it", async ({ page }) => {
    await openCourseSettingsMenu(page, headTa);
    await expect(page.getByRole("menuitem", { name: "Emailer" })).toBeVisible();
    await gotoCourseUrlWhenHeadingVisible(page, emailerUrl(), "Create and Send Emails");
    await expect(page).toHaveURL(new RegExp(`${emailerUrl()}$`));
  });

  test("an instructor still sees the Emailer and opens it", async ({ page }) => {
    await openCourseSettingsMenu(page, instructor);
    await expect(page.getByRole("menuitem", { name: "Emailer" })).toBeVisible();
    await gotoCourseUrlWhenHeadingVisible(page, emailerUrl(), "Create and Send Emails");
  });
});
