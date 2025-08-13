import { Course } from "@/utils/supabase/DatabaseTypes";
import percySnapshot from "@percy/playwright";
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import { createClass, createUserInClass, loginAsUser, TestingUser } from "./TestingUtils";
dotenv.config({ path: ".env.local" });

let course: Course;
let instructor1: TestingUser | undefined;
let instructor2: TestingUser | undefined;
const labSectionName = "Lab Section 1";
const labSectionDescription = "Lab Section 1 Description";

test.beforeAll(async () => {
  course = await createClass();
  instructor1 = await createUserInClass({
    role: "instructor",
    class_id: course.id
  });
  instructor2 = await createUserInClass({
    role: "instructor",
    class_id: course.id
  });
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
    await percySnapshot(page, "Lab Sections Page");
    await expect(page.getByRole("heading", { name: "Lab Sections" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Lab Section" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create your first lab section" })).toBeVisible();
    await expect(page.getByText("No lab sections created yet.")).toBeVisible();
  });
  test("Instructors can create a lab section", async ({ page }) => {
    // Create a lab section
    await page.getByRole("button", { name: "Create Lab Section" }).click();
    await page.getByPlaceholder("e.g., Lab Section A").fill(labSectionName);
    await page.waitForSelector(`select[name="lab_leader_id"] option[value="${instructor2!.private_profile_id}"]`, {
      state: "attached"
    });
    await page.locator('select[name="lab_leader_id"]').selectOption(instructor2!.private_profile_id);
    await page.getByPlaceholder("Optional description").fill(labSectionDescription);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(labSectionName, { exact: true })).toBeVisible();
    await expect(page.getByText(labSectionDescription)).toBeVisible();
    await expect(page.getByText(instructor2?.private_profile_name ?? "", { exact: true })).toBeVisible();
    await expect(page.getByRole("paragraph").filter({ hasText: "Monday" })).toBeVisible();
    await expect(page.getByText("10:00 AM - 11:00 AM")).toBeVisible();
    await expect(page.getByText("0 Students")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create your first lab section" })).not.toBeVisible();
    await expect(page.getByText("No lab sections created yet.")).not.toBeVisible();
  });
});
