/**
 * Gradebook column groups, end to end, with Argos screenshots of each state an instructor or
 * student sees, on a CS 4535-style course that existed before groups shipped (both features
 * written disabled; tests/e2e/gradebookColumnGroupsFixtures.ts): the legacy display, the
 * previewed enable, editing groups, and the student view.
 */
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import { createCs4535StyleGradebook } from "./gradebookColumnGroupsFixtures";
import {
  GRADEBOOK_VIEWPORT,
  headerUnits,
  openColumnMenu,
  openInstructorGradebook,
  scrollTableHome,
  tableRegion,
  waitForToastsGone,
  waitForVirtualizerIdle
} from "./gradebookTableHelpers";
import { loginAsUser, supabase, type TestingUser } from "./TestingUtils";
import { visualScreenshot } from "./VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(480_000);

test.describe("Gradebook column groups (existing course)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: GRADEBOOK_VIEWPORT });
  let fixture: Awaited<ReturnType<typeof createCs4535StyleGradebook>>;
  let student: TestingUser;

  test.beforeAll(async () => {
    // The fixture waits for the recalculation worker, which runs on a one-minute cron.
    test.setTimeout(480_000);
    fixture = await createCs4535StyleGradebook();
    student = fixture.students[0];
  });

  test("keeps the slug-guessed groups until an instructor turns groups on", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await openInstructorGradebook(page, fixture.course.id);

    // Today's heuristic, quirks included: the quiz-3 hole splits Quiz in two, and the first slug
    // token labels the AI usage logs "Ais".
    expect(await headerUnits(page)).toEqual([
      "4 Labs...",
      "3 Assignments...",
      "2 Exams...",
      "2 Quizzes...",
      "2 Quizzes...",
      "2 Ais...",
      "2 Averages..."
    ]);
    await visualScreenshot(page, "gradebook-groups-legacy-collapsed");
  });

  test("turning groups on previews every change, then stores the groups", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await page.goto(`/course/${fixture.course.id}/manage/course/feature-flags`);
    await visualScreenshot(page, "gradebook-groups-feature-flag-card", {
      element: page.locator(".chakra-card__root").filter({ hasText: "Gradebook column groups" })
    });
    await page.getByText("Use stored gradebook column groups").click();

    const dialog = page.getByRole("dialog", { name: "Turn on gradebook column groups" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("6 groups will be created")).toBeVisible();
    await expect(dialog.getByText("6 columns look different from today")).toBeVisible();
    await expect(
      dialog.getByRole("row", { name: /AI Usage Log 1 Ais \(2\) AI Usage Logs \(2\) header renamed/ })
    ).toBeVisible();
    await expect(dialog.getByRole("row", { name: /Quiz 4 Quizzes \(2\) Quizzes \(4\)/ })).toBeVisible();
    await visualScreenshot(page, "gradebook-groups-enable-preview", { element: dialog });

    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(
      page.getByRole("checkbox", { name: "Enable stored gradebook column groups for this course" })
    ).toBeChecked();

    const { data: groups } = await supabase
      .from("gradebook_column_groups")
      .select("name")
      .eq("class_id", fixture.course.id)
      .order("id");
    expect(groups?.map((g) => g.name)).toEqual([
      "Labs",
      "Assignments",
      "Exams",
      "Quizzes",
      "AI Usage Logs",
      "Averages"
    ]);

    await openInstructorGradebook(page, fixture.course.id);
    expect(await headerUnits(page)).toEqual([
      "4 Labs...",
      "3 Assignments...",
      "2 Exams...",
      "4 Quizzes...",
      "2 AI Usage Logs...",
      "2 Averages..."
    ]);
    await visualScreenshot(page, "gradebook-groups-stored-collapsed");

    await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);
    await visualScreenshot(page, "gradebook-groups-stored-expanded");
  });

  test("an instructor creates, renames and deletes groups from the table", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await openInstructorGradebook(page, fixture.course.id);
    await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);

    // A new group of one, from the column menu.
    await openColumnMenu(page, "Attendance");
    await page.getByRole("menuitem", { name: "Group…" }).click();
    const groupDialog = page.getByRole("dialog", { name: /Group for .Attendance./ });
    await groupDialog.getByLabel("Group").selectOption("new");
    await groupDialog.getByLabel("New group name").fill("Participation");
    await groupDialog.getByRole("button", { name: "Save" }).click();
    await expect(groupDialog).toBeHidden();
    await expect.poll(() => headerUnits(page)).toContain("1 Participation...");

    // Rename from the group header menu.
    await tableRegion(page).getByRole("button", { name: "Group options for Exams" }).click();
    await page.getByRole("menuitem", { name: "Rename group" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename group" });
    await renameDialog.getByLabel("Group name").fill("Midterms");
    await renameDialog.getByRole("button", { name: "Rename" }).click();
    await expect.poll(() => headerUnits(page)).toContain("2 Midterms...");

    // Names are unique per gradebook, ignoring case.
    await tableRegion(page).getByRole("button", { name: "Group options for Midterms" }).click();
    await page.getByRole("menuitem", { name: "Rename group" }).click();
    await renameDialog.getByLabel("Group name").fill("labs");
    await renameDialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Failed to rename the group")).toBeAttached();
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByRole("button", { name: "Cancel" }).click();

    // Deleting a group keeps its columns.
    await tableRegion(page).getByRole("button", { name: "Group options for Participation" }).click();
    await page.getByRole("menuitem", { name: "Delete group" }).click();
    await page
      .getByRole("dialog", { name: /Delete group/ })
      .getByRole("button", { name: "Delete group" })
      .click();
    await expect.poll(() => headerUnits(page)).not.toContain("1 Participation...");
    await expect(tableRegion(page).getByText("Attendance", { exact: true })).toBeVisible();

    await waitForToastsGone(page);
    await scrollTableHome(page);
    await visualScreenshot(page, "gradebook-groups-after-edits");
  });

  test("every instructor surface for columns and groups", async ({ page }) => {
    await loginAsUser(page, fixture.instructor, fixture.course);
    await openInstructorGradebook(page, fixture.course.id);
    await tableRegion(page).getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);

    // The column menu: Group…, and Move Left/Right that stay inside the group (Quiz 1 is first).
    await openColumnMenu(page, "Quiz 1");
    await expect(page.getByRole("menuitem", { name: "Move Left", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Move Right", exact: true })).toBeEnabled();
    await visualScreenshot(page, "gradebook-groups-column-menu");

    // Group… for a column: existing groups, or a new one by name.
    await page.getByRole("menuitem", { name: "Group…" }).click();
    const groupDialog = page.getByRole("dialog", { name: /Group for .Quiz 1./ });
    await expect(groupDialog.getByLabel("Group")).toHaveValue(/\d+/);
    await groupDialog.getByLabel("Group").selectOption("new");
    await groupDialog.getByLabel("New group name").fill("Quiz retakes");
    await visualScreenshot(page, "gradebook-groups-column-group-dialog", { element: groupDialog });
    await groupDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(groupDialog).toBeHidden();

    // The group header menu, and the rename and delete dialogs it opens.
    await tableRegion(page).getByRole("button", { name: "Group options for Quizzes" }).click();
    await expect(page.getByRole("menuitem", { name: "Move group left" })).toBeEnabled();
    await visualScreenshot(page, "gradebook-groups-group-menu");
    await page.getByRole("menuitem", { name: "Rename group" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename group" });
    await renameDialog.getByLabel("Group name").fill("Weekly quizzes");
    await visualScreenshot(page, "gradebook-groups-rename-dialog", { element: renameDialog });
    await renameDialog.getByRole("button", { name: "Cancel" }).click();

    await tableRegion(page).getByRole("button", { name: "Group options for Quizzes" }).click();
    await page.getByRole("menuitem", { name: "Delete group" }).click();
    const deleteDialog = page.getByRole("dialog", { name: /Delete group .Quizzes./ });
    await visualScreenshot(page, "gradebook-groups-delete-dialog", { element: deleteDialog });
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();

    // Add Column and Edit Column, each with the Group picker.
    await page.getByRole("button", { name: "Add Column" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add Column" });
    await addDialog.locator("#name").fill("Quiz 6");
    await addDialog.locator("#maxScore").fill("10");
    await addDialog.locator("#slug").fill("quiz-6");
    await addDialog.locator("#columnGroup").selectOption({ label: "Quizzes" });
    await visualScreenshot(page, "gradebook-groups-add-column-dialog", { element: addDialog });
    await addDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(addDialog).toBeHidden();

    await openColumnMenu(page, "Attendance");
    await page.getByRole("menuitem", { name: "Edit Column" }).click();
    const editDialog = page.getByRole("dialog", { name: /Edit Column/ });
    await expect(editDialog.locator("#columnGroup")).toHaveValue("none");
    await visualScreenshot(page, "gradebook-groups-edit-column-dialog", { element: editDialog });
    await editDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(editDialog).toBeHidden();

    // Auto-group from the action bar, once groups are on: only what is still ungrouped.
    await page.getByRole("button", { name: "Auto-group Columns" }).click();
    const autoDialog = page.getByRole("dialog", { name: "Auto-group ungrouped columns" });
    // Everything groupable is grouped already, so there is nothing to confirm.
    await expect(autoDialog.getByText(/No columns would be grouped/)).toBeVisible();
    await expect(autoDialog.getByRole("button", { name: "Create groups" })).toBeDisabled();
    await visualScreenshot(page, "gradebook-groups-auto-group-dialog", { element: autoDialog });
    await autoDialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("students see stored group names, and never a group of hidden columns", async ({ page }) => {
    // An instructor-only column alone in a group: its name must not reach students.
    const { data: curve } = await supabase
      .from("gradebook_columns")
      .select("id, gradebook_id")
      .eq("class_id", fixture.course.id)
      .eq("slug", "curve-adjustment")
      .single();
    const { error } = await supabase.rpc("gradebook_column_group_create", {
      p_gradebook_id: curve!.gradebook_id,
      p_name: "Curve (staff only)",
      p_column_ids: [curve!.id]
    });
    expect(error).toBeNull();

    await loginAsUser(page, student, fixture.course);
    await page.goto(`/course/${fixture.course.id}/gradebook`);
    const region = page.getByRole("region", { name: "Student Gradebook" });
    await expect(region).toBeVisible({ timeout: 60_000 });
    await expect(region.getByRole("button", { name: "4 Quizzes..." })).toBeVisible();
    await expect(region.getByRole("button", { name: "2 AI Usage Logs..." })).toBeVisible();
    await expect(region.getByText("Curve (staff only)")).toHaveCount(0);
    await expect(region.getByText("Curve Adjustment")).toHaveCount(0);
    await visualScreenshot(page, "gradebook-groups-student-whatif");
  });
});
