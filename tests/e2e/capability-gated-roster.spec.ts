/**
 * #1010: roster pages follow manage_roster (20261122210300_roster_by_capability.sql and the two
 * migrations after it).
 *
 * - A Head TA on a custom role with manage_roster sees Enrollments in the Course Settings menu, the
 *   student actions on the Enrollments page (Remove, Add Course Member with Student only), and the
 *   Manage lab sections link. They see no Edit role, no Edit profile, no Import from CSV, and can't
 *   remove a grader.
 * - A default grader doesn't see Enrollments in the menu, sees no roster buttons, and is sent from
 *   the lab sections page back to the lab roster.
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

test.describe("Roster pages are gated by manage_roster", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let grader: TestingUser;
  let headTa: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Roster Gates ${suffix}` });
    await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    await createUserInClass({ role: "student", class_id: course.id });
    // The lab roster page shows "Loading" until the class has a lab section.
    expect(
      (
        await supabase.from("lab_sections").insert({
          class_id: course.id,
          name: "E2E Lab",
          day_of_week: "monday",
          start_time: "10:00",
          end_time: "11:00"
        })
      ).error
    ).toBeNull();

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Roster TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_roster" })).error
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

  const enrollmentsUrl = () => `/course/${course.id}/manage/course/enrollments`;
  const labSectionsUrl = () => `/course/${course.id}/manage/course/lab-sections`;
  const labRosterUrl = () => `/course/${course.id}/manage/course/lab-roster`;

  // useCapability is false while loading, so a hidden control only means something once the answer
  // is in. ClassCapabilitiesProvider adds data-capabilities-loaded in the same render that applies
  // it, and also after the lookup fails a few times, so the test first waits for a successful lookup.
  async function loginAndWaitForCapabilities(page: Page, user: TestingUser) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await loginAsUser(page, user, course);
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
  }

  async function openCourseSettingsMenu(page: Page) {
    await page.getByRole("button", { name: "Course Settings menu" }).click();
    // An item every staff member sees, so the menu is open.
    await expect(page.getByRole("menuitem", { name: "Grading Conflicts" })).toBeVisible();
  }

  async function gotoEnrollments(page: Page) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await gotoCourseUrlWhenHeadingVisible(page, enrollmentsUrl(), "Enrollments");
    await capabilities;
    await expect(page.locator('[data-capabilities-loaded="true"]').first()).toBeAttached();
    // The student's row has loaded.
    await expect(page.getByRole("cell", { name: "student", exact: true }).first()).toBeVisible();
  }

  test("a Head TA with manage_roster sees the student actions and no instructor-only ones", async ({ page }) => {
    await loginAndWaitForCapabilities(page, headTa);
    await openCourseSettingsMenu(page);
    await expect(page.getByRole("menuitem", { name: "Enrollments" })).toBeVisible();
    await page.keyboard.press("Escape");

    await gotoEnrollments(page);
    await expect(page.getByLabel("Remove user from course").first()).toBeVisible();
    await expect(page.getByLabel("Only instructors can remove staff").first()).toBeVisible();
    await expect(page.getByLabel("Edit user role")).toHaveCount(0);
    await expect(page.getByLabel("Edit student profile")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import from CSV" })).toHaveCount(0);

    await page.getByRole("button", { name: "Add Course Member" }).click();
    const roleSelect = page.locator('select[name="role"]');
    await expect(roleSelect.locator("option")).toHaveText(["Student"]);
    await page.keyboard.press("Escape");

    await gotoCourseUrlWhenHeadingVisible(page, labRosterUrl(), "Lab Sections");
    await expect(page.getByRole("link", { name: "Manage lab sections" })).toBeVisible();
    await page.goto(labSectionsUrl());
    await expect(page).toHaveURL(new RegExp(`${labSectionsUrl()}$`));
  });

  test("a default grader sees no roster actions and is sent back from lab sections", async ({ page }) => {
    await loginAndWaitForCapabilities(page, grader);
    await openCourseSettingsMenu(page);
    await expect(page.getByRole("menuitem", { name: "Enrollments" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await gotoEnrollments(page);
    await expect(page.getByLabel("Remove user from course")).toHaveCount(0);
    await expect(page.getByLabel("Edit user role")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add Course Member" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Import from CSV" })).toHaveCount(0);

    await gotoCourseUrlWhenHeadingVisible(page, labRosterUrl(), "Lab Sections");
    await expect(page.getByRole("link", { name: "Manage lab sections" })).toHaveCount(0);
    await page.goto(labSectionsUrl());
    await expect(page).toHaveURL(new RegExp(`${labRosterUrl()}$`));
  });
});
