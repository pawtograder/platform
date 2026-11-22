/**
 * #1010: the staff gradebook needs manage_gradebook (20261121160100_gradebook_by_capability.sql and
 * 20261121200200_gradebook_view_by_capability.sql). Without it, the gradebook page sends a staff
 * member back to the course page, and the Gradebook link, the "Manage gradebook" search entry and
 * the Grades card on a student's page are hidden. A Head TA on a custom role with manage_gradebook
 * gets all of them and the gradebook's controls (Add Column, Import Columns, Auto-layout, the group
 * menus, Edit, Move, Release, Delete and Convert Missing to 0). Instructors see no change.
 *
 * The default instructor role holds manage_gradebook, the default grader role doesn't.
 */
import { expect, test, type Page } from "@playwright/test";
import { createClass, createUserInClass, loginAsUser, supabase, type TestingUser } from "./TestingUtils";
import { tableRegion, waitForVirtualizerIdle } from "./gradebookTableHelpers";

test.describe.configure({ mode: "serial" });

test.describe("gradebook controls gated by manage_gradebook", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let headTa: TestingUser;
  let student: TestingUser;
  let headTaRoleId: number;
  const GROUP = "Quizzes";
  const STANDALONE = "Participation";

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Gradebook Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    student = await createUserInClass({ role: "student", class_id: course.id });

    const { data: classRow } = await supabase.from("classes").select("gradebook_id").eq("id", course.id).single();
    const gradebook_id = classRow!.gradebook_id!;
    const ids: number[] = [];
    for (const [i, [slug, name]] of [
      ["quiz-1", "Quiz 1"],
      ["quiz-2", "Quiz 2"],
      ["participation", STANDALONE]
    ].entries()) {
      const { data, error } = await supabase
        .from("gradebook_columns")
        .insert({ class_id: course.id, gradebook_id, slug, name, max_score: 10, sort_order: i })
        .select("id")
        .single();
      expect(error).toBeNull();
      ids.push(data!.id);
    }
    // A group of two columns, so the header shows the group menu and Auto-layout.
    const { error: groupError } = await supabase.rpc("gradebook_column_group_create", {
      p_gradebook_id: gradebook_id,
      p_name: GROUP,
      p_column_ids: ids.slice(0, 2)
    });
    expect(groupError).toBeNull();

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Gradebook TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    headTaRoleId = role!.id;
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: role!.id, capability: "manage_gradebook" })).error
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

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  async function openGradebook(page: Page) {
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(`/course/${course.id}/manage/gradebook`);
    await capabilities;
    await expect(tableRegion(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Showing 1 student/)).toBeVisible({ timeout: 60_000 });
    await waitForVirtualizerIdle(page);
  }

  // Opens a course page and waits until the capabilities are in, so a hidden entry means "not held".
  async function gotoWithCapabilities(page: Page, url: string) {
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await page.goto(url);
    await capabilities;
    await expect(page.locator("[data-capabilities-loaded]")).toBeAttached({ timeout: 30_000 });
  }

  async function expectSearchEntry(page: Page, visible: boolean) {
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: "Search Pawtograder" });
    await expect(box).toBeVisible();
    // "manage" also finds the other staff pages (Manage assignments, ...), so once results show, a
    // missing "Manage gradebook" means it was left out.
    await box.fill("manage");
    const results = page.getByRole("listbox", { name: "Search results" });
    await expect(results.getByRole("option", { name: /Manage assignments/ })).toBeVisible();
    await expect(results.getByRole("option", { name: /Manage gradebook/ })).toHaveCount(visible ? 1 : 0);
    await page.keyboard.press("Escape");
  }

  async function expectGradesCard(page: Page, visible: boolean) {
    await gotoWithCapabilities(page, `/course/${course.id}/manage/student/${student.private_profile_id}`);
    await expect(page.getByRole("heading", { name: "Discussion Replies" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Grades", exact: true })).toHaveCount(visible ? 1 : 0);
  }

  // Finds the header by its column name, the same way for every role.
  async function openColumnMenu(page: Page, columnName: string) {
    const header = tableRegion(page)
      .getByRole("columnheader")
      .filter({ has: page.getByText(columnName, { exact: true }) })
      .first();
    await header.scrollIntoViewIfNeeded();
    await header.getByRole("button", { name: "Column options" }).click();
  }

  const COLUMN_ACTIONS = ["Edit Column", "Move Left", "Move Right", "Release Column", "Delete Column"];

  async function expectControls(page: Page, visible: boolean) {
    const count = visible ? 1 : 0;
    await expect(page.getByRole("button", { name: "Add Column" })).toHaveCount(count);
    await expect(page.getByRole("button", { name: "Import Columns" })).toHaveCount(count);
    await expect(tableRegion(page).getByRole("button", { name: "Auto-layout columns" })).toHaveCount(count);
    await expect(tableRegion(page).getByRole("button", { name: `Group options for ${GROUP}` })).toHaveCount(count);

    await openColumnMenu(page, STANDALONE);
    await expect(page.getByRole("menuitem", { name: "Sort Ascending" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Convert Missing to 0" })).toBeVisible();
    for (const name of COLUMN_ACTIONS) {
      await expect(page.getByRole("menuitem", { name, exact: true }), name).toHaveCount(count);
    }
    await page.keyboard.press("Escape");
  }

  // The Gradebook link in the course nav follows manage_gradebook too. Only the visible nav twin
  // is in the accessibility tree, so this counts the one on screen.
  async function expectGradebookLink(page: Page, visible: boolean) {
    await expect(page.locator("#course-nav").getByRole("link", { name: "Gradebook", exact: true })).toHaveCount(
      visible ? 1 : 0
    );
  }

  test("a grader is sent away from the gradebook and doesn't find it anywhere", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await gotoWithCapabilities(page, `/course/${course.id}/manage/gradebook`);
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}$`));
    await expectGradebookLink(page, false);
    await expectSearchEntry(page, false);
    await expectGradesCard(page, false);
  });

  test("a Head TA with manage_gradebook sees the gradebook, its controls and the Grades card", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openGradebook(page);
    await expectControls(page, true);
    await expectGradebookLink(page, true);
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toHaveCount(0);
    await expectSearchEntry(page, true);
    await expectGradesCard(page, true);
  });

  test("an instructor still sees all of it", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openGradebook(page);
    await expectControls(page, true);
    await expectGradebookLink(page, true);
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toBeVisible();
    await expectSearchEntry(page, true);
    await expectGradesCard(page, true);
  });

  // The capability provider stops retrying after a few failed lookups. Instructors hold every
  // capability, so their link mustn't depend on that lookup.
  test("an instructor keeps the Gradebook link when the capability lookup fails", async ({ page }) => {
    await page.route("**/rpc/user_class_capabilities*", (route) => route.fulfill({ status: 500, body: "{}" }));
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}`);
    await expectGradebookLink(page, true);
  });

  // The header is chosen by role, so losing manage_gradebook only hides the drag handles; it doesn't
  // remount the headers and close a dialog a Head TA has open.
  test("a Head TA's open column dialog stays open when manage_gradebook is turned off", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openGradebook(page);
    const dragHandles = tableRegion(page).locator('[aria-label="Drag to reorder column"]');
    await expect(dragHandles.first()).toBeAttached();

    await openColumnMenu(page, STANDALONE);
    await page.getByRole("menuitem", { name: "Convert Missing to 0" }).click();
    const dialog = page.getByRole("dialog", { name: "Convert Missing to 0" });
    await expect(dialog).toBeVisible();

    try {
      expect(
        (
          await supabase
            .from("role_capabilities")
            .delete()
            .eq("role_id", headTaRoleId)
            .eq("capability", "manage_gradebook")
        ).error
      ).toBeNull();
      // The role change reaches the page, and the handles go away...
      await expect(dragHandles).toHaveCount(0, { timeout: 30_000 });
      // ...while the dialog stays open.
      await expect(dialog).toBeVisible();
    } finally {
      await supabase.from("role_capabilities").insert({ role_id: headTaRoleId, capability: "manage_gradebook" });
    }
  });
});
