import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import { createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
import { visualScreenshot } from "./VisualTestUtils";
dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(120_000);

let course: Course;
let student1: TestingUser | undefined;
let instructor1: TestingUser | undefined;

const student2Name = "Enrollments Added Student";
const student2Email = "enrollments-added-student@pawtograder.net";
const graderName = "Enrollments Added Grader";
const graderEmail = "enrollments-added-grader@pawtograder.net";
const instructor2Name = "Enrollments Added Instructor";
const instructor2Email = "enrollments-added-instructor@pawtograder.net";

async function stabilizeImportPreviewDialog(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const dialog = page.getByLabel("Import Roster from CSV");
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
    for (const child of Array.from(element.querySelectorAll("*"))) {
      if (child instanceof HTMLElement) {
        child.scrollTop = 0;
        child.scrollLeft = 0;
      }
    }
  });
  return dialog;
}

test.beforeAll(async () => {
  course = await createClass();
  [student1, instructor1] = await createUsersInClass([
    {
      name: "Enrollments Student 1",
      public_profile_name: "Enrollments Pseudonym Student 1",
      email: "enrollments-student1@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Enrollments Instructor 1",
      public_profile_name: "Enrollments Pseudonym Instructor 1",
      email: "enrollments-instructor1@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student1, instructor1]);
});
test.describe("Enrollments Page", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor1!, course);
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Enrollments" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Enrollments" }).click();
  });
  test("Instructors can view enrollments", async ({ page }) => {
    // Check Enrollments Page Contents
    await expect(page.getByRole("heading", { name: "Enrollments" })).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Name" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Email" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Role" }).first()).toBeVisible();
    await expect(
      page.locator("th.chakra-table__columnHeader").filter({ hasText: "GitHub Username" }).first()
    ).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Tags" }).first()).toBeVisible();
    await expect(page.locator("th.chakra-table__columnHeader").filter({ hasText: "Actions" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Course Member" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import from CSV" })).toBeVisible();
    await expect(page.getByText(student1?.email ?? "")).toBeVisible();
    await expect(page.getByText(student1?.private_profile_name ?? "")).toBeVisible();
    await expect(page.getByText(instructor1?.email ?? "")).toBeVisible();
    await expect(page.getByText(instructor1?.private_profile_name ?? "")).toBeVisible();
    await visualScreenshot(page, "Enrollments Page");
  });

  // Note: Creating users is expensive and can overwhelm supabase auth connections.

  test("Instructors can add individual course members", async ({ page }) => {
    // Test Add Course Member Dialog With Student Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.getByPlaceholder("Name")).toBeVisible();
    await expect(page.locator('select[name="role"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
    await page.getByPlaceholder("Email").fill(student2Email);
    await page.getByPlaceholder("Name").fill(student2Name);
    await page.locator('select[name="role"]').selectOption("student");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(student2Email)).toBeVisible();
    await expect(page.getByText(student2Name)).toBeVisible();

    // Test Add Course Member Dialog With Grader Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await page.getByPlaceholder("Email").fill(graderEmail);
    await page.getByPlaceholder("Name").fill(graderName);
    await page.locator('select[name="role"]').selectOption("grader");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(graderEmail)).toBeVisible();
    await expect(page.getByText(graderName)).toBeVisible();

    // Test Add Course Member Dialog With Instructor Role
    await page.getByRole("button", { name: "Add Course Member" }).click();
    await expect(page.getByLabel("Add Course Member Dialog")).toBeVisible();
    await page.getByPlaceholder("Email").fill(instructor2Email);
    await page.getByPlaceholder("Name").fill(instructor2Name);
    await page.locator('select[name="role"]').selectOption("instructor");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(instructor2Email)).toBeVisible();
    await expect(page.getByText(instructor2Name)).toBeVisible();
    // TODO: The cells for roles don't have any unique characteristics except for the composition of the parent row and combination of sibling cells, probably needs a revisit for proper testing.
  });

  test("Instructors can add course members from CSV", async ({ page }) => {
    await page.getByRole("button", { name: "Import from CSV" }).click();
    await expect(page.getByLabel("Import Roster from CSV")).toBeVisible();

    // Upload the test CSV file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/test.csv");
    await page.getByLabel("Import Roster from CSV").getByRole("button", { name: "Show Import Preview" }).click();
    const importDialog = await stabilizeImportPreviewDialog(page);
    await expect(importDialog.getByText("Will be enrolled directly (2)")).toBeVisible();
    await expect(
      importDialog.getByText("Test Student (test-student-import-csv@pawtograder.net) - student")
    ).toBeVisible();
    await expect(importDialog.getByText("Test Grader (test-grader-import-csv@pawtograder.net) - grader")).toBeVisible();
    await expect(importDialog.getByRole("button", { name: "Confirm Import (2)" })).toBeVisible();
    await visualScreenshot(page, "Importing CSV of 2 users", { element: importDialog });
    await page.getByRole("button", { name: "Confirm Import (2)" }).click();
    await expect(page.getByText("test-student-import-csv@pawtograder.net")).toBeVisible();
    await expect(page.getByText("test-grader-import-csv@pawtograder.net")).toBeVisible();
  });
});
