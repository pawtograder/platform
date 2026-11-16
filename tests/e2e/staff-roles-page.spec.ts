/**
 * The Staff Roles page (Course Settings): an instructor makes a custom grader role, chooses what it
 * can do, puts a grader on it, and the grader's pages follow. The database rules behind it are
 * covered in class-roles-db.spec.ts; this covers the screen.
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

test.describe("Staff Roles page", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let otherGrader: TestingUser;
  let graderRoleId: number;
  const roleName = `Head TA ${Date.now().toString(36)}`;
  const renamedRole = `${roleName} renamed`;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Staff Roles ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    otherGrader = await createUserInClass({ role: "grader", class_id: course.id });
    const { data, error } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", course.id)
      .eq("default_for", "grader")
      .single();
    expect(error).toBeNull();
    graderRoleId = data!.id;
  });

  const rolesUrl = () => `/course/${course.id}/manage/course/roles`;

  async function openRolesPage(page: Page) {
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(page, rolesUrl(), "Staff roles");
    await capabilities;
  }

  async function roleCapabilities(roleId: number) {
    const { data, error } = await supabase.from("role_capabilities").select("capability").eq("role_id", roleId);
    expect(error).toBeNull();
    return (data ?? []).map((row) => row.capability).sort();
  }

  async function customRoleId(name: string) {
    const { data, error } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", course.id)
      .eq("name", name)
      .maybeSingle();
    expect(error).toBeNull();
    return data?.id;
  }

  test("a grader is told only instructors can manage staff roles, and sees no controls", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openRolesPage(page);
    await expect(page.getByText("Only instructors can manage staff roles.")).toBeVisible();
    await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });

  test("an instructor sees the Grader role, every grader, and no way to hand out manage_roles", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    // The People table also has a "Grader" column, so match the role column by its "Default" line.
    await expect(page.getByRole("columnheader", { name: /^Grader Default/ })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Grader: Manage assignments" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Manage roles/ })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: `Role for ${grader.private_profile_name}` })).toBeVisible();
    await expect(page.getByRole("combobox", { name: `Role for ${otherGrader.private_profile_name}` })).toBeVisible();
  });

  test("a new role needs a name that isn't taken", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await page.getByRole("button", { name: "New role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create role" }).click();
    await expect(dialog.getByText("Enter a name for the role.")).toBeVisible();
    await dialog.getByLabel("Role name").fill("INSTRUCTOR");
    await dialog.getByRole("button", { name: "Create role" }).click();
    await expect(dialog.getByText('This class already has a role named "INSTRUCTOR".')).toBeVisible();
    expect(await customRoleId("INSTRUCTOR")).toBeUndefined();
  });

  test("an instructor creates a role, turns a capability on, and it is saved", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await page.getByRole("button", { name: "New role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Role name").fill(roleName);
    await dialog.getByRole("button", { name: "Create role" }).click();
    await expect(page.getByRole("columnheader", { name: new RegExp(roleName) })).toBeVisible();

    const box = page.getByRole("checkbox", { name: `${roleName}: Manage assignments` });
    await expect(box).not.toBeChecked();
    // The checkbox input is visually hidden; click the label that holds it.
    await page.locator("label").filter({ has: box }).click();
    await expect(box).toBeChecked();

    const roleId = await customRoleId(roleName);
    expect(roleId).toBeDefined();
    await expect.poll(() => roleCapabilities(roleId!)).toEqual(["manage_assignments"]);
    // The Grader role is a separate list.
    expect(await roleCapabilities(graderRoleId)).toEqual([]);

    await page.reload();
    await openRolesPage(page);
    await expect(page.getByRole("checkbox", { name: `${roleName}: Manage assignments` })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Grader: Manage assignments" })).not.toBeChecked();
  });

  test("an instructor puts a grader on the role, and that grader can then create assignments", async ({
    page,
    browser
  }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    const select = page.getByRole("combobox", { name: `Role for ${grader.private_profile_name}` });
    await select.selectOption({ label: roleName });
    const roleId = await customRoleId(roleName);
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("user_roles")
          .select("class_role_id")
          .eq("class_id", course.id)
          .eq("private_profile_id", grader.private_profile_id)
          .single();
        return data?.class_role_id;
      })
      .toBe(roleId);
    await expect(page.getByRole("columnheader", { name: new RegExp(roleName) })).toContainText("1 person");

    const graderContext = await browser.newContext();
    const graderPage = await graderContext.newPage();
    try {
      await loginAsUser(graderPage, grader, course);
      const capabilities = graderPage.waitForResponse(
        (r) => r.url().includes("/rpc/user_class_capabilities") && r.ok()
      );
      await graderPage.goto(`/course/${course.id}/manage/assignments`);
      await expect(graderPage.getByRole("link", { name: "All regrade requests" })).toBeVisible({ timeout: 60_000 });
      await capabilities;
      await expect(graderPage.getByRole("link", { name: "New Assignment" })).toBeVisible();
    } finally {
      await graderContext.close();
    }
  });

  test("a role with people on it can't be deleted from the page", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await page.getByRole("button", { name: `Delete ${roleName}` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("1 person is on this role.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete role" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await customRoleId(roleName)).toBeDefined();
  });

  test("an instructor renames the role, moves the grader back, and deletes it", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await page.getByRole("button", { name: `Rename ${roleName}` }).click();
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByLabel("Role name").fill(renamedRole);
    await renameDialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("columnheader", { name: new RegExp(renamedRole) })).toBeVisible();
    expect(await customRoleId(renamedRole)).toBeDefined();

    await page.getByRole("combobox", { name: `Role for ${grader.private_profile_name}` }).selectOption({
      label: "Grader"
    });
    await expect(page.getByRole("columnheader", { name: new RegExp(renamedRole) })).toContainText("0 people");

    await page.getByRole("button", { name: `Delete ${renamedRole}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete role" }).click();
    await expect(page.getByRole("columnheader", { name: new RegExp(renamedRole) })).toHaveCount(0);
    await expect.poll(() => customRoleId(renamedRole)).toBeUndefined();
  });

  test("a change the database refuses is shown as not saved, and the checkbox goes back", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    const box = page.getByRole("checkbox", { name: "Grader: Publish groups" });
    await expect(box).not.toBeChecked();
    // Stand in for a refusal (for example the instructor was demoted in another tab).
    await page.route("**/rest/v1/role_capabilities*", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              code: "42501",
              message: 'new row violates row-level security policy for table "role_capabilities"'
            })
          })
        : route.continue()
    );
    await page.locator("label").filter({ has: box }).click();
    await expect(page.getByText("You don't have permission to change roles in this class.")).toBeVisible();
    await expect(box).not.toBeChecked();
    expect(await roleCapabilities(graderRoleId)).toEqual([]);
  });
});
