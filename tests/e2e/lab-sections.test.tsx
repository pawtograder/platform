import { Course, DayOfWeek } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import { supabase, createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
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
      email: "lab-sections-instructor1@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Lab Sections Instructor 2",
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
    // The chakra menu's *positioner* is a popper container that stays in the
    // DOM regardless of menu open/closed (no `data-state` on it). The actual
    // closed signal is on `Menu.Content`: when the menu closes, zag-js sets
    // `hidden` and `data-state="closed"` on the content (see
    // node_modules/@zag-js/menu/dist/index.js getContentProps). Asserting the
    // positioner toBeHidden() is therefore a brittle proxy that depends on
    // browser-specific bbox semantics — webkit has been observed to keep the
    // empty positioner reported as "visible" for >20s. Wait on the
    // authoritative content `data-state="closed"` instead.
    await expect(page.locator('[data-part="content"][data-scope="menu"]')).toHaveAttribute("data-state", "closed");

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
    } catch {
      await page.reload();
      await expect(page.getByText("Loading lab sections...")).toBeHidden();
      await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
      await expect(page.getByRole("row")).toHaveCount(21, { timeout: 30_000 });
    }
    await expect(page.getByText("<Lab Section 1>", { exact: true })).toBeVisible();
    await page.getByText("No upcoming meetings").first().waitFor({ state: "hidden" });
    await argosScreenshot(page, "Lab Sections Page Contents");
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
});
