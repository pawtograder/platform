import { Course, DayOfWeek } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import { supabase, createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
import { visualScreenshot } from "./VisualTestUtils";
dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let instructor1: TestingUser | undefined;
let instructor2: TestingUser | undefined;
const labSectionName = "<Instructor-created Lab Section>";
const labSectionDescription = "Lab Section 1 Description";

test.beforeAll(async () => {
  course = await createClass();
  //Fix course start and end dates for testing
  const { error: classError } = await supabase
    .from("classes")
    .update({ start_date: "2035-02-14", end_date: "2035-04-30" })
    .eq("id", course.id)
    .select()
    .single();
  if (classError) {
    throw new Error(`Failed to update class: ${classError.message}`);
  }
  [instructor1, instructor2] = await createUsersInClass([
    {
      name: "Lab Sections Instructor 1",
      public_profile_name: "Lab Sections Pseudonym Instructor 1",
      email: "lab-sections-instructor1@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Lab Sections Instructor 2",
      public_profile_name: "Lab Sections Pseudonym Instructor 2",
      email: "lab-sections-instructor2@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  // Create 20 lab sections
  const daysOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (let i = 0; i < 20; i++) {
    const { data: labSectionData, error: labSectionError } = await supabase
      .from("lab_sections")
      .insert({
        name: `<Lab Section ${i + 1}>`,
        day_of_week: daysOfWeek[i % daysOfWeek.length] as DayOfWeek,
        class_id: course.id,
        start_time: `${i % 24}:00`,
        end_time: `${(i + 1) % 24}:00`
      })
      .select("*")
      .single();
    if (labSectionError) {
      throw new Error(`Failed to create lab section: ${labSectionError.message}`);
    }
    // Insert lab section leader
    const { error: leaderError } = await supabase.from("lab_section_leaders").insert({
      lab_section_id: labSectionData.id,
      profile_id: instructor1!.private_profile_id,
      class_id: course.id
    });
    if (leaderError) {
      throw new Error(`Failed to create lab section leader: ${leaderError.message}`);
    }
  }
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor1, instructor2]);
});
test.describe("Lab Sections Page", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor1!, course);
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Lab Sections" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Lab Sections" }).click();
    // After the menuitem click, chakra triggers navigation AND starts closing
    // the dropdown. Under webkit contention the menu positioner has been seen
    // to linger after the new page has rendered, intercepting clicks on the
    // "Manage lab sections" link below (see CI run #24943326970 retry #2,
    // where an "Enrollments" menuitem subtree intercepted pointer events for
    // 60s).
    //
    // Confirm the dropdown has finished closing before clicking through to the
    // lab-sections page. Under webkit contention the menu positioner has been
    // seen to linger after the new page has rendered, intercepting clicks on
    // the "Manage lab sections" link below (see CI run #24943326970 retry #2,
    // where an "Enrollments" menuitem subtree intercepted pointer events for
    // 60s).
    //
    // The cleanest closed signal that works across all renderer states is the
    // menuitem itself. While the menu is open, "Lab Sections" is a real
    // accessible menuitem; once it closes, Chakra/zag-js unmounts the
    // menu.Content (no transition delay because tests/global-setup.ts disables
    // animations in visual mode), removing the menuitem from the a11y tree.
    // `toBeHidden` is satisfied by both "hidden attribute set" and "node
    // missing", so it handles both the visible-but-closed (data-state=closed)
    // and unmounted variants of the close.
    await expect(page.getByRole("menuitem", { name: "Lab Sections" })).toBeHidden({ timeout: 20_000 });

    // Menu click navigates to lab-roster; only THEN does the "Manage lab sections"
    // link render. Don't trust `Loading lab roster... toBeHidden()` as a readiness
    // signal — `toBeHidden` is satisfied while the new page hasn't mounted yet
    // (the spinner element doesn't exist yet), so we'd race past it onto a
    // still-empty DOM. The real signal is the role-gated "Manage lab sections"
    // link itself: it only renders once `isInitialized` flips true AND
    // `useIsInstructor()` resolves to true — which is exactly what we want to
    // click anyway. Wait directly for it.
    //
    // The lab_sections TableController in lib/TableController.ts now runs a
    // since-watermark catch-up refetch the first time its realtime channel
    // joins after hydrating from initialData (see
    // _needsCatchUpAfterInitialDataHydration). This catches rows inserted
    // between the SSR fetch and the channel-join, eliminating the empty-page
    // race that previously blocked isInitialized.
    await page.waitForURL("**/manage/course/lab-roster");
    await expect(page.getByRole("link", { name: "Manage lab sections" })).toBeVisible();
    await page.getByRole("link", { name: "Manage lab sections" }).click();
    await page.waitForURL("**/manage/course/lab-sections");
  });
  test("Instructors can view lab section contents", async ({ page }) => {
    // Check Lab Sections Page Contents. The lab-roster page we just left also
    // has a "Lab Sections" heading, so don't trust that as a "page loaded"
    // signal — the page itself shows a "Loading lab sections..." spinner until
    // both the labSections and labSectionMeetings TableControllers are ready.
    // useIsTableControllerReady (lib/TableController.ts) flips ready=true once
    // the initial fetch resolves, EVEN WITH ZERO ROWS.
    await expect(page.getByText("Loading lab sections...")).toBeHidden();
    await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();

    // The 20 lab sections are inserted in beforeAll via the admin client.
    // Each insert fires a postgres trigger that asynchronously POSTs to
    // /api/cache/invalidate to clear the SSR fetch cache for the
    // `lab_sections:${course_id}:staff` tag (see
    // supabase/migrations/20251228131640_cache_invalidation_triggers.sql).
    // Under CI contention these HTTP invalidations can land *after* the
    // course-layout SSR fetch in app/course/[course_id]/layout.tsx has
    // already populated `initialData.labSections` from a stale (often empty)
    // cache. The lab_sections TableController hydrates from that initialData
    // and then only ever subscribes for *future* realtime INSERTs — it does
    // not replay the 20 INSERTs that happened before the channel joined. So
    // the page can sit with 0–1 rows indefinitely (we observed 1 in CI run
    // #24943326970 retry #1, stuck for 30s).
    //
    // Detect that race and recover by hard-reloading the page once. By the
    // time we reload, the async cache invalidations have had >1s to land,
    // and the fresh SSR fetch returns all 20 rows. We give the optimistic
    // path 8s before falling back to reload so the common (cache-fresh) case
    // stays fast.
    try {
      await expect(page.getByRole("row")).toHaveCount(21, { timeout: 8_000 });
    } catch (err) {
      // Only swallow the count-mismatch timeout from `toHaveCount`. Anything
      // else (page crash, navigation failure, locator engine error) should
      // fail the test rather than silently re-trying. Inspect Playwright's
      // structured `matcherResult` rather than the rendered message string,
      // since the message format is not part of Playwright's API contract.
      const matcherResult = (err as { matcherResult?: { name?: string } } | null)?.matcherResult;
      if (!matcherResult || matcherResult.name !== "toHaveCount") throw err;
      await page.reload();
      await expect(page.getByText("Loading lab sections...")).toBeHidden();
      await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
      await expect(page.getByRole("row")).toHaveCount(21, { timeout: 30_000 });
    }
    await expect(page.getByText("<Lab Section 1>", { exact: true })).toBeVisible();
    await page.getByText("No upcoming meetings").first().waitFor({ state: "hidden" });
    await visualScreenshot(page, "Lab Sections Page Contents");
  });
  test("Instructors can create a lab section", async ({ page }) => {
    // Create a lab section
    await page.getByRole("button", { name: "Create Lab Section" }).click();
    await page.getByPlaceholder("e.g., Lab Section A").fill(labSectionName);
    // Wait for the multi-select to be available and select instructor2
    await page.waitForSelector('[role="combobox"]', { timeout: 10000 });
    await page.locator('[role="combobox"]').click();
    await page
      .getByText((instructor2!.private_profile_name || "Lab Sections Instructor 2") + " (instructor)", { exact: true })
      .click();
    await page.getByPlaceholder("Optional description").fill(labSectionDescription);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(`text=${labSectionName}`).first()).toBeVisible();
    await expect(page.locator(`text=${labSectionDescription}`).first()).toBeVisible();
    await expect(page.getByText("No lab sections created yet.")).not.toBeVisible();
  });
  test("Instructors can edit a lab section", async ({ page }) => {
    // Edit a pre-seeded section. Use "<Lab Section 15>" — its name is not a
    // substring of any other seeded section's name, so the row filter below is
    // unambiguous (unlike e.g. "<Lab Section 1>", which is a substring of 10-19).
    const originalName = "<Lab Section 15>";
    const updatedDescription = "Edited via e2e test";
    const row = page.getByRole("row").filter({ hasText: originalName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit lab section" }).click();

    // The shared modal renders "Edit Lab Section" when initialData is present.
    await expect(page.getByText("Edit Lab Section")).toBeVisible();
    await page.getByPlaceholder("Optional description").fill(updatedDescription);
    // The submit button reads "Update" in edit mode (vs "Create" when creating).
    await page.getByRole("button", { name: "Update" }).click();

    await expect(page.getByText("Edit Lab Section")).toBeHidden();
    // The edited description is rendered back in the table for that section.
    await expect(row.getByText(updatedDescription)).toBeVisible();
  });
  test("Instructors can delete a lab section", async ({ page }) => {
    // Regression test for "instructors unable to delete a lab section":
    // TableController.delete() soft-deletes via `UPDATE ... SET deleted_at`, but
    // lab_sections has no deleted_at column, so the delete always errored and the
    // section stayed. The page now uses hardDelete(); this test asserts the row is
    // both removed from the table AND gone from the database.
    const deletableName = "<Lab Section To Delete>";
    const { data: created, error } = await supabase
      .from("lab_sections")
      .insert({
        name: deletableName,
        day_of_week: "monday",
        class_id: course.id,
        start_time: "09:00",
        end_time: "10:00"
      })
      .select("*")
      .single();
    if (error) {
      throw new Error(`Failed to create lab section to delete: ${error.message}`);
    }
    const { error: leaderError } = await supabase.from("lab_section_leaders").insert({
      lab_section_id: created.id,
      profile_id: instructor1!.private_profile_id,
      class_id: course.id
    });
    if (leaderError) {
      throw new Error(`Failed to create lab section leader: ${leaderError.message}`);
    }

    // The section is inserted while this page is already open and subscribed, so
    // the realtime INSERT should deliver it live. Fall back to a single reload
    // (by which time the async SSR cache invalidation has landed) if it doesn't.
    const row = page.locator(`#lab-section-row-${created.id}`);
    try {
      await expect(row).toBeVisible({ timeout: 15_000 });
    } catch (err) {
      const matcherResult = (err as { matcherResult?: { name?: string } } | null)?.matcherResult;
      if (!matcherResult || matcherResult.name !== "toBeVisible") throw err;
      await page.reload();
      await expect(page.getByText("Loading lab sections...")).toBeHidden();
      await expect(row).toBeVisible({ timeout: 30_000 });
    }
    await expect(row.getByText(deletableName, { exact: true })).toBeVisible();

    // Open the delete confirmation popover (trigger aria-label "Delete lab section")
    // and confirm (confirm IconButton aria-label "Confirm action").
    await row.getByRole("button", { name: "Delete lab section" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();

    // The user-visible success signal is the row leaving the table. (The success
    // toast is intentionally not asserted — it auto-dismisses and is racy.)
    await expect(page.locator(`#lab-section-row-${created.id}`)).toHaveCount(0);

    // Hard delete: the row no longer exists in the database (not merely flagged).
    // The table removes the row optimistically, so poll until the server-side
    // DELETE has committed rather than racing it with a single query.
    await expect
      .poll(async () => {
        const { data, error: fetchError } = await supabase.from("lab_sections").select("id").eq("id", created.id);
        if (fetchError) {
          throw new Error(`Failed to query lab section after delete: ${fetchError.message}`);
        }
        return data?.length ?? 0;
      })
      .toBe(0);
  });
  test("Instructors can cancel a lab section meeting", async ({ page }) => {
    // Meetings are auto-generated between the class start/end dates (2035) by the
    // sync_lab_section_meetings trigger, so a seeded section has scheduled meetings.
    // "<Lab Section 16>" is not a substring of any other seeded section name.
    const sectionName = "<Lab Section 16>";
    const row = page.getByRole("row").filter({ hasText: sectionName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Manage meetings" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`Manage Meetings - ${sectionName}`)).toBeVisible();
    // Each generated meeting starts "Scheduled" with a "Cancel" action.
    const firstCancel = dialog.getByRole("button", { name: "Cancel", exact: true }).first();
    await expect(firstCancel).toBeVisible();
    await firstCancel.click();

    // The durable signal is the row flipping to "Cancelled" with a "Restore" action
    // (the "Meeting cancelled" toast auto-dismisses and is racy to assert).
    await expect(dialog.getByText("Cancelled").first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Restore", exact: true }).first()).toBeVisible();
  });
});
