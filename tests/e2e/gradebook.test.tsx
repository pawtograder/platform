import { resolveTargetStudentProfileIdForRubricComment } from "@/lib/rubricCommentTargetStudentProfileId";
import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import type { Page, Locator } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import { promises as fs } from "node:fs";
import Papa from "papaparse";
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
const RENDER_EXPORT_COLUMN_NAME = "Final Grade (Letter)";
const RENDER_EXPORT_COLUMN_SLUG = "rendered-final-grade-letter";

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

function parseCsv(csvText: string) {
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: true
  });
  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0];
    throw new Error(`Failed to parse CSV: ${firstError.message}`);
  }
  return parsed.data.map((row) => row.map((cell) => cell ?? ""));
}

function getCsvCellValue(csvRows: string[][], email: string, columnName: string) {
  if (!Array.isArray(csvRows) || csvRows.length === 0) {
    throw new Error("CSV parsing returned no rows");
  }
  const [headers, ...dataRows] = csvRows;
  const emailIndex = headers.indexOf("Email");
  const columnIndex = headers.indexOf(columnName);
  if (emailIndex === -1 || columnIndex === -1) {
    throw new Error(`Could not find Email or ${columnName} column in CSV headers`);
  }
  const studentRow = dataRows.find((row) => row[emailIndex] === email);
  if (!studentRow) {
    throw new Error(`Could not find CSV row for ${email}`);
  }
  return studentRow[columnIndex] ?? "";
}

async function downloadCsvFromGradebookPopover(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error("Download path not available");
  }
  return fs.readFile(downloadPath, "utf8");
}

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

async function getGradebookDataHeaderTitles(page: Page): Promise<string[]> {
  const region = page.getByRole("region", { name: "Instructor Gradebook Table" });
  await region.evaluate((el) => {
    el.scrollLeft = 0;
  });
  // Wait for virtualizer to re-render after scroll position change
  await waitForVirtualizerIdle(page);
  const dataRow = region.locator("thead tr").filter({ has: page.locator("th").filter({ hasText: "Student Name" }) });
  await dataRow.first().waitFor({ state: "visible" });
  // Scrollable gradebook columns are rendered as positioned <div role="columnheader">
  // elements inside a single <th>, not as separate <th> elements. Use [data-col-id] to
  // find all actual column headers (both frozen <th> and inner scrollable <div>).
  const cells = dataRow.locator("[data-col-id]");
  const n = await cells.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await cells.nth(i).innerText()).split("\n")[0].trim());
  }
  return out;
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
test.setTimeout(240_000);
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

    const check0Id = assignments[0].rubricChecks.find((check) => check.is_annotation)?.id;
    const check1Id = assignments[1].rubricChecks.find((check) => check.is_annotation)?.id;
    const target1 =
      check0Id != null
        ? await resolveTargetStudentProfileIdForRubricComment(supabase, submission1.submission_id, check0Id)
        : null;
    const target2 =
      check1Id != null
        ? await resolveTargetStudentProfileIdForRubricComment(supabase, submission2.submission_id, check1Id)
        : null;
    const { error: submissionComment1Error } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission1.submission_id,
        class_id: course.id,
        author: instructor!.private_profile_id,
        comment: "Good work on this aspect!",
        submission_review_id: submission1.grading_review_id,
        rubric_check_id: check0Id,
        points: 90,
        target_student_profile_id: target1
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
        rubric_check_id: check1Id,
        points: 80,
        target_student_profile_id: target2
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
        rubric_id: codeWalkRubric.data!.id,
        assignment_id: assignments[0].id
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
        rubric_id: codeWalkRubric.data!.id,
        assignment_id: assignments[0].id
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
        rubric_criteria_id: codeWalkCriteria.data!.id,
        assignment_id: assignments[0].id,
        rubric_id: codeWalkRubric.data!.id
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
    const codeWalkTarget = await resolveTargetStudentProfileIdForRubricComment(
      supabase,
      submission1.submission_id,
      codeWalkCheck.data!.id
    );
    const submissionCodeWalkComment = await supabase.from("submission_comments").insert({
      submission_id: submission1.submission_id,
      class_id: course.id,
      author: instructor!.private_profile_id,
      comment: "Good work on this aspect!",
      rubric_check_id: codeWalkCheck.data!.id,
      points: 90,
      submission_review_id: submissionCodeWalkReview.data!.id,
      target_student_profile_id: codeWalkTarget
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
    const { data: gradebookColumn, error: gradebookColumnError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", "assignment-assignment-1-code-walk")
      .single();
    if (gradebookColumnError) {
      throw new Error(`Failed to get gradebook column: ${gradebookColumnError.message}`);
    }

    //Wait for gradebook to finish updating with the assignment code walk grades before starting the test
    await expect(async () => {
      const { data, error } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", course.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("gradebook_column_id", gradebookColumn!.id)
        .eq("is_private", true)
        .single();
      if (error) {
        console.log(`Error getting gradebook column student data: ${error.message}`);
        throw new Error(`Failed to get gradebook column student data: ${error.message}`);
      }
      expect(data?.score).toBe(90);
    }).toPass();

    // Wait for the average-assignments column's dependencies to include the code walk column.
    // The gradebook-column-inserted edge function updates dependencies asynchronously when a
    // new column (like the code walk column) is created. Without this wait, there is a race:
    // the code walk score may be set before dependencies are updated, so the dependent
    // average-assignments column never gets recalculated with the code walk included.
    await expect(async () => {
      const { data: avgCol, error: avgColError } = await supabase
        .from("gradebook_columns")
        .select("dependencies")
        .eq("class_id", course.id)
        .eq("slug", "average-assignments")
        .single();
      if (avgColError) {
        throw new Error(`Failed to get average-assignments column: ${avgColError.message}`);
      }
      const deps = avgCol?.dependencies as { gradebook_columns?: number[] } | null;
      expect(deps?.gradebook_columns).toContain(gradebookColumn!.id);
    }).toPass();

    // The gradebook-column-inserted edge function now enqueues recalculation
    // after updating dependencies, so the average-assignments and final-grade
    // columns will be recalculated automatically. Just wait for the result.

    //ALSO check for the final grade
    const { data: finalGradebookColumn, error: finalGradebookColumnError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", "final-grade")
      .single();
    if (finalGradebookColumnError) {
      throw new Error(`Failed to get final gradebook column: ${finalGradebookColumnError.message}`);
    }

    //Wait for gradebook to finish updating with the final grade
    await expect(async () => {
      const { data: privateRecord, error: privateError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", course.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("gradebook_column_id", finalGradebookColumn!.id)
        .eq("is_private", true)
        .single();
      if (privateError) {
        throw new Error(`Failed to get private gradebook column student data: ${privateError.message}`);
      }
      expect(privateRecord?.score).toBe(51.95);

      // Verify that is_private=false record matches is_private=true record for calculated columns
      const { data: publicRecord, error: publicError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", course.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("gradebook_column_id", finalGradebookColumn!.id)
        .eq("is_private", false)
        .single();
      if (publicError) {
        throw new Error(`Failed to get public gradebook column student data: ${publicError.message}`);
      }
      // Not all dependencies are released, so the public score is different
      expect(publicRecord?.score).toBe(43.5);
      expect(publicRecord?.score_override).toBe(privateRecord?.score_override);
      expect(publicRecord?.is_missing).toBe(privateRecord?.is_missing);
      expect(publicRecord?.is_droppable).toBe(privateRecord?.is_droppable);
      expect(publicRecord?.is_excused).toBe(privateRecord?.is_excused);
    }).toPass();
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

  test("Issue #533: instructor can enter a decimal score in a manual gradebook cell", async ({ page }) => {
    const studentName = students[0].private_profile_name;
    await waitForVirtualizerIdle(page);
    const getPartCell = () => getGridcellInRow(page, studentName, "Participation");
    const partCell = await waitForStableLocator(page, getPartCell);
    await partCell.click();
    const scoreInput = page.locator('input[name="score"]');
    await scoreInput.fill("50.5");
    await expect(scoreInput).toHaveValue("50.5");
    await page.getByRole("button", { name: /^Update$/ }).click();
    await expect(partCell).toHaveText(/50\.5/);

    // Restore original value so subsequent serial tests see the expected score
    await partCell.click();
    await scoreInput.fill("84.5");
    await page.getByRole("button", { name: /^Update$/ }).click();
    await expect(partCell).toHaveText(/84\.5/);
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

    // Expand assignment groups and scroll right to reveal virtualized columns
    const tableRegion = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await tableRegion.getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);
    await tableRegion.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await waitForVirtualizerIdle(page);

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
      expect(after).toBe(51.95);
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
      expect(after).toBe(51.5);
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
    await page.getByRole("button", { name: /^Override$/ }).click();

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
    const importedQuizHeaders = page.getByText(/Imported Quiz/);
    await expect(importedQuizHeaders.first()).toBeVisible();

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

    await waitForVirtualizerIdle(page);
    await page.waitForTimeout(3000);

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

    // Verify that is_private=false records update to match is_private=true records after release
    const { data: participationColumnForSync, error: participationColumnForSyncError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", "participation")
      .single();
    if (participationColumnForSyncError) {
      throw new Error(`Failed to get participation column: ${participationColumnForSyncError.message}`);
    }

    await expect(async () => {
      for (const student of students) {
        const { data: privateRecord, error: privateError } = await supabase
          .from("gradebook_column_students")
          .select("*")
          .eq("class_id", course.id)
          .eq("student_id", student.private_profile_id)
          .eq("gradebook_column_id", participationColumnForSync.id)
          .eq("is_private", true)
          .single();
        if (privateError) {
          throw new Error(`Failed to get private gradebook column student: ${privateError.message}`);
        }

        const { data: publicRecord, error: publicError } = await supabase
          .from("gradebook_column_students")
          .select("*")
          .eq("class_id", course.id)
          .eq("student_id", student.private_profile_id)
          .eq("gradebook_column_id", participationColumnForSync.id)
          .eq("is_private", false)
          .single();
        if (publicError) {
          throw new Error(`Failed to get public gradebook column student: ${publicError.message}`);
        }

        // Check that public record matches private record after release
        const expectedScore = privateRecord?.score_override ?? privateRecord?.score;
        expect(publicRecord?.score).toBe(expectedScore);
        expect(publicRecord?.is_missing).toBe(privateRecord?.is_missing);
        expect(publicRecord?.is_droppable).toBe(privateRecord?.is_droppable);
        expect(publicRecord?.is_excused).toBe(privateRecord?.is_excused);
        expect(publicRecord?.released).toBe(true);
      }
    }).toPass();

    const { data: finalGradebookColumn, error: finalGradebookColumnError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", "final-grade")
      .single();
    if (finalGradebookColumnError) {
      throw new Error(`Failed to get final gradebook column: ${finalGradebookColumnError.message}`);
    }

    // Wait for grade to be updated in database
    await expect(async () => {
      const { data: finalGradebookColumnStudent, error: finalGradebookColumnStudentError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", course.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("gradebook_column_id", finalGradebookColumn!.id)
        .eq("is_private", false)
        .single();
      if (finalGradebookColumnStudentError) {
        throw new Error(`Failed to get final gradebook column student: ${finalGradebookColumnStudentError.message}`);
      }
      expect(finalGradebookColumnStudent?.score).toBe(90.8);
    }).toPass();

    // Verify student can now see Participation in their gradebook cards
    await loginAsUser(page, students[0], course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("article", { name: "Grade for Participation" })).toBeVisible();
    // Validate that the final grade shown is correctly calcualted
    await expect(page.getByText(`Final Grade90.8`)).toBeVisible({ timeout: 70_000 });

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
    //Wait for the column to unrelease
    const { data: participationColumn, error: participationColumnError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", "participation")
      .single();
    if (participationColumnError) {
      throw new Error(`Failed to get participation column: ${participationColumnError.message}`);
    }
    await expect(async () => {
      const { data, error: gradebookColumnStudentError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", course.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("gradebook_column_id", participationColumn.id)
        .eq("is_private", true)
        .single();
      if (gradebookColumnStudentError) {
        throw new Error(`Failed to get gradebook column student: ${gradebookColumnStudentError.message}`);
      }
      expect(data?.released).toBe(false);
    }).toPass();

    // Student should still see the Participation card, but it should show "In Progress"
    await loginAsUser(page, students[0], course);
    await page.goto(`/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    const unreleasedCard = page.getByRole("article", { name: "Grade for Participation" });
    await expect(unreleasedCard).toBeVisible();
    await expect(unreleasedCard).toContainText(/In Progress/i);
  });
});

test.describe("Gradebook Page - CSV Render Export", () => {
  test.describe.configure({ mode: "serial" });
  let exportCourse: Course;
  let exportStudents: TestingUser[] = [];
  let exportInstructor: TestingUser;

  test.beforeAll(async () => {
    exportCourse = await createClass({
      name: "Gradebook Export Render Expression Course"
    });
    const exportEmailSuffix = `${process.env.TEST_PARALLEL_INDEX || "0"}-${Math.random().toString(36).slice(2, 8)}`;
    const users = await createUsersInClass([
      {
        name: "Export Student One",
        email: `export-student-one-${exportEmailSuffix}@pawtograder.net`,
        role: "student",
        class_id: exportCourse.id
      },
      {
        name: "Export Student Two",
        email: `export-student-two-${exportEmailSuffix}@pawtograder.net`,
        role: "student",
        class_id: exportCourse.id
      },
      {
        name: "Export Instructor",
        email: `export-instructor-${exportEmailSuffix}@pawtograder.net`,
        role: "instructor",
        class_id: exportCourse.id
      }
    ]);
    exportStudents = users.slice(0, 2);
    exportInstructor = users[2];

    await createAssignmentsAndGradebookColumns({
      class_id: exportCourse.id,
      numAssignments: 2,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "individual"
    });

    const { data: finalGradebookColumn, error: finalGradebookColumnError } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", exportCourse.id)
      .eq("slug", "final-grade")
      .single();
    if (finalGradebookColumnError) {
      throw new Error(`Failed to get final gradebook column for export test: ${finalGradebookColumnError.message}`);
    }

    await expect(async () => {
      const { data: privateRecord, error: privateError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", exportCourse.id)
        .eq("student_id", exportStudents[0].private_profile_id)
        .eq("gradebook_column_id", finalGradebookColumn.id)
        .eq("is_private", true)
        .single();
      if (privateError) {
        throw new Error(`Failed to get private final grade record for export test: ${privateError.message}`);
      }
      expect(privateRecord).toBeTruthy();
    }).toPass();

    const { error: setFinalGradePrivateError } = await supabase
      .from("gradebook_column_students")
      .update({ score_override: 92, is_recalculating: false })
      .eq("class_id", exportCourse.id)
      .eq("student_id", exportStudents[0].private_profile_id)
      .eq("gradebook_column_id", finalGradebookColumn.id)
      .eq("is_private", true);
    if (setFinalGradePrivateError) {
      throw new Error(`Failed to set private final grade for export test: ${setFinalGradePrivateError.message}`);
    }
    const { error: setFinalGradePublicError } = await supabase
      .from("gradebook_column_students")
      .update({ score_override: 88, is_recalculating: false })
      .eq("class_id", exportCourse.id)
      .eq("student_id", exportStudents[0].private_profile_id)
      .eq("gradebook_column_id", finalGradebookColumn.id)
      .eq("is_private", false);
    if (setFinalGradePublicError) {
      throw new Error(`Failed to set public final grade for export test: ${setFinalGradePublicError.message}`);
    }

    const { data: renderExportColumn, error: renderExportColumnError } = await supabase
      .from("gradebook_columns")
      .insert({
        class_id: exportCourse.id,
        gradebook_id: finalGradebookColumn.gradebook_id,
        name: RENDER_EXPORT_COLUMN_NAME,
        slug: RENDER_EXPORT_COLUMN_SLUG,
        max_score: 100,
        score_expression: "gradebook_columns('final-grade')",
        render_expression: "letter(score)",
        dependencies: { gradebook_columns: [finalGradebookColumn.id] },
        sort_order: (finalGradebookColumn.sort_order ?? 0) + 1
      })
      .select("*")
      .single();
    if (renderExportColumnError) {
      throw new Error(`Failed to create render export column for export test: ${renderExportColumnError.message}`);
    }

    await expect(async () => {
      const { data: renderRecord, error: renderError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", exportCourse.id)
        .eq("student_id", exportStudents[0].private_profile_id)
        .eq("gradebook_column_id", renderExportColumn.id)
        .eq("is_private", true)
        .single();
      if (renderError) {
        throw new Error(`Failed to get render export column record for export test: ${renderError.message}`);
      }
      expect(renderRecord).toBeTruthy();
    }).toPass();

    const { error: setRenderExportScoreError } = await supabase
      .from("gradebook_column_students")
      .update({ score_override: 92, released: true, is_recalculating: false })
      .eq("class_id", exportCourse.id)
      .eq("student_id", exportStudents[0].private_profile_id)
      .eq("gradebook_column_id", renderExportColumn.id)
      .eq("is_private", true);
    if (setRenderExportScoreError) {
      throw new Error(`Failed to set render export score for export test: ${setRenderExportScoreError.message}`);
    }

    await expect(async () => {
      const { data: renderRecord, error: renderError } = await supabase
        .from("gradebook_column_students")
        .select("*")
        .eq("class_id", exportCourse.id)
        .eq("student_id", exportStudents[0].private_profile_id)
        .eq("gradebook_column_id", renderExportColumn.id)
        .eq("is_private", true)
        .single();
      if (renderError) {
        throw new Error(`Failed to read stabilized render export record: ${renderError.message}`);
      }
      expect(renderRecord?.is_recalculating).toBe(false);
      expect(renderRecord?.score_override ?? renderRecord?.score).toBe(92);
      expect(renderRecord?.incomplete_values).toBeNull();
    }).toPass();
  });

  test("Download Gradebook can export render expression values to CSV", async ({ page }) => {
    const student = exportStudents[0];
    await loginAsUser(page, exportInstructor, exportCourse);
    await page.goto(`/course/${exportCourse.id}/manage/gradebook`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("region", { name: "Instructor Gradebook Table" })).toBeVisible();

    const tableRegion = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await tableRegion.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await waitForVirtualizerIdle(page);

    const renderedCell = await getGridcellInRow(page, student.private_profile_name, RENDER_EXPORT_COLUMN_NAME);
    await expect(renderedCell).toHaveAttribute(
      "aria-label",
      new RegExp(`^Grade cell for ${escapeRegExp(RENDER_EXPORT_COLUMN_NAME)}: A-$`)
    );

    await page.getByRole("button", { name: "Download Gradebook" }).click();
    const renderExpressionCheckbox = page.getByRole("checkbox", { name: "Use render expressions in CSV" });
    await expect(renderExpressionCheckbox).toBeVisible();
    await expect(renderExpressionCheckbox).not.toBeChecked();
    const defaultCsv = await downloadCsvFromGradebookPopover(page);
    const defaultCsvRows = parseCsv(defaultCsv);
    const defaultValue = getCsvCellValue(defaultCsvRows, student.email, RENDER_EXPORT_COLUMN_NAME);
    expect(Number(defaultValue)).toBeCloseTo(92, 5);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Download Gradebook" }).click();
    await expect(renderExpressionCheckbox).toBeVisible();
    const renderExpressionToggle = page.getByText("Use render expressions in CSV");
    if (!(await renderExpressionCheckbox.isChecked())) {
      await renderExpressionToggle.click();
    }
    await expect(renderExpressionCheckbox).toBeChecked();
    const renderCsv = await downloadCsvFromGradebookPopover(page);
    const renderCsvRows = parseCsv(renderCsv);
    const renderedValue = getCsvCellValue(renderCsvRows, student.email, RENDER_EXPORT_COLUMN_NAME);
    expect(renderedValue).toBe("A-");
  });
});

/**
 * Issue #531: column reorder UI + RPC. Kept separate from "Comprehensive" so CI does not inherit
 * that suite's beforeAll (submissions, code walk, waits on background gradebook recalculation),
 * which can exceed timeouts on webkit when the pipeline is slow.
 */
test.describe("Gradebook column reorder (issue #531)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let reorderCourse: Course;
  let reorderInstructor: TestingUser;

  test.beforeAll(async () => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    reorderCourse = await createClass({
      name: `Gradebook Reorder E2E ${id}`
    });

    const users = await createUsersInClass([
      {
        name: "Reorder Student",
        email: `reorder-student-${id}@pawtograder.net`,
        role: "student",
        class_id: reorderCourse.id,
        useMagicLink: true
      },
      {
        name: "Reorder Instructor",
        email: `reorder-instructor-${id}@pawtograder.net`,
        role: "instructor",
        class_id: reorderCourse.id,
        useMagicLink: true
      }
    ]);

    reorderInstructor = users[1];

    await createAssignmentsAndGradebookColumns({
      class_id: reorderCourse.id,
      numAssignments: 4,
      numManualGradedColumns: 0,
      manualGradedColumnSlugs: ["participation"],
      groupConfig: "both"
    });
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, reorderInstructor, reorderCourse);
    const navRegion = page.locator("#course-nav");
    await navRegion
      .getByRole("link")
      .filter({ hasText: /^Gradebook$/ })
      .click();
    await page.waitForLoadState("networkidle");
    await waitForVirtualizerIdle(page);
  });

  test("Move Left / Move Right reorder assignment columns in the instructor gradebook", async ({ page }) => {
    const region = page.getByRole("region", { name: "Instructor Gradebook Table" });
    await waitForVirtualizerIdle(page);

    await region.getByRole("button", { name: "Expand all groups" }).click();
    await waitForVirtualizerIdle(page);

    const colName = "Test Assignment 4 (Group)";
    const headersBefore = await getGradebookDataHeaderTitles(page);
    const beforeIndex = headersBefore.indexOf(colName);
    expect(beforeIndex).toBeGreaterThan(0);

    // Get sort_order from DB before move
    const { data: colBefore } = await supabase
      .from("gradebook_columns")
      .select("id, sort_order")
      .eq("class_id", reorderCourse.id)
      .eq("name", colName)
      .single();
    expect(colBefore).toBeTruthy();
    const sortOrderBefore = colBefore!.sort_order!;

    const headerCell = region
      .locator("thead tr")
      .filter({ has: page.locator("th").filter({ hasText: "Student Name" }) })
      .locator("[data-col-id]")
      .filter({ hasText: colName });
    await headerCell.getByRole("button", { name: "Column options" }).click();
    await page.getByRole("menuitem", { name: "Move Left", exact: true }).click();
    await expect(page.getByText("Column moved left").first()).toBeVisible();

    // Verify sort_order decreased by 1 in the database
    await expect(async () => {
      const { data: colAfterLeft } = await supabase
        .from("gradebook_columns")
        .select("sort_order")
        .eq("id", colBefore!.id)
        .single();
      expect(colAfterLeft!.sort_order).toBe(sortOrderBefore - 1);
    }).toPass({ timeout: 5000 });

    await waitForVirtualizerIdle(page);

    await headerCell.getByRole("button", { name: "Column options" }).click();
    await page.getByRole("menuitem", { name: "Move Right", exact: true }).click();
    await expect(page.getByText("Column moved right").first()).toBeVisible();

    // Verify sort_order restored to original
    await expect(async () => {
      const { data: colRestored } = await supabase
        .from("gradebook_columns")
        .select("sort_order")
        .eq("id", colBefore!.id)
        .single();
      expect(colRestored!.sort_order).toBe(sortOrderBefore);
    }).toPass({ timeout: 5000 });

  });
});
