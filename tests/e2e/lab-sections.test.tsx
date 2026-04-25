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
    // Menu click navigates to lab-roster; only THEN does the "Manage lab sections"
    // link render. Without an explicit wait, webkit races the navigation and the
    // click times out searching the previous page's DOM. The lab-roster page
    // also has its own "Loading lab roster..." spinner that hides only once
    // its data hooks resolve — that's the real signal that the page header
    // (with the "Manage lab sections" link) has rendered.
    await page.waitForURL("**/manage/course/lab-roster");
    await expect(page.getByText("Loading lab roster...")).toBeHidden();
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
    // the initial fetch resolves, EVEN WITH ZERO ROWS — so the spinner can
    // hide while the realtime broadcast for the 20 inserted lab sections
    // hasn't arrived yet, leaving the page showing "No lab sections created
    // yet." Wait for the actual row count to settle (20 inserted in beforeAll
    // + 1 header row = 21 rows).
    await expect(page.getByText("Loading lab sections...")).toBeHidden();
    await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(21, { timeout: 30_000 });
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
