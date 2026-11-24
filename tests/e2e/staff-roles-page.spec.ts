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

  async function showCapabilities(page: Page, name = "Grader") {
    await page.getByRole("link", { name: "Roles & Capabilities", exact: true }).click();
    await page.getByRole("combobox", { name: "Role capabilities", exact: true }).selectOption({ label: name });
  }

  async function showStaff(page: Page) {
    await page.getByRole("link", { name: "Staff & Roles", exact: true }).click();
    await page.getByRole("tab", { name: "Staff", exact: true }).click();
  }

  async function editRole(page: Page, name: string) {
    await page.getByRole("link", { name: "Create / Edit Role", exact: true }).click();
    await page.getByRole("button", { name: "Edit a role", exact: true }).click();
    await page.getByRole("combobox", { name: "Role to edit", exact: true }).selectOption({ label: name });
  }

  async function roleCount(page: Page, name: string, count: string) {
    await page.getByRole("link", { name: "Staff & Roles", exact: true }).click();
    await page.getByRole("tab", { name: "Roles", exact: true }).click();
    await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) })).toContainText(
      count
    );
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
    await expect(page.getByRole("button", { name: "Create a role" })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("an instructor sees the Grader role, every grader, and no way to hand out manage_roles", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await showCapabilities(page);
    await expect(page.getByRole("switch", { name: "Grader: Manage assignments" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: /Manage roles/ })).toHaveCount(0);
    const assignments = page.getByRole("region", { name: "Manage Assignments", exact: true });
    await expect(
      assignments.getByRole("region", { name: "Assignments", exact: true }).getByRole("switch")
    ).toBeVisible();
    await expect(
      assignments
        .getByRole("region", { name: "Reviews", exact: true })
        .getByRole("switch", { name: "Grader: Manage review assignments" })
    ).toBeVisible();
    // The "i" opens on click (and so on tap and from a screen reader), and the switch is described by
    // the same text so it is read without opening anything.
    await page.getByRole("button", { name: "About Manage assignments", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Create and edit assignments in Manage Assignments");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("switch", { name: "Grader: Manage assignments" })).toHaveAccessibleDescription(
      /Create and edit assignments in Manage Assignments/
    );
    await showStaff(page);
    await expect(page.getByRole("combobox", { name: `Role for ${grader.private_profile_name}` })).toBeVisible();
    await expect(page.getByRole("combobox", { name: `Role for ${otherGrader.private_profile_name}` })).toBeVisible();
    await roleCount(page, "Grader", "2 people");
  });

  test("another instructor's role changes appear without reloading", async ({ page, browser }) => {
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const context = await browser.newContext();
    const writer = await context.newPage();
    const name = `Live role ${Date.now()}`;
    const renamed = `${name} renamed`;
    try {
      await loginAsUser(page, instructor, course);
      await openRolesPage(page);
      await page.getByRole("button", { name: "Edit a role", exact: true }).click();
      await loginAsUser(writer, otherInstructor, course);
      await openRolesPage(writer);
      await writer.getByRole("button", { name: "Create a role" }).click();
      await writer.getByRole("dialog").getByLabel("Role name").fill(name);
      await writer.getByRole("dialog").getByRole("button", { name: "Create role" }).click();
      await expect(
        page.getByRole("combobox", { name: "Role to edit" }).getByRole("option", { name, exact: true })
      ).toBeAttached();
      await page.getByRole("combobox", { name: "Role to edit" }).selectOption({ label: name });
      await editRole(writer, name);
      await writer.getByRole("button", { name: `Rename ${name}`, exact: true }).click();
      await writer.getByRole("dialog").getByLabel("Role name").fill(renamed);
      await writer.getByRole("dialog").getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.getByRole("button", { name: `Rename ${renamed}`, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: `Rename ${name}`, exact: true })).toHaveCount(0);
      await editRole(writer, renamed);
      await writer.getByRole("button", { name: `Delete ${renamed}`, exact: true }).click();
      await writer.getByRole("alertdialog").getByRole("button", { name: "Delete role", exact: true }).click();
      await expect(page.getByRole("button", { name: `Rename ${renamed}`, exact: true })).toHaveCount(0);
    } finally {
      await context.close();
      const { error } = await supabase
        .from("class_roles")
        .delete()
        .eq("class_id", course.id)
        .in("name", [name, renamed]);
      expect(error).toBeNull();
    }
  });

  for (const operation of ["create", "rename", "delete"] as const) {
    test(`${operation} dialog stays open during a pending write`, async ({ page }) => {
      const name = `Pending ${operation} ${Date.now()}`;
      await loginAsUser(page, instructor, course);
      await openRolesPage(page);
      if (operation !== "create") {
        expect((await supabase.from("class_roles").insert({ class_id: course.id, name })).error).toBeNull();
        await editRole(page, name);
        await page.getByRole("button", { name: `${operation === "delete" ? "Delete" : "Rename"} ${name}` }).click();
        if (operation === "rename") await page.getByRole("dialog").getByLabel("Role name").fill(`${name} renamed`);
      } else {
        await page.getByRole("button", { name: "Create a role" }).click();
        await page.getByRole("dialog").getByLabel("Role name").fill(name);
      }
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const method = operation === "create" ? "POST" : operation === "rename" ? "PATCH" : "DELETE";
      await page.route("**/rest/v1/class_roles*", async (route) => {
        if (route.request().method() === method) await gate;
        await route.continue();
      });
      const dialog = page.getByRole(operation === "delete" ? "alertdialog" : "dialog");
      try {
        const pending = page.waitForRequest((r) => r.url().includes("/rest/v1/class_roles") && r.method() === method);
        await dialog
          .getByRole("button", {
            name: operation === "create" ? "Create role" : operation === "rename" ? "Rename" : "Delete role",
            exact: true
          })
          .click();
        await pending;
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await page.mouse.click(5, 5);
        await expect(dialog).toBeVisible();
      } finally {
        release();
      }
      await expect(dialog).toHaveCount(0);
      expect(
        (
          await supabase
            .from("class_roles")
            .delete()
            .eq("class_id", course.id)
            .in("name", [name, `${name} renamed`])
        ).error
      ).toBeNull();
    });
  }

  test("Enrollments shows staff roles and both pages update live", async ({ page, browser }) => {
    const name = `Enrollment role ${Date.now()}`;
    const member = await createUserInClass({ role: "grader", class_id: course.id });
    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name })
      .select("id")
      .single();
    expect(error).toBeNull();
    const context = await browser.newContext();
    const enrollmentPage = await context.newPage();
    try {
      await loginAsUser(page, instructor, course);
      await openRolesPage(page);
      await showStaff(page);
      const select = page.getByRole("combobox", { name: `Role for ${member.private_profile_name}` });
      await loginAsUser(enrollmentPage, instructor, course);
      await enrollmentPage.goto(`/course/${course.id}/manage/course/enrollments`);
      const row = enrollmentPage.getByRole("row").filter({ hasText: member.email });
      await expect(row.getByRole("cell", { name: "Grader", exact: true })).toBeVisible();
      await select.selectOption({ label: name });
      await expect(row.getByRole("cell", { name, exact: true })).toBeVisible();
      // A rename also reaches Enrollments through classRoles, without a reload.
      await editRole(page, name);
      await page.getByRole("button", { name: `Rename ${name}`, exact: true }).click();
      await page.getByRole("dialog").getByLabel("Role name").fill(`${name} renamed`);
      await page.getByRole("dialog").getByRole("button", { name: "Rename", exact: true }).click();
      await expect(row.getByRole("cell", { name: `${name} renamed`, exact: true })).toBeVisible();
      await showStaff(page);
      await row.getByLabel("Edit user role", { exact: true }).click();
      const dialog = enrollmentPage.getByRole("dialog");
      await expect(dialog).toContainText(`Current role: ${name} renamed`);
      await dialog.getByRole("combobox").selectOption("student");
      await dialog.getByRole("button", { name: "Update Role", exact: true }).click();
      await expect(select).toHaveCount(0);
      await expect(row.getByRole("cell", { name: "student", exact: true })).toBeVisible();
      await row.getByLabel("Edit user role", { exact: true }).click();
      await dialog.getByRole("combobox").selectOption("grader");
      await dialog.getByRole("button", { name: "Update Role", exact: true }).click();
      await expect(select).toHaveValue(String(graderRoleId));
      await expect(row.getByRole("cell", { name: "Grader", exact: true })).toBeVisible();
    } finally {
      await context.close();
      expect(
        (
          await supabase
            .from("user_roles")
            .update({ class_role_id: graderRoleId, disabled: true })
            .eq("class_id", course.id)
            .eq("private_profile_id", member.private_profile_id)
        ).error
      ).toBeNull();
      if (role) expect((await supabase.from("class_roles").delete().eq("id", role.id)).error).toBeNull();
    }
  });

  test("a new role needs a name that isn't taken", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    await page.getByRole("button", { name: "Create a role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create role" }).click();
    await expect(dialog.getByText("Enter a name for the role.")).toBeVisible();
    await dialog.getByLabel("Role name").fill("INSTRUCTOR");
    await dialog.getByRole("button", { name: "Create role" }).click();
    await expect(dialog.getByText('This class already has a role named "INSTRUCTOR".')).toBeVisible();
    expect(await customRoleId("INSTRUCTOR")).toBeUndefined();
  });

  test("saved capability values survive missed broadcasts and a failed key fetch", async ({ page }) => {
    const name = `Missed broadcasts ${Date.now()}`;
    const { data: role, error } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect((await supabase.from("role_capabilities").delete().eq("role_id", role!.id)).error).toBeNull();
    try {
      // Do not forward the websocket connection, so this page receives no broadcasts.
      await page.routeWebSocket("**/realtime/v1/websocket*", () => {});
      await loginAsUser(page, instructor, course);
      await openRolesPage(page);
      await showCapabilities(page, name);
      const labels = ["Manage assignments", "Publish groups", "Manage review assignments"];
      const boxes = labels.map((label) => page.getByRole("switch", { name: `${name}: ${label}`, exact: true }));
      for (const box of boxes) await expect(box).not.toBeChecked();
      const reads: URL[] = [];
      await page.route("**/rest/v1/role_capabilities*", async (route) => {
        if (route.request().method() === "GET") {
          const url = new URL(route.request().url());
          reads.push(url);
          // Keep one saved value pending; the other two must reach the cache independently.
          if (url.searchParams.get("capability") === "eq.manage_assignments") {
            await route.fulfill({ status: 400, contentType: "application/json", body: '{"message":"Unavailable"}' });
            return;
          }
        }
        await route.continue();
      });
      await page.locator("label").filter({ has: boxes[0] }).click();
      await expect(page.getByText(`${name}: Manage assignments turned on. Saved.`, { exact: true })).toBeAttached();
      await expect(boxes[0]).toBeEnabled();
      for (const box of boxes.slice(1)) await page.locator("label").filter({ has: box }).click();
      for (const box of boxes) {
        await expect(box).toBeChecked();
        await expect(box).toBeEnabled();
      }
      await expect.poll(async () => (await roleCapabilities(role!.id)).length).toBe(3);
      expect(reads.length).toBeGreaterThanOrEqual(3);
      for (const url of reads) {
        expect(url.searchParams.get("role_id")).toBe(`eq.${role!.id}`);
        expect(url.searchParams.has("capability")).toBe(true);
      }
      // A later unrelated save must not clear the value whose fetch failed.
      await expect(boxes[0]).toBeChecked();
    } finally {
      expect((await supabase.from("class_roles").delete().eq("id", role!.id)).error).toBeNull();
    }
  });

  test("an instructor creates a role, turns a capability on, and it is saved", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    // Sibling PRs may put capabilities on the default grader role; record them so we assert
    // this page left them alone rather than assuming the list is empty.
    const graderCapsBefore = await roleCapabilities(graderRoleId);

    await page.getByRole("button", { name: "Create a role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Role name").fill(roleName);
    await dialog.getByRole("button", { name: "Create role" }).click();
    await roleCount(page, roleName, "0 people");

    const roleId = await customRoleId(roleName);
    expect(roleId).toBeDefined();
    const capsBeforeToggle = await roleCapabilities(roleId!);
    expect(capsBeforeToggle).not.toContain("manage_assignments");

    await showCapabilities(page, roleName);
    const box = page.getByRole("switch", { name: `${roleName}: Manage assignments` });
    await expect(box).not.toBeChecked();
    // The switch input is visually hidden; click the label that holds it.
    await page.locator("label").filter({ has: box }).click();
    await expect(box).toBeChecked();

    await expect.poll(async () => (await roleCapabilities(roleId!)).includes("manage_assignments")).toBe(true);
    expect(await roleCapabilities(graderRoleId)).toEqual(graderCapsBefore);

    await page.reload();
    await openRolesPage(page);
    await showCapabilities(page, roleName);
    await expect(page.getByRole("switch", { name: `${roleName}: Manage assignments` })).toBeChecked();
    await showCapabilities(page);
    await expect(page.getByRole("switch", { name: "Grader: Manage assignments" })).not.toBeChecked();
  });

  test("an instructor puts a grader on the role, and that grader can then create assignments", async ({
    page,
    browser
  }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    const enrollmentReads: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname.endsWith("/rest/v1/user_roles")) enrollmentReads.push(url);
    });
    await showStaff(page);
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
    await expect(select).toBeEnabled();
    expect(enrollmentReads.length).toBeGreaterThan(0);
    for (const url of enrollmentReads) expect(url.searchParams.has("id")).toBe(true);
    await roleCount(page, roleName, "1 person");

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
    await editRole(page, roleName);
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
    await editRole(page, roleName);
    await page.getByRole("button", { name: `Rename ${roleName}` }).click();
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByLabel("Role name").fill(renamedRole);
    await renameDialog.getByRole("button", { name: "Rename" }).click();
    await roleCount(page, renamedRole, "1 person");
    expect(await customRoleId(renamedRole)).toBeDefined();

    await showStaff(page);
    await page.getByRole("combobox", { name: `Role for ${grader.private_profile_name}` }).selectOption({
      label: "Grader"
    });
    await roleCount(page, renamedRole, "0 people");

    await editRole(page, renamedRole);

    await page.getByRole("button", { name: `Delete ${renamedRole}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete role" }).click();
    await expect(
      page.getByRole("combobox", { name: "Role to edit" }).getByRole("option", { name: renamedRole, exact: true })
    ).toHaveCount(0);
    await expect.poll(() => customRoleId(renamedRole)).toBeUndefined();
  });

  // Self-contained: uses otherGrader and a fresh role so later tests still see the shared fixture.
  test("a role whose only member is a removed grader can't be deleted from the page", async ({ page }) => {
    const disabledOnlyRole = `Removed member ${Date.now().toString(36)}`;
    let roleId: number | undefined;
    try {
      await loginAsUser(page, instructor, course);
      await openRolesPage(page);
      await page.getByRole("button", { name: "Create a role" }).click();
      const createDialog = page.getByRole("dialog");
      await createDialog.getByLabel("Role name").fill(disabledOnlyRole);
      await createDialog.getByRole("button", { name: "Create role" }).click();
      await roleCount(page, disabledOnlyRole, "0 people");

      await showStaff(page);
      await page
        .getByRole("combobox", { name: `Role for ${otherGrader.private_profile_name}` })
        .selectOption({ label: disabledOnlyRole });
      roleId = await customRoleId(disabledOnlyRole);
      expect(roleId).toBeDefined();
      await expect
        .poll(async () => {
          const { data } = await supabase
            .from("user_roles")
            .select("class_role_id")
            .eq("class_id", course.id)
            .eq("private_profile_id", otherGrader.private_profile_id)
            .single();
          return data?.class_role_id;
        })
        .toBe(roleId);

      const { error: disableError } = await supabase
        .from("user_roles")
        .update({ disabled: true })
        .eq("class_id", course.id)
        .eq("private_profile_id", otherGrader.private_profile_id);
      expect(disableError).toBeNull();

      await page.reload();
      await openRolesPage(page);
      await roleCount(page, disabledOnlyRole, "0 people");
      await editRole(page, disabledOnlyRole);
      await page.getByRole("button", { name: `Delete ${disabledOnlyRole}` }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText("1 removed grader is still on this role.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Delete role" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Close" }).click();
      expect(await customRoleId(disabledOnlyRole)).toBeDefined();
    } finally {
      // Restore the enrollment and drop the test role so later serial tests aren't disturbed.
      const cleanupErrors: ({ message?: string } | null)[] = [];
      const { error: moveError } = await supabase
        .from("user_roles")
        .update({ class_role_id: graderRoleId, disabled: false })
        .eq("class_id", course.id)
        .eq("private_profile_id", otherGrader.private_profile_id);
      cleanupErrors.push(moveError);
      if (roleId != null) {
        const { error: deleteError } = await supabase.from("class_roles").delete().eq("id", roleId);
        cleanupErrors.push(deleteError);
      }
      for (const error of cleanupErrors) {
        expect(error).toBeNull();
      }
    }
  });

  test("a change the database refuses is shown as not saved, and the toggle goes back", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openRolesPage(page);
    const graderCapsBefore = await roleCapabilities(graderRoleId);
    await showCapabilities(page);
    const box = page.getByRole("switch", { name: "Grader: Publish groups" });
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
    // Toast and live-region both say this; scope to the toast root so the assertion is unique.
    const toast = page
      .locator('[data-scope="toast"][data-part="root"]')
      .filter({ hasText: "You don't have permission to change roles in this class." });
    await expect(toast).toHaveCount(1);
    await expect(box).not.toBeChecked();
    const graderCapsAfter = await roleCapabilities(graderRoleId);
    expect(graderCapsAfter).toEqual(graderCapsBefore);
    expect(graderCapsAfter).not.toContain("publish_groups");
  });
});
