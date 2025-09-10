import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import type { Page, Locator } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  loginAsUser,
  TestingUser,
  createAssignmentsAndGradebookColumns,
  insertPreBakedSubmission,
  supabase
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

// async function readCellText(page: Page, rowName: string, columnName: string) {
//   const cell = await getGridcellInRow(page, rowName, columnName);
//   return (await cell.innerText()).trim();
// }

// Virtualization stability helpers
async function waitForVirtualizerIdle(page: Page) {
  await page.waitForFunction(
    () => {
      const container = document.querySelector(
        '[role="region"][aria-label="Instructor Gradebook Table"]'
      ) as HTMLElement | null;
      if (!container) return false;
      const body = container.querySelector("tbody");
      if (!body) return false;
      const rows = Array.from(body.querySelectorAll('[role="row"]')) as HTMLElement[];
      if (rows.length === 0) return false;

      const sig = [
        container.scrollTop,
        container.scrollLeft,
        ...rows.map((r) => `${r.style.transform}:${r.style.height}`)
      ].join("|");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__virtSig === sig) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__virtSig = sig;
      return false;
    },
    { polling: "raf", timeout: 2000 }
  );
}

async function waitForStableLocator(page: Page, getLocator: () => Promise<Locator> | Locator, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    try {
      const loc = await getLocator();
      await loc.waitFor({ state: "visible", timeout: 250 });
      try {
        await loc.scrollIntoViewIfNeeded();
      } catch {
        // Element may have remounted between wait and scroll; retry
        await waitForVirtualizerIdle(page);
        continue;
      }
      const box1 = await loc.boundingBox();
      if (!box1) {
        await page.waitForTimeout(50);
        continue;
      }
      await page.waitForTimeout(75);
      const loc2 = await getLocator();
      await loc2.waitFor({ state: "visible", timeout: 250 });
      const box2 = await loc2.boundingBox();
      if (!box2) continue;
      const same =
        Math.abs(box1.x - box2.x) < 1 &&
        Math.abs(box1.y - box2.y) < 1 &&
        Math.abs(box1.width - box2.width) < 1 &&
        Math.abs(box1.height - box2.height) < 1;
      if (same) return loc2;
    } catch (/* eslint-disable-line @typescript-eslint/no-unused-vars */ _e) {
      // Locator may be detached; small backoff and retry
    }
    await waitForVirtualizerIdle(page);
  }
  throw new Error("Timed out waiting for stable locator box");
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
    const { assignments } = await createAssignmentsAndGradebookColumns({
      class_id: course.id,
      numAssignments: 4,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "both"
    });
    //Add an individual submission for first assignment
    const submission1 = await insertPreBakedSubmission({
      student_profile_id: students[0].private_profile_id,
      assignment_id: assignments[0].id,
      class_id: course.id
    });
    //Add a group submission for second assignment
    const assignmentGroup = await supabase
      .from("assignment_groups")
      .insert({
        assignment_id: assignments[1].id,
        class_id: course.id,
        name: "E2ETestGroup"
      })
      .select("id")
      .single();
    if (assignmentGroup.error) {
      throw new Error(`Failed to create assignment group: ${assignmentGroup.error.message}`);
    }
    const assignmentGroupMember = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: assignmentGroup.data!.id,
      profile_id: students[0].private_profile_id,
      assignment_id: assignments[1].id,
      class_id: course.id,
      added_by: instructor!.private_profile_id
    });
    if (assignmentGroupMember.error) {
      throw new Error(`Failed to create assignment group member: ${assignmentGroupMember.error.message}`);
    }
    const assignmentGroupMember2 = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: assignmentGroup.data!.id,
      profile_id: students[1].private_profile_id,
      assignment_id: assignments[1].id,
      class_id: course.id,
      added_by: instructor!.private_profile_id
    });
    if (assignmentGroupMember2.error) {
      throw new Error(`Failed to create assignment group member: ${assignmentGroupMember2.error.message}`);
    }
    //Add a submission for the group
    const submission2 = await insertPreBakedSubmission({
      assignment_group_id: assignmentGroup.data!.id,
      assignment_id: assignments[1].id,
      class_id: course.id
    });

    const { error: submissionComment1Error } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission1.submission_id,
        class_id: course.id,
        author: instructor!.private_profile_id,
        comment: "Good work on this aspect!",
        submission_review_id: submission1.grading_review_id,
        rubric_check_id: assignments[0].rubricChecks.find((check) => check.is_annotation)?.id,
        points: 90
      })
      .select("id");
    const { error: submissionComment2Error } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission2.submission_id,
        class_id: course.id,
        author: instructor!.private_profile_id,
        comment: "Good work on this aspect!",
        submission_review_id: submission2.grading_review_id,
        rubric_check_id: assignments[1].rubricChecks.find((check) => check.is_annotation)?.id,
        points: 80
      })
      .select("id");
    if (submissionComment1Error || submissionComment2Error) {
      throw new Error(
        `Failed to create submission comments: ${submissionComment1Error?.message || submissionComment2Error?.message}`
      );
    }

    // Release submission review for assignment 1 and 2 only
    await supabase.from("submission_reviews").update({ released: true }).eq("id", submission1.grading_review_id);
    await supabase.from("submission_reviews").update({ released: true }).eq("id", submission2.grading_review_id);

    // Add a code walk for assignment 1
    const codeWalkRubric = await supabase
      .from("rubrics")
      .insert({
        assignment_id: assignments[0].id,
        class_id: course.id,
        name: "Code Walk",
        review_round: "code-walk"
      })
      .select("id")
      .single();
    if (codeWalkRubric.error) {
      throw new Error(`Failed to create code walk: ${codeWalkRubric.error.message}`);
    }
    // Populate with a single rubric part, criteria and check
    const codeWalkPart = await supabase
      .from("rubric_parts")
      .insert({
        class_id: course.id,
        name: "Code Walk",
        description: "Code Walk",
        ordinal: 0,
        rubric_id: codeWalkRubric.data!.id
      })
      .select("id")
      .single();
    if (codeWalkPart.error) {
      throw new Error(`Failed to create code walk part: ${codeWalkPart.error.message}`);
    }
    // Populate with a single rubric part, criteria and check
    const codeWalkCriteria = await supabase
      .from("rubric_criteria")
      .insert({
        class_id: course.id,
        name: "Code Walk",
        description: "Code Walk",
        ordinal: 0,
        total_points: 90,
        is_additive: true,
        rubric_part_id: codeWalkPart.data!.id,
        rubric_id: codeWalkRubric.data!.id
      })
      .select("id")
      .single();
    if (codeWalkCriteria.error) {
      throw new Error(`Failed to create code walk criteria: ${codeWalkCriteria.error.message}`);
    }
    // Populate with a single rubric part, criteria and check
    const codeWalkCheck = await supabase
      .from("rubric_checks")
      .insert({
        class_id: course.id,
        name: "Code Walk",
        description: "Code Walk",
        ordinal: 0,
        points: 90,
        is_annotation: false,
        is_comment_required: false,
        is_required: true,
        rubric_criteria_id: codeWalkCriteria.data!.id
      })
      .select("id")
      .single();
    if (codeWalkCheck.error) {
      throw new Error(`Failed to create code walk check: ${codeWalkCheck.error.message}`);
    }
    const submissionCodeWalkReview = await supabase
      .from("submission_reviews")
      .select("id")
      .eq("submission_id", submission1.submission_id)
      .eq("rubric_id", codeWalkRubric.data!.id)
      .single();
    if (submissionCodeWalkReview.error) {
      throw new Error(`Failed to create code walk review: ${submissionCodeWalkReview.error.message}`);
    }
    //Throw in a quick review for the code walk on submission 1
    const submissionCodeWalkComment = await supabase.from("submission_comments").insert({
      submission_id: submission1.submission_id,
      class_id: course.id,
      author: instructor!.private_profile_id,
      comment: "Good work on this aspect!",
      rubric_check_id: codeWalkCheck.data!.id,
      points: 90,
      submission_review_id: submissionCodeWalkReview.data!.id
    });
    if (submissionCodeWalkComment.error) {
      throw new Error(`Failed to create code walk comment: ${submissionCodeWalkComment.error.message}`);
    }
    await supabase
      .from("submission_reviews")
      .update({
        released: true
      })
      .eq("id", submissionCodeWalkReview.data!.id);
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");
    await waitForVirtualizerIdle(page);
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
    await expect(page.getByText("Average Assignments")).toBeVisible();

    // Verify manual grading columns
    await expect(page.getByText("Participation")).toBeVisible();

    // Check calculated columns (avoid relying on hidden/virtualized headers)
    await expect(page.getByText("Final Grade")).toBeVisible();

    // Verify student count
    await expect(page.getByText(`Showing ${students.length} students`)).toBeVisible();

    // Check action buttons
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import Column" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Column" })).toBeVisible();

    // Check that Student 1's assignments are showing grades, final grade is calculated
    await expect(async () => {
      const after = await readCellNumber(page, students[0].private_profile_name, "Test Assignment 1 (Group)");
      expect(after).not.toBeNaN();
      expect(after).toBe(25);
    }).toPass();

    await expect(async () => {
      const after = await readCellNumber(page, students[0].private_profile_name, "Test Assignment 2 (Group)");
      expect(after).not.toBeNaN();
      expect(after).toBe(30);
    }).toPass();

    await expect(async () => {
      const after = await readCellNumber(page, students[1].private_profile_name, "Test Assignment 2 (Group)");
      expect(after).not.toBeNaN();
      expect(after).toBe(30);
    }).toPass();

    await expect(async () => {
      const after = await readCellNumber(
        page,
        students[0].private_profile_name,
        "Code Walk: Test Assignment 1 (Group)"
      );
      expect(after).not.toBeNaN();
      expect(after).toBe(90);
    }).toPass();

    await expect(async () => {
      const after = await readCellNumber(page, students[0].private_profile_name, "Participation");
      expect(after).not.toBeNaN();
      expect(after).toBe(84.5);
    }).toPass();

    await expect(async () => {
      const after = await readCellNumber(page, students[0].private_profile_name, "Final Grade");
      expect(after).not.toBeNaN();
      expect(after).toBe(33.2);
    }).toPass();

    // Take screenshot for visual regression testing
    await argosScreenshot(page, "Gradebook Page - Full Data");
  });

  test("Editing a manual column updates the Participation cell value", async ({ page }) => {
    const studentName = students[0].private_profile_name;
    await waitForVirtualizerIdle(page);
    // Open Participation cell and set score to 80
    const getPartCell = () => getGridcellInRow(page, studentName, "Participation");
    const partCell = await waitForStableLocator(page, getPartCell);
    await partCell.click();
    await page.locator('input[name="score"]').fill("80");
    await page.getByRole("button", { name: /^Update$/ }).click();

    // Expect participation cell to show the new value and final grade to change
    await expect(partCell).toHaveText(/80(\.0+)?|80$/);

    await expect(async () => {
      const after = await readCellNumber(page, studentName, "Final Grade");
      expect(after).not.toBeNaN();
      expect(after).toBe(32.75);
    }).toPass();
  });

  test("Overriding a calculated column (Average Assignments) persists and displays the override", async ({ page }) => {
    const studentName = students[0].private_profile_name;
    await waitForVirtualizerIdle(page);
    const before = await readCellNumber(page, studentName, "Average Assignments");

    // Open Average Assignments cell and override
    const getFinalCell = () => getGridcellInRow(page, studentName, "Average Assignments");
    const finalCell = await waitForStableLocator(page, getFinalCell);
    await finalCell.click();
    await page.locator('input[name="score_override"]').fill("92");
    await page.getByRole("button", { name: /^Save Override$/ }).click();

    // Value should update to the override
    await expect(async () => {
      const after = await readCellNumber(page, studentName, "Average Assignments");
      expect(after).not.toBeNaN();
      expect(after).toBe(92);
      expect(after).not.toBe(before);
    }).toPass();

    // Final Grade should update
    await expect(async () => {
      const after = await readCellNumber(page, studentName, "Final Grade");
      expect(after).not.toBeNaN();
      expect(after).toBe(90.8);
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

    // This column is not included in final grade so don't check that it updates
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

    // This column is not included in final grade so don't check that it updates
  });

  // test("Student What If page allows simulating grades and shows released grades", async ({ page }) => {
  //   // Log in as a student and navigate to the student gradebook
  //   // Didn't want to make another test suite with a different beforEach just for a single test
  //   await loginAsUser(page, students[0], course);
  //   await page.goto(`/course/${course.id}/gradebook`);
  //   await page.waitForLoadState("networkidle");

  //   // Verify student gradebook region renders
  //   await expect(page.getByRole("region", { name: "Student Gradebook" })).toBeVisible();

  //   // Verify key cards are present
  //   const finalCard = page.getByRole("article", { name: "Grade for Final Grade" });
  //   await expect(finalCard).toBeVisible();
  //   const participationCard = page.getByRole("article", { name: "Grade for Participation" });
  //   await expect(participationCard).toBeVisible();

  //   // Open Participation card, enter a What If score, and commit with Enter
  //   await participationCard.click();
  //   const whatIfInput = participationCard.locator('input[type="number"]');
  //   await whatIfInput.fill("85");
  //   await whatIfInput.press("Enter");

  //   // Participation card should now display the hypothetical value (rounded)
  //   await expect(participationCard).toContainText(/85(\.0+)?|\b85\b/);

  //   // Final Grade card should remain visible regardless of whether inputs make it computable
  //   await expect(finalCard).toBeVisible();
  // });

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
