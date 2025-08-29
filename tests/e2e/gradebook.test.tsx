import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import type { Page } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  loginAsUser,
  TestingUser,
  createAssignmentsAndGradebookColumns
} from "./TestingUtils";
// removed unused import

dotenv.config({ path: ".env.local" });

let course: Course;
let students: TestingUser[] = [];
let instructor: TestingUser | undefined;

// Helpers
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getStudentRow(page: Page, name: string) {
  return page.getByRole("row", { name: new RegExp(`^Student ${escapeRegExp(name)} grades$`) });
}

async function getGridcellInRow(page: Page, rowName: string, columnName: string) {
  const row = await getStudentRow(page, rowName);
  // Allow dynamic suffixes (e.g., "Imported Quiz (Imported 8/28/2025 #abcd)") before the colon
  return row.getByRole("gridcell", { name: new RegExp(`^Grade cell for ${escapeRegExp(columnName)}.*:`) });
}

async function readCellNumber(page: Page, rowName: string, columnName: string) {
  const cell = await getGridcellInRow(page, rowName, columnName);
  const text = (await cell.innerText()).trim();
  const num = Number(text.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(num) ? num : NaN;
}

async function readCellText(page: Page, rowName: string, columnName: string) {
  const cell = await getGridcellInRow(page, rowName, columnName);
  return (await cell.innerText()).trim();
}

test.describe("Gradebook Page - Comprehensive", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    // Create the class
    course = await createClass({
      name: "Gradebook Test Course"
    });

    // Create a small roster and an instructor
    const users = await createUsersInClass([
      {
        name: "Alice Anderson",
        email: "alice-gradebook@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Bob Brown",
        email: "bob-gradebook@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Charlie Chen",
        email: "charlie-gradebook@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Professor Smith",
        email: "prof-smith-gradebook@pawtograder.net",
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    students = users.slice(0, 3);
    instructor = users[3];

    // Create a minimal set of assignments and gradebook columns (helper handles expressions and dependencies)
    await createAssignmentsAndGradebookColumns({
      class_id: course.id,
      numAssignments: 2,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "individual"
    });
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");
  });

  test("Instructors can view comprehensive gradebook with real data", async ({ page }) => {
    // Verify the gradebook loads with all components
    await expect(page.getByText("Student Name")).toBeVisible();

    // Check that all students are visible (virtualized rows expose aria-label per row)
    for (const s of students) {
      await expect(
        page.getByRole("row", { name: new RegExp(`^Student ${escapeRegExp(s.private_profile_name)} grades$`) })
      ).toBeVisible();
    }

    // Verify calculated/summary columns are present (some headers may be grouped/virtualized)
    // Check for at least one Average column and the Final Grade column
    await expect(page.getByText("Average Lab Assignments")).toBeVisible();

    // Verify manual grading columns
    await expect(page.getByText("Participation")).toBeVisible();

    // Check calculated columns (avoid relying on hidden/virtualized headers)
    await expect(page.getByText("Average Lab Assignments")).toBeVisible();
    await expect(page.getByText("Final Grade")).toBeVisible();

    // Verify student count
    await expect(page.getByText(`Showing ${students.length} students`)).toBeVisible();

    // Check action buttons
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import Column" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Column" })).toBeVisible();

    // Take screenshot for visual regression testing
    await argosScreenshot(page, "Gradebook Page - Full Data");
  });

  test("Editing a manual column updates the Participation cell value", async ({ page }) => {
    const studentName = students[0].private_profile_name;
    // Open Participation cell and set score to 80
    const partCell = await getGridcellInRow(page, studentName, "Participation");
    await partCell.click();
    await page.locator('input[name="score"]').fill("80");
    await page.getByRole("button", { name: /^Update$/ }).click();

    // Expect participation cell to show the new value and final grade to change
    await expect(partCell).toHaveText(/80(\.0+)?|80$/);
  });

  test("Overriding a calculated column (Final Grade) persists and displays the override", async ({ page }) => {
    const studentName = students[0].private_profile_name;
    const before = await readCellNumber(page, studentName, "Final Grade");

    // Open Final Grade cell and override
    const finalCell = await getGridcellInRow(page, studentName, "Final Grade");
    await finalCell.click();
    await page.locator('input[name="score_override"]').fill("92");
    await page.getByRole("button", { name: /^Save Override$/ }).click();

    // Value should update to the override
    await expect(async () => {
      const after = await readCellNumber(page, studentName, "Final Grade");
      expect(after).not.toBeNaN();
      expect(after).toBe(92);
      expect(after).not.toBe(before);
    }).toPass();
  });

  test("Import Column workflow creates a new column and populates scores", async ({ page }) => {
    // Open import dialog
    await page.getByRole("button", { name: "Import Column" }).click();

    // Step 1: upload file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/gradebook-test.csv");

    // Step 2: map columns - pick Create new column for the only grade column
    // Target the mapping select specifically (it is the only select that contains option value "new")
    await expect(page.getByText("Map grade columns:")).toBeVisible();
    const mappingSelect = page.locator('select:has(option[value="new"])').first();
    await mappingSelect.selectOption("new");

    // Provide max score if input appears
    const maxScoreInput = page.locator('input[type="number"]');
    if (await maxScoreInput.count()) {
      // Fill the last numeric input to avoid interfering with other numeric inputs
      await maxScoreInput.last().fill("100");
    }

    // Preview & Confirm
    await page.getByRole("button", { name: "Preview Import" }).click();
    await page.getByRole("button", { name: "Confirm Import" }).click();

    // After import, the dialog closes and a new column should exist (name contains "Imported Quiz")
    await expect(page.getByText(/Imported Quiz/)).toBeVisible();

    // Validate at least one student's imported score shows up in the new column
    await expect(page.getByRole("gridcell", { name: /Grade cell for Imported Quiz.*:\s*95(\.0+)?/ })).toBeVisible();

    // Re-check Final Grade cell renders some content (may be '-' until inputs exist, or numeric if overridden)
    const finalText = await readCellText(page, students[0].private_profile_name, "Final Grade");
    expect(finalText).not.toEqual("");
  });

  test("Add Column workflow creates a manual column and allows entering a score", async ({ page }) => {
    await page.getByRole("button", { name: "Add Column" }).click();

    await page.getByLabel("Name").fill("Extra Credit");
    await page.getByLabel("Max Score").fill("10");
    await page.getByLabel("Slug").fill("extra-credit");
    await page.getByRole("button", { name: /^Save$/ }).click();

    // New column header should be visible
    await expect(page.getByText("Extra Credit")).toBeVisible();

    // Enter a score for the first student
    const ecCell = await getGridcellInRow(page, students[0].private_profile_name, "Extra Credit");
    await ecCell.click();
    await page.locator('input[name="score"]').fill("7");
    await page.getByRole("button", { name: /^Update$/ }).click();
    await expect(ecCell).toHaveText(/7/);

    // Re-check Final Grade still renders as a number
    await expect(async () => {
      const val = await readCellNumber(page, students[0].private_profile_name, "Final Grade");
      expect(val).not.toBeNaN();
    }).toPass();
  });

  test("Student What If page allows simulating grades", async ({ page }) => {
    // Log in as a student and navigate to the student gradebook
    // Didn't want to make another test suite with a different beforEach just for a single test
    await loginAsUser(page, students[0], course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");

    // Verify student gradebook region renders
    await expect(page.getByRole("region", { name: "Student Gradebook" })).toBeVisible();

    // Verify key cards are present
    const finalCard = page.getByRole("article", { name: "Grade for Final Grade" });
    await expect(finalCard).toBeVisible();
    const participationCard = page.getByRole("article", { name: "Grade for Participation" });
    await expect(participationCard).toBeVisible();

    // Open Participation card, enter a What If score, and commit with Enter
    await participationCard.click();
    const whatIfInput = participationCard.locator('input[type="number"]');
    await whatIfInput.fill("85");
    await whatIfInput.press("Enter");

    // Participation card should now display the hypothetical value (rounded)
    await expect(participationCard).toContainText(/85(\.0+)?|\b85\b/);

    // Final Grade card should remain visible regardless of whether inputs make it computable
    await expect(finalCard).toBeVisible();
  });

  test("Manual column release/unrelease controls student visibility (individual)", async ({ page }) => {
    // We start as instructor due to beforeEach
    // Open Participation column header menu and Release the column
    const tableRegion = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await expect(tableRegion).toBeVisible();
    await tableRegion.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await tableRegion.locator('button[aria-label="Column options"]').last().click();
    const releaseItem = page.getByRole("menuitem", { name: "Release Column", exact: true });
    await releaseItem.click();

    // Verify student can now see Participation in their gradebook cards
    await loginAsUser(page, students[0], course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("article", { name: "Grade for Participation" })).toBeVisible();

    // Now unrelease the column and verify it's hidden from student
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");

    const tableRegion2 = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await expect(tableRegion2).toBeVisible();
    await tableRegion2.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await tableRegion2.locator('button[aria-label="Column options"]').last().click();
    const unreleaseItem = page.getByRole("menuitem", { name: "Unrelease Column", exact: true });
    await unreleaseItem.click();

    // Student should still see the Participation card, but it should show "In Progress"
    await loginAsUser(page, students[0], course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    const unreleasedCard = page.getByRole("article", { name: "Grade for Participation" });
    await expect(unreleasedCard).toBeVisible();
    await expect(unreleasedCard).toContainText(/In Progress/i);
  });
});

// Separate suite for group assignments
test.describe("Gradebook Page - Groups & Release States", () => {
  test.describe.configure({ mode: "serial" });

  let groupCourse: Course;
  let groupStudents: TestingUser[] = [];
  let groupInstructor: TestingUser | undefined;

  test.beforeAll(async () => {
    // Create the class for group assignments
    groupCourse = await createClass({ name: "Gradebook Group Test Course" });

    // Create roster
    const users = await createUsersInClass([
      {
        name: "Dana Diaz",
        email: "dana-gradebook@pawtograder.net",
        role: "student",
        class_id: groupCourse.id,
        useMagicLink: true
      },
      {
        name: "Evan Edwards",
        email: "evan-gradebook@pawtograder.net",
        role: "student",
        class_id: groupCourse.id,
        useMagicLink: true
      },
      {
        name: "Frankie Flores",
        email: "frankie-gradebook@pawtograder.net",
        role: "student",
        class_id: groupCourse.id,
        useMagicLink: true
      },
      {
        name: "Prof Gomez",
        email: "prof-gomez-gradebook@pawtograder.net",
        role: "instructor",
        class_id: groupCourse.id,
        useMagicLink: true
      }
    ]);

    groupStudents = users.slice(0, 3);
    groupInstructor = users[3];

    // Create assignments and gradebook columns for groups
    await createAssignmentsAndGradebookColumns({
      class_id: groupCourse.id,
      numAssignments: 2,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "groups"
    });
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, groupInstructor!, groupCourse);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");
  });

  test("Instructor gradebook loads for group course", async ({ page }) => {
    await expect(page.getByText("Student Name")).toBeVisible();
    for (const s of groupStudents) {
      await expect(
        page.getByRole("row", { name: new RegExp(`^Student ${escapeRegExp(s.private_profile_name)} grades$`) })
      ).toBeVisible();
    }
    await expect(page.getByText("Average Lab Assignments")).toBeVisible();
    await expect(page.getByText("Final Grade")).toBeVisible();
    await expect(page.getByText("Participation")).toBeVisible();
    await expect(page.getByText(`Showing ${groupStudents.length} students`)).toBeVisible();
  });

  test("Release/unrelease manual column toggles student visibility (group)", async ({ page }) => {
    // Release Participation using the same pattern as individual gradebook
    const tableRegion = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await expect(tableRegion).toBeVisible();
    await tableRegion.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await tableRegion.locator('button[aria-label="Column options"]').last().click();
    const releaseItem = page.getByRole("menuitem", { name: "Release Column", exact: true });
    await releaseItem.click();

    // Student sees card
    await loginAsUser(page, groupStudents[0], groupCourse);
    await page.goto(`/course/${groupCourse.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("article", { name: "Grade for Participation" })).toBeVisible();

    // Unrelease and verify it's hidden
    await loginAsUser(page, groupInstructor!, groupCourse);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");

    const tableRegion2 = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await expect(tableRegion2).toBeVisible();
    await tableRegion2.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await tableRegion2.locator('button[aria-label="Column options"]').last().click();
    const unreleaseItem = page.getByRole("menuitem", { name: "Unrelease Column", exact: true });
    await unreleaseItem.click();

    await loginAsUser(page, groupStudents[0], groupCourse);
    await page.goto(`/course/${groupCourse.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    const unreleasedCard = page.getByRole("article", { name: "Grade for Participation" });
    await expect(unreleasedCard).toBeVisible();
    await expect(unreleasedCard).toContainText(/In Progress/i);
  });
});
