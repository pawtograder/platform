import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  loginAsUser,
  TestingUser,
  createAssignmentsAndGradebookColumns,
  insertPreBakedSubmission,
  gradeSubmission,
  createLabSectionWithStudents,
  insertSubmissionViaAPI
} from "./TestingUtils";
import { addDays } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { supabase } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

let course: Course;
let students: TestingUser[] = [];
let tas: TestingUser[] = [];
let instructor: TestingUser | undefined;

type TestAssignment = Assignment & { assignmentType: string; isLab: boolean };
let assignments: TestAssignment[] = [];
// No need to persist created columns here; tests reference by slug via DB

const baseDate = new TZDate(new Date(), "America/New_York");

test.describe("Gradebook Page - Comprehensive", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    // Step 1: Create the class
    course = await createClass({
      name: "Gradebook Test Course"
    });

    // Step 2: Create users - multiple students, TAs, and an instructor
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
        name: "Diana Davis",
        email: "diana-gradebook@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "TA Taylor",
        email: "ta-taylor-gradebook@pawtograder.net",
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "TA Thomas",
        email: "ta-thomas-gradebook@pawtograder.net",
        role: "grader",
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

    students = users.slice(0, 4);
    tas = users.slice(4, 6);
    instructor = users[6];

    // Step 3: Create lab sections with students assigned
    // This simulates the lab structure that affects due dates
    await createLabSectionWithStudents({
      class_id: course.id,
      lab_leader: tas[0],
      day_of_week: "monday",
      students: [students[0], students[1]],
      name: "Lab Section A - Monday"
    });

    await createLabSectionWithStudents({
      class_id: course.id,
      lab_leader: tas[1],
      day_of_week: "wednesday",
      students: [students[2], students[3]],
      name: "Lab Section B - Wednesday"
    });

    // Step 4: Create assignments with varied configurations
    const assignmentConfigs = [
      {
        numAssignments: 3, // Regular individual assignments
        groupConfig: "individual" as const,
        namePrefix: "assignment"
      },
      {
        numAssignments: 2, // Group assignments
        groupConfig: "groups" as const,
        namePrefix: "group"
      },
      {
        numAssignments: 2, // Lab assignments with offset due dates
        groupConfig: "individual" as const,
        namePrefix: "lab",
        isLab: true
      }
    ];

    let allAssignments: TestAssignment[] = [];

    for (const config of assignmentConfigs) {
      const result = await createAssignmentsAndGradebookColumns({
        class_id: course.id,
        numAssignments: config.numAssignments,
        numManualGradedColumns: config === assignmentConfigs[0] ? 2 : 0, // Only create manual columns once
        manualGradedColumnSlugs: ["participation"],
        assignmentDateRange: {
          start: addDays(baseDate, -14),
          end: addDays(baseDate, 14)
        },
        rubricConfig: {
          minPartsPerAssignment: 2,
          maxPartsPerAssignment: 3,
          minCriteriaPerPart: 1,
          maxCriteriaPerPart: 2,
          minChecksPerCriteria: 2,
          maxChecksPerCriteria: 3
        },
        groupConfig: config.groupConfig
      });

      // Map to minimal assignment shape with tags
      const mapped = result.assignments.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        due_date: a.due_date,
        group_config: a.group_config,
        assignmentType: config.namePrefix,
        isLab: config.isLab || false
      })) as TestAssignment[];

      allAssignments = [...allAssignments, ...mapped];
    }

    assignments = allAssignments;

    // Step 5: Create submissions for various assignments
    // This simulates students submitting work
    for (const assignment of assignments) {
      // Determine submission pattern based on assignment type
      let submittingStudents = students;

      // Simulate some students not submitting certain assignments
      if (assignment.assignmentType === "lab") {
        // Lab assignments - most students submit
        submittingStudents = students.slice(0, 3); // Diana didn't submit
      } else if (assignment.assignmentType === "group") {
        // Group assignments - all submit but in groups
        submittingStudents = students;
      }

      for (const student of submittingStudents) {
        try {
          // Create a submission for this student
          const submissionResult = await insertPreBakedSubmission({
            student_profile_id: student.private_profile_id,
            assignment_id: assignment.id,
            class_id: course.id,
            assignment_group_id: assignment.assignmentType === "group" ? 1 : undefined
          });

          // Step 6: Grade the submission with varied scores
          // Simulate different grading patterns
          const baseScore = 70 + Math.floor(Math.random() * 25); // 70-95 range
          const isCompleted = Math.random() > 0.2; // 80% completed

          if (submissionResult.grading_review_id) {
            await gradeSubmission(
              submissionResult.grading_review_id,
              tas[Math.floor(Math.random() * tas.length)].private_profile_id, // Random TA grades
              isCompleted,
              {
                checkApplyChance: 0.8, // 80% chance to apply non-required checks
                totalScoreOverride: isCompleted ? baseScore : 0,
                totalAutogradeScoreOverride: Math.floor(baseScore * 0.6), // Autograder is 60% of total
                pointsRandomizer: () => Math.random() * 0.8 + 0.2, // 20-100% of points
                fileSelectionRandomizer: () => Math.random(),
                lineNumberRandomizer: () => Math.random()
              }
            );
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`Failed to create/grade submission for ${student.email} on ${assignment.title}:`, error);
        }
      }
    }

    // Step 7: Add some variety with late submissions and resubmissions
    // Simulate late submission for Bob on first assignment
    if (assignments[0] && students[1]) {
      try {
        await insertSubmissionViaAPI({
          student_profile_id: students[1].private_profile_id,
          assignment_id: assignments[0].id,
          class_id: course.id,
          sha: "late-submission-sha",
          commit_message: "Late submission - used 2 late tokens"
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("Failed to create late submission:", error);
      }
    }

    // Step 8: No manual grade seeding here; covered via import and overrides in tests
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Gradebook" }).click();
    await page.waitForLoadState("networkidle");
  });

  // Helpers
  const getColumnIdBySlug = async (slug: string): Promise<number> => {
    const { data, error } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", course.id)
      .eq("slug", slug)
      .single();
    if (error || !data) throw new Error(`Column ${slug} not found: ${error?.message}`);
    return data.id;
  };

  const getStudentScoreForColumn = async (
    studentPrivateProfileId: string,
    columnSlug: string
  ): Promise<number | null> => {
    const columnId = await getColumnIdBySlug(columnSlug);
    const { data, error } = await supabase
      .from("gradebook_column_students")
      .select("score, score_override")
      .eq("gradebook_column_id", columnId)
      .eq("student_id", studentPrivateProfileId)
      .eq("is_private", true)
      .single();
    if (error) throw new Error(`Failed to fetch score for ${columnSlug}: ${error.message}`);
    const val = (data?.score_override ?? data?.score) as number | null;
    return typeof val === "number" ? val : null;
  };

  const setAverageAssignmentsOverrideViaUI = async (
    page: import("@playwright/test").Page,
    studentName: string,
    newValue: number
  ) => {
    const row = page.getByRole("row", { name: new RegExp(`${studentName}.*grades`, "i") });
    const cell = row.getByLabel(/^Grade cell for Average Assignments:/i);
    await cell.click();
    // There should be a single numeric input for override in the popover
    const overrideInput = page.locator('input[type="number"]');
    await overrideInput.first().fill(String(newValue));
    await page.getByRole("button", { name: /save override/i }).click();
    // Wait for popover to close by ensuring the input disappears
    await expect(overrideInput.first()).toBeHidden({ timeout: 10000 });
  };

  const waitForScore = async (
    studentPrivateProfileId: string,
    columnSlug: string,
    predicate: (v: number | null) => boolean,
    timeoutMs = 20000
  ): Promise<number | null> => {
    const start = Date.now();
    let last: number | null = null;
    while (Date.now() - start < timeoutMs) {
      last = await getStudentScoreForColumn(studentPrivateProfileId, columnSlug);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 400));
    }
    return last;
  };

  test("Instructors can view comprehensive gradebook with real data", async ({ page }) => {
    // Verify the gradebook loads with all components
    await expect(page.getByText("Student Name")).toBeVisible();

    // Check that all students are visible
    for (const student of students) {
      await expect(
        page.getByRole("row", {
          name: student.private_profile_name
        })
      ).toBeVisible();
    }

    // Verify a sample of columns (manual + calculated)
    await expect(page.getByText("Participation")).toBeVisible();
    await expect(page.getByText("Average Assignments")).toBeVisible();
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

  test("Override score on calculated column updates Final Grade", async ({ page }) => {
    const targetStudent = students[0];

    // Read existing values from DB
    const avgBefore = (await getStudentScoreForColumn(targetStudent.private_profile_id, "average-assignments")) ?? 0;
    const finalBefore = (await getStudentScoreForColumn(targetStudent.private_profile_id, "final-grade")) ?? 0;

    // Choose a new override value for Average Assignments
    const delta = avgBefore <= 90 ? 5 : -5;
    const newAvg = Math.max(0, Math.min(100, avgBefore + delta));

    // Apply via UI
    await setAverageAssignmentsOverrideViaUI(page, targetStudent.private_profile_name, newAvg);

    // Wait for recalculation to propagate, then read from DB
    await test.expect
      .poll(async () => await getStudentScoreForColumn(targetStudent.private_profile_id, "average-assignments"), {
        timeout: 15000
      })
      .toBe(newAvg);

    const finalAfter = await waitForScore(
      targetStudent.private_profile_id,
      "final-grade",
      (v) => v !== null && Math.abs((v as number) - finalBefore) > 0.1,
      20000
    );

    // Final grade should change approximately by 0.5 * delta (within tolerance)
    const expectedFinal = finalBefore + 0.5 * delta;
    expect(finalAfter).not.toBeNull();
    const finalAfterNumber = finalAfter as number | null;
    if (finalAfterNumber != null) {
      expect(Math.abs(finalAfterNumber - expectedFinal)).toBeLessThanOrEqual(3);
    }
  });

  test("Import Column wizard creates and updates columns", async ({ page }) => {
    // Open Import dialog
    await page.getByRole("button", { name: /import column/i }).click();

    // Step 1: upload CSV
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/test-gradebook-import.csv");

    // Step 2 should show mapping UI
    // Ensure identifier column is set to email (it auto-detects, but we enforce)
    const selects = page.locator("select");
    // The first select in step 2 is the identifier column selection
    await selects.first().selectOption({ label: "email" });
    // The second select is identifier type
    await selects.nth(1).selectOption({ label: "Email" });
    // Now mapping selects for our two grade columns (order follows header order minus id col)
    // Map 'Participation' to existing column
    await selects.nth(2).selectOption({ label: "Participation" });
    // Map 'Project Bonus' to create new column
    await selects.nth(3).selectOption("new");
    // Set max score for the new column (shown when selecting "new")
    const maxScoreInput = page.locator('input[type="number"]').last();
    await maxScoreInput.fill("10");

    // Go to preview
    await page.getByRole("button", { name: /preview import/i }).click();
    await expect(page.getByText(/preview changes/i)).toBeVisible();

    // Confirm import
    await page.getByRole("button", { name: /confirm import/i }).click();

    // Validate DB updates for Participation
    const partScoreAlice = await test.expect.poll(
      async () => await getStudentScoreForColumn(students[0].private_profile_id, "participation"),
      { timeout: 20000 }
    );
    expect(partScoreAlice).toBe(96);

    // Find the newly created column by external_data.source === 'csv' and our file name
    const { data: newCols } = await supabase
      .from("gradebook_columns")
      .select("id, name, slug, external_data")
      .eq("class_id", course.id);
    const createdCsvCols = (newCols || []).filter(
      (c) =>
        c.external_data &&
        typeof c.external_data === "object" &&
        (c.external_data as { source?: string }).source === "csv"
    );
    // The latest created CSV-based column should be Project Bonus
    const projectBonusCol = createdCsvCols[createdCsvCols.length - 1];
    expect(projectBonusCol).toBeTruthy();

    // Validate that Project Bonus values were written
    if (projectBonusCol) {
      const { data: bonusAlice } = await supabase
        .from("gradebook_column_students")
        .select("score, score_override")
        .eq("gradebook_column_id", projectBonusCol.id)
        .eq("student_id", students[0].private_profile_id)
        .eq("is_private", true)
        .single();
      const aliceBonus = (bonusAlice?.score_override ?? bonusAlice?.score) as number | null;
      expect(aliceBonus).toBe(5);
    }
  });

  test("Add Column wizard creates a new manual column", async ({ page }) => {
    await page.getByRole("button", { name: /add column/i }).click();

    const rand = Math.random().toString(36).slice(2, 8);
    const name = `Extra Credit ${rand}`;
    const slug = `extra-credit-${rand}`;

    await page.getByLabel(/name/i).fill(name);
    await page.getByLabel(/max score/i).fill("50");
    await page.getByLabel(/slug/i).fill(slug);
    await page.getByRole("button", { name: /^save$/i }).click();

    // Verify in DB
    const createdId = await test.expect.poll(
      async () => {
        const { data } = await supabase
          .from("gradebook_columns")
          .select("id")
          .eq("class_id", course.id)
          .eq("slug", slug)
          .maybeSingle();
        return data?.id ?? null;
      },
      { timeout: 20000 }
    );
    expect(createdId).not.toBeNull();

    // The new column title should appear in the header
    await expect(page.getByText(name)).toBeVisible();
  });
});
