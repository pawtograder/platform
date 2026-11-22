/**
 * #1010: arranging the gradebook needs manage_gradebook (20261121160100_gradebook_by_capability.sql).
 * Without it the gradebook hides Add Column, Import Columns, Auto-layout, the group menus and the
 * column actions that change a column (Edit, Move, Release, Delete). Convert Missing to 0 writes
 * cells, so graders keep it. A Head TA on a custom role with manage_gradebook sees the controls.
 * Instructors see no change.
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
  const GROUP = "Quizzes";
  const STANDALONE = "Participation";

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Gradebook Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    headTa = await createUserInClass({ role: "grader", class_id: course.id });
    await createUserInClass({ role: "student", class_id: course.id });

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

  // openColumnMenu in gradebookTableHelpers finds headers by data-col-id, which only the draggable
  // (manage_gradebook) headers carry. A grader gets the plain header, so this finds either by role.
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

  test("a grader doesn't see the gradebook's column controls", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await openGradebook(page);
    await expectControls(page, false);
    await expectGradebookLink(page, false);
    // Downloading stays instructor-only, as before.
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toHaveCount(0);
  });

  test("a Head TA with manage_gradebook sees them", async ({ page }) => {
    await loginAsUser(page, headTa, course);
    await openGradebook(page);
    await expectControls(page, true);
    await expectGradebookLink(page, true);
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toHaveCount(0);
  });

  test("an instructor still sees them", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await openGradebook(page);
    await expectControls(page, true);
    await expectGradebookLink(page, true);
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toBeVisible();
  });

  // The capability provider stops retrying after a few failed lookups. Instructors hold every
  // capability, so their link mustn't depend on that lookup.
  test("an instructor keeps the Gradebook link when the capability lookup fails", async ({ page }) => {
    await page.route("**/rpc/user_class_capabilities*", (route) => route.fulfill({ status: 500, body: "{}" }));
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}`);
    await expectGradebookLink(page, true);
  });
});
