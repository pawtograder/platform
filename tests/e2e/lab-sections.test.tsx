import { Course, DayOfWeek } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import { supabase, createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
dotenv.config({ path: ".env.local" });

let course: Course;
let instructor1: TestingUser | undefined;
let instructor2: TestingUser | undefined;
const labSectionName = "<Instructor-created Lab Section>";
const labSectionDescription = "Lab Section 1 Description";

test.beforeAll(async () => {
  course = await createClass();
  //Fix course start and end dates for testing, always start on Feb 14 2025 and go to April 30 2025
  await supabase.from("classes").update({ start_date: "2035-02-14", end_date: "2035-04-30" }).eq("id", course.id);
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
  // Create 10 lab sections
  const daysOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (let i = 0; i < 20; i++) {
    const { error: labSectionError } = await supabase
      .from("lab_sections")
      .insert({
        lab_leader_id: instructor1!.private_profile_id,
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
  }
});

test.describe("Lab Sections Page", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor1!, course);
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Lab Sections" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Lab Sections" }).click();
  });
  test("Instructors can view lab section contents", async ({ page }) => {
    // Check Lab Sections Page Contents
    await expect(page.getByRole("heading", { name: "Lab Sections" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
    await expect(page.getByText("<Lab Section 1>", { exact: true })).toBeVisible();
    await page.getByText("No upcoming meetings").first().waitFor({ state: "hidden" });
    await argosScreenshot(page, "Lab Sections Page Contents");
  });
  test("Instructors can create a lab section", async ({ page }) => {
    // Create a lab section
    await page.getByRole("button", { name: "Create Lab Section" }).click();
    await page.getByPlaceholder("e.g., Lab Section A").fill(labSectionName);
    await page.waitForFunction(
      (profileId) => {
        const select = document.querySelector('select[name="lab_leader_id"]');
        if (!select) return false;
        const option = select.querySelector(`option[value="${profileId}"]`);
        return option !== null;
      },
      instructor2!.private_profile_id,
      { timeout: 10000 }
    );
    await page.locator('select[name="lab_leader_id"]').selectOption(instructor2!.private_profile_id);
    await page.getByPlaceholder("Optional description").fill(labSectionDescription);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(`text=${labSectionName}`).first()).toBeVisible();
    await expect(page.locator(`text=${labSectionDescription}`).first()).toBeVisible();
    await expect(page.getByText("No lab sections created yet.")).not.toBeVisible();
  });
});
