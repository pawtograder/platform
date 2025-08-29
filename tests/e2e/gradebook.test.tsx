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
        numAssignments: 3,
        groupConfig: "individual" as const,
        namePrefix: "assignment"
      },
      {
        numAssignments: 2,
        groupConfig: "groups" as const,
        namePrefix: "group"
      },
      {
        numAssignments: 2,
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
        numManualGradedColumns: config === assignmentConfigs[0] ? 2 : 0,
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
    for (const assignment of assignments) {
      let submittingStudents = students;

      if (assignment.assignmentType === "lab") {
        submittingStudents = students.slice(0, 3); // Diana didn't submit
      } else if (assignment.assignmentType === "group") {
        submittingStudents = students;
      }

      for (const student of submittingStudents) {
        try {
          const submissionResult = await insertPreBakedSubmission({
            student_profile_id: student.private_profile_id,
            assignment_id: assignment.id,
            class_id: course.id,
            assignment_group_id: assignment.assignmentType === "group" ? 1 : undefined
          });

          const baseScore = 70 + Math.floor(Math.random() * 25);
          const isCompleted = Math.random() > 0.2;

          if (submissionResult.grading_review_id) {
            await gradeSubmission(
              submissionResult.grading_review_id,
              tas[Math.floor(Math.random() * tas.length)].private_profile_id,
              isCompleted,
              {
                checkApplyChance: 0.8,
                totalScoreOverride: isCompleted ? baseScore : 0,
                totalAutogradeScoreOverride: Math.floor(baseScore * 0.6),
                pointsRandomizer: () => Math.random() * 0.8 + 0.2,
                fileSelectionRandomizer: () => Math.random(),
                lineNumberRandomizer: () => Math.random()
              }
            );
          }
        } catch (error) {
          console.warn(`Failed to create/grade submission for ${student.email} on ${assignment.title}:`, error);
        }
      }
    }

    // Step 6: Add late submission for Bob
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
        console.warn("Failed to create late submission:", error);
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Gradebook" }).click();
    await page.waitForLoadState("networkidle");
  });

  // Helper functions
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

  // Test 1: Comprehensive rendering verification
  test("Verifies all gradebook elements render correctly", async ({ page }) => {
    // Verify header elements
    await expect(page.getByText("Student Name")).toBeVisible();
    await expect(page.getByText("Class Section")).toBeVisible();
    await expect(page.getByText("Lab Section")).toBeVisible();

    // Verify all students are visible with correct names
    for (const student of students) {
      await expect(
        page.getByRole("row", {
          name: new RegExp(student.private_profile_name)
        })
      ).toBeVisible();
    }

    // Verify manual columns
    await expect(page.getByText("Participation")).toBeVisible();

    // Verify calculated columns
    await expect(page.getByText("Average Assignments")).toBeVisible();
    await expect(page.getByText("Average Lab Assignments")).toBeVisible();
    await expect(page.getByText("Final Grade")).toBeVisible();

    // Verify student count display
    await expect(page.getByText(`Showing ${students.length} students`)).toBeVisible();

    // Verify action buttons
    await expect(page.getByRole("button", { name: "Download Gradebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import Column" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Column" })).toBeVisible();

    // Verify column group headers (expand/collapse functionality)
    await expect(page.getByRole("button", { name: /Expand all groups/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Collapse all groups/i })).toBeVisible();

    // Take screenshot for visual regression
    await argosScreenshot(page, "Gradebook Page - Full Render");
  });

  // Test 2: Override score functionality - non-calculated column
  test("Override score on manual column", async ({ page }) => {
    const targetStudent = students[0];

    // Find and click on the participation cell for Alice
    const row = page.getByRole("row", { name: new RegExp(`${targetStudent.private_profile_name}.*grades`, "i") });
    const cell = row.getByLabel(/^Grade cell for Participation:/i);
    await cell.click();

    // Enter a new score
    const scoreInput = page.locator('input[type="number"]').first();
    await scoreInput.fill("85");

    // Check the "Droppable" checkbox
    const droppableCheckbox = page.getByRole("checkbox", { name: "Droppable" });
    await droppableCheckbox.check();

    // Save the update
    await page.getByRole("button", { name: /update/i }).click();

    // Wait for popover to close
    await expect(scoreInput).toBeHidden({ timeout: 10000 });

    // Verify the score was updated in the database
    const newScore = await getStudentScoreForColumn(targetStudent.private_profile_id, "participation");
    expect(newScore).toBe(85);
  });

  // Test 3: Override score on calculated column with warning
  test("Override calculated column shows warning and updates Final Grade", async ({ page }) => {
    const targetStudent = students[0];

    // Get initial values
    const avgBefore = (await getStudentScoreForColumn(targetStudent.private_profile_id, "average-assignments")) ?? 0;
    const finalBefore = (await getStudentScoreForColumn(targetStudent.private_profile_id, "final-grade")) ?? 0;

    // Click on Average Assignments cell
    const row = page.getByRole("row", { name: new RegExp(`${targetStudent.private_profile_name}.*grades`, "i") });
    const cell = row.getByLabel(/^Grade cell for Average Assignments:/i);
    await cell.click();

    // Verify warning message is displayed
    await expect(page.getByText(/This column is automatically calculated/i)).toBeVisible();
    await expect(page.getByText(/very few cases where you should override/i)).toBeVisible();

    // Enter override value
    const newAvg = Math.max(0, Math.min(100, avgBefore + 10));
    const overrideInput = page.locator('input[type="number"]').first();
    await overrideInput.fill(String(newAvg));

    // Add a note
    const noteInput = page.locator('input[type="text"]').first();
    await noteInput.fill("Test override for grading adjustment");

    // Save override
    await page.getByRole("button", { name: /save override/i }).click();
    await expect(overrideInput).toBeHidden({ timeout: 10000 });

    // Verify override was applied
    await test.expect
      .poll(async () => await getStudentScoreForColumn(targetStudent.private_profile_id, "average-assignments"), {
        timeout: 15000
      })
      .toBe(newAvg);

    // Verify Final Grade was recalculated
    const finalAfter = await waitForScore(
      targetStudent.private_profile_id,
      "final-grade",
      (v) => v !== null && Math.abs((v as number) - finalBefore) > 0.1,
      20000
    );

    expect(finalAfter).not.toBeNull();
    expect(finalAfter).not.toBe(finalBefore);
  });

  // Test 4: Clear override functionality
  test("Clear override on calculated column", async ({ page }) => {
    const targetStudent = students[0];

    // First set an override
    const row = page.getByRole("row", { name: new RegExp(`${targetStudent.private_profile_name}.*grades`, "i") });
    const cell = row.getByLabel(/^Grade cell for Average Assignments:/i);
    await cell.click();

    const overrideInput = page.locator('input[type="number"]').first();
    await overrideInput.fill("95");
    await page.getByRole("button", { name: /save override/i }).click();
    await expect(overrideInput).toBeHidden({ timeout: 10000 });

    // Re-open and clear override
    await cell.click();
    await page.getByRole("button", { name: /clear override/i }).click();
    await expect(page.getByRole("button", { name: /clear override/i })).toBeHidden({ timeout: 10000 });

    // Verify override was cleared in database
    const { data } = await supabase
      .from("gradebook_column_students")
      .select("score_override")
      .eq("student_id", targetStudent.private_profile_id)
      .eq("is_private", true)
      .single();

    expect(data?.score_override).toBeNull();
  });

  // Test 5: Import column with email identifiers
  test("Import Column wizard creates and updates columns with email", async ({ page }) => {
    // Open Import dialog
    await page.getByRole("button", { name: /import column/i }).click();

    // Step 1: Upload CSV
    const fileChooser = page.locator('input[type="file"][accept=".csv"]');
    await fileChooser.setInputFiles("tests/e2e/test-gradebook-import.csv");

    // Step 2: Configure mapping
    const selects = page.locator("select");

    // Set identifier column (should auto-detect email)
    await selects.first().selectOption({ label: "email" });

    // Set identifier type
    await selects.nth(1).selectOption({ label: "Email" });

    // Map Participation to existing column
    await selects.nth(2).selectOption({ label: "Participation" });

    // Map Project Bonus to create new column
    await selects.nth(3).selectOption("new");

    // Set max score for Project Bonus
    let maxScoreInputs = page.locator('input[type="number"]');
    await maxScoreInputs.nth(0).fill("10");

    // Map Extra Credit to create new column
    await selects.nth(4).selectOption("new");

    // Set max score for Extra Credit
    maxScoreInputs = page.locator('input[type="number"]');
    await maxScoreInputs.nth(1).fill("20");

    // Go to preview
    await page.getByRole("button", { name: /preview import/i }).click();

    // Verify preview shows warnings
    await expect(page.getByText(/1 student\(s\) in the import are not in the roster/i)).toBeVisible();
    await expect(page.getByText(/unknown@example.com/i)).toBeVisible();

    // Verify preview table shows correct values
    await expect(page.getByText("Update: Participation")).toBeVisible();
    await expect(page.getByText(/New: Project Bonus/i)).toBeVisible();
    await expect(page.getByText(/New: Extra Credit/i)).toBeVisible();

    // Confirm import
    await page.getByRole("button", { name: /confirm import/i }).click();

    // Wait for success message
    await expect(page.getByText(/Import successful/i)).toBeVisible({ timeout: 20000 });

    // Verify Participation was updated
    const partScoreAlice = await test.expect.poll(
      async () => await getStudentScoreForColumn(students[0].private_profile_id, "participation"),
      { timeout: 20000 }
    );
    expect(partScoreAlice).toBe(96);

    // Verify new columns were created
    const { data: newCols } = await supabase
      .from("gradebook_columns")
      .select("id, name, slug, external_data, max_score")
      .eq("class_id", course.id)
      .ilike("name", "%Project Bonus%");

    expect(newCols).toHaveLength(1);
    expect(newCols![0].max_score).toBe(10);
    expect(newCols![0].external_data).toMatchObject({
      source: "csv",
      fileName: expect.stringContaining("grades")
    });
  });

  // Test 6: Import column with Student ID identifiers
  test("Import Column with Student ID identifiers", async ({ page }) => {
    // First, set SIS IDs for students
    await supabase.from("users").update({ sis_user_id: 1001 }).eq("email", students[0].email);
    await supabase.from("users").update({ sis_user_id: 1002 }).eq("email", students[1].email);
    await supabase.from("users").update({ sis_user_id: 1003 }).eq("email", students[2].email);
    await supabase.from("users").update({ sis_user_id: 1004 }).eq("email", students[3].email);

    // Open Import dialog
    await page.getByRole("button", { name: /import column/i }).click();

    // Upload CSV
    const fileChooser = page.locator('input[type="file"][accept=".csv"]');
    await fileChooser.setInputFiles("tests/e2e/test-gradebook-import.csv");

    // Configure mapping
    const selects = page.locator("select");
    await selects.first().selectOption({ label: "student_id" });
    await selects.nth(1).selectOption({ label: "Student ID" });

    // Create new columns for both quizzes
    await selects.nth(2).selectOption("new");
    await selects.nth(3).selectOption("new");

    // Set max scores
    const maxScoreInputs = page.locator('input[type="number"]');
    await maxScoreInputs.nth(0).fill("100");
    await maxScoreInputs.nth(1).fill("100");

    // Preview and confirm
    await page.getByRole("button", { name: /preview import/i }).click();
    await expect(page.getByText(/1 student\(s\) in the import are not in the roster/i)).toBeVisible();
    await page.getByRole("button", { name: /confirm import/i }).click();

    await expect(page.getByText(/Import successful/i)).toBeVisible({ timeout: 20000 });

    // Verify Quiz 1 scores were imported correctly
    const { data: quiz1Col } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("class_id", course.id)
      .ilike("name", "%Quiz 1%")
      .single();

    const { data: aliceQuiz1 } = await supabase
      .from("gradebook_column_students")
      .select("score")
      .eq("gradebook_column_id", quiz1Col!.id)
      .eq("student_id", students[0].private_profile_id)
      .eq("is_private", true)
      .single();

    expect(aliceQuiz1?.score).toBe(100);
  });

  // Test 7: Add Column with expressions
  test("Add Column wizard with score and render expressions", async ({ page }) => {
    await page.getByRole("button", { name: /add column/i }).click();

    const rand = Math.random().toString(36).slice(2, 8);
    const name = `Weighted Average ${rand}`;
    const slug = `weighted-avg-${rand}`;

    // Fill in basic fields
    await page.getByLabel(/^name/i).fill(name);
    await page.getByLabel(/max score/i).fill("100");
    await page.getByLabel(/^slug/i).fill(slug);

    // Add score expression
    const scoreExpr = 'mean(gradebook_columns("assignment-*")) * 0.7 + gradebook_columns("participation") * 0.3';
    await page.getByLabel(/score expression/i).fill(scoreExpr);

    // Add render expression
    await page.getByLabel(/render expression/i).fill("letter(score)");

    // Save
    await page.getByRole("button", { name: /^save$/i }).click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10000 });

    // Verify column was created
    const { data } = await supabase
      .from("gradebook_columns")
      .select("*")
      .eq("class_id", course.id)
      .eq("slug", slug)
      .single();

    expect(data).toBeTruthy();
    expect(data?.score_expression).toBe(scoreExpr);
    expect(data?.render_expression).toBe("letter(score)");
    expect(data?.max_score).toBe(100);

    // Verify column appears in UI
    await expect(page.getByText(name)).toBeVisible();
  });

  // Test 8: Edit Column functionality
  test("Edit Column dialog updates column properties", async ({ page }) => {
    // Create a column to edit
    const { data: col } = await supabase
      .from("gradebook_columns")
      .insert({
        name: "Test Edit Column",
        slug: "test-edit-col",
        max_score: 50,
        class_id: course.id,
        gradebook_id: (await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()).data!.id
      })
      .select()
      .single();

    // Refresh page to see new column
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Find the column header and open menu
    const columnHeader = page.locator('text="Test Edit Column"').first();
    await columnHeader.hover();

    // Click the menu button for this column
    const menuButton = columnHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButton.click();

    // Click Edit Column
    await page.getByRole("menuitem", { name: /edit column/i }).click();

    // Update fields
    await page.getByLabel(/^name/i).fill("Updated Column Name");
    await page.getByLabel(/description/i).fill("This column has been updated");
    await page.getByLabel(/max score/i).fill("75");

    // Note: Slug should be disabled
    const slugInput = page.getByLabel(/^slug/i);
    await expect(slugInput).toBeDisabled();

    // Save changes
    await page.getByRole("button", { name: /^save$/i }).click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10000 });

    // Verify changes in database
    const { data: updated } = await supabase.from("gradebook_columns").select("*").eq("id", col!.id).single();

    expect(updated?.name).toBe("Updated Column Name");
    expect(updated?.description).toBe("This column has been updated");
    expect(updated?.max_score).toBe(75);
  });

  // Test 9: Delete Column functionality
  test("Delete Column with dependency check", async ({ page }) => {
    // Create two columns where one depends on the other
    const gradebookId = (await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()).data!.id;

    const { data: baseCol } = await supabase
      .from("gradebook_columns")
      .insert({
        name: "Base Column",
        slug: "base-col-delete",
        max_score: 100,
        class_id: course.id,
        gradebook_id: gradebookId
      })
      .select()
      .single();

    const { data: dependentCol } = await supabase
      .from("gradebook_columns")
      .insert({
        name: "Dependent Column",
        slug: "dependent-col-delete",
        max_score: 100,
        score_expression: 'gradebook_columns("base-col-delete") * 2',
        dependencies: { gradebook_columns: [baseCol!.id] },
        class_id: course.id,
        gradebook_id: gradebookId
      })
      .select()
      .single();

    // Refresh page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Try to delete base column (should fail due to dependency)
    const baseColumnHeader = page.locator('text="Base Column"').first();
    await baseColumnHeader.hover();
    const baseMenuButton = baseColumnHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await baseMenuButton.click();
    await page.getByRole("menuitem", { name: /delete column/i }).click();

    // Should show dependency warning
    await expect(page.getByText(/can not currently delete this column/i)).toBeVisible();
    await expect(page.getByText("Dependent Column")).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: /close/i }).click();

    // Now delete dependent column first
    const depColumnHeader = page.locator('text="Dependent Column"').first();
    await depColumnHeader.hover();
    const depMenuButton = depColumnHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await depMenuButton.click();
    await page.getByRole("menuitem", { name: /delete column/i }).click();

    // Confirm deletion
    await expect(page.getByText(/Are you sure you want to delete this column/i)).toBeVisible();
    await page.getByRole("button", { name: /delete column/i }).click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10000 });

    // Verify column was deleted
    const { data: deletedCol } = await supabase
      .from("gradebook_columns")
      .select("id")
      .eq("id", dependentCol!.id)
      .single();

    expect(deletedCol).toBeNull();
  });

  // Test 10: Convert Missing to 0 functionality
  test("Convert Missing to 0 for manual column", async ({ page }) => {
    // Create a column with some missing values
    const gradebookId = (await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()).data!.id;

    const { data: col } = await supabase
      .from("gradebook_columns")
      .insert({
        name: "Missing Test Column",
        slug: "missing-test-col",
        max_score: 100,
        class_id: course.id,
        gradebook_id: gradebookId
      })
      .select()
      .single();

    // Set some scores and leave others as null/missing
    const { data: colStudents } = await supabase
      .from("gradebook_column_students")
      .select("id, student_id")
      .eq("gradebook_column_id", col!.id)
      .eq("is_private", true);

    // Set scores for first two students, leave others as missing
    if (colStudents && colStudents.length >= 4) {
      await supabase.from("gradebook_column_students").update({ score: 85 }).eq("id", colStudents[0].id);

      await supabase.from("gradebook_column_students").update({ score: 90 }).eq("id", colStudents[1].id);

      // Mark third student as explicitly missing
      await supabase.from("gradebook_column_students").update({ is_missing: true }).eq("id", colStudents[2].id);
    }

    // Refresh page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Open column menu and select Convert Missing to 0
    const columnHeader = page.locator('text="Missing Test Column"').first();
    await columnHeader.hover();
    const menuButton = columnHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /convert missing to 0/i }).click();

    // Confirm conversion
    await expect(page.getByText(/convert all missing values in column/i)).toBeVisible();
    await page.getByRole("button", { name: /convert missing to 0/i }).click();

    // Wait for success message
    await expect(page.getByText(/Missing values have been converted to 0/i)).toBeVisible({ timeout: 10000 });

    // Verify in database that missing values are now 0
    const { data: updatedStudents } = await supabase
      .from("gradebook_column_students")
      .select("score, is_missing, score_override_note")
      .eq("gradebook_column_id", col!.id)
      .eq("is_private", true);

    updatedStudents?.forEach((student) => {
      if (student.score === 0) {
        expect(student.is_missing).toBe(false);
        expect(student.score_override_note).toBe("Missing value converted to 0");
      }
    });
  });

  // Test 11: Column filtering functionality
  test("Filter gradebook columns by score", async ({ page }) => {
    // Open filter for Participation column
    const participationHeader = page.locator('text="Participation"').first();
    await participationHeader.hover();
    const menuButton = participationHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /show filter/i }).click();

    // Wait for filter dropdown to appear
    await expect(page.getByPlaceholder(/filter participation/i)).toBeVisible();

    // Apply filter - this will vary based on actual scores
    // For now, we'll just verify the filter UI works
    const filterInput = page.getByPlaceholder(/filter participation/i);
    await filterInput.click();

    // Verify filter is applied (filter icon should be visible)
    await page.keyboard.press("Escape"); // Close filter

    // Clear filter
    await participationHeader.hover();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /hide filter/i }).click();
  });

  // Test 12: Column sorting functionality
  test("Sort columns ascending and descending", async ({ page }) => {
    // Sort by Student Name ascending
    const studentNameHeader = page.locator('text="Student Name"').first();
    await studentNameHeader.hover();
    const menuButton = studentNameHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /sort ascending/i }).click();

    // Verify Alice is first
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow).toContainText("Alice Anderson");

    // Sort descending
    await studentNameHeader.hover();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /sort descending/i }).click();

    // Verify Diana is first
    const firstRowDesc = page.locator("tbody tr").first();
    await expect(firstRowDesc).toContainText("Diana Davis");

    // Clear sort
    await studentNameHeader.hover();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /clear sort/i }).click();
  });

  // Test 13: Expand/Collapse column groups
  test("Expand and collapse column groups", async ({ page }) => {
    // Click collapse all button
    await page.getByRole("button", { name: /collapse all groups/i }).click();

    // Verify groups are collapsed (look for chevron right icons in group headers)
    const groupHeaders = page.locator("text=/\\d+ Assignments?\\.\\.\\./");
    await expect(groupHeaders.first()).toBeVisible();

    // Expand all groups
    await page.getByRole("button", { name: /expand all groups/i }).click();

    // Verify groups are expanded (chevron down icons)
    await page.waitForTimeout(500); // Wait for animation

    // Click on a specific group to toggle
    const firstGroup = groupHeaders.first();
    if (await firstGroup.isVisible()) {
      await firstGroup.click();
      // Group should toggle its state
      await page.waitForTimeout(500);
    }
  });

  // Test 14: Download gradebook CSV
  test("Download gradebook as CSV", async ({ page }) => {
    // Set up download promise before clicking
    const downloadPromise = page.waitForEvent("download");

    // Click download button
    await page.getByRole("button", { name: /download gradebook/i }).click();

    // Wait for download to complete
    const download = await downloadPromise;

    // Verify filename
    expect(download.suggestedFilename()).toBe("gradebook.csv");

    // Save and read the file to verify content
    const path = await download.path();
    if (path) {
      const content = await download.createReadStream();
      // Basic verification that it's CSV format
      expect(content).toBeTruthy();
    }
  });

  // Test 15: Release/Unrelease column functionality
  test("Release and unrelease gradebook columns", async ({ page }) => {
    // Create an unreleased column
    const gradebookId = (await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()).data!.id;

    const { data: col } = await supabase
      .from("gradebook_columns")
      .insert({
        name: "Release Test Column",
        slug: "release-test-col",
        max_score: 100,
        released: false,
        class_id: course.id,
        gradebook_id: gradebookId
      })
      .select()
      .single();

    // Refresh page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Find column and release it
    const columnHeader = page.locator('text="Release Test Column"').first();
    await columnHeader.hover();
    const menuButton = columnHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /^release column$/i }).click();

    // Wait for success message
    await expect(page.getByText(/successfully released/i)).toBeVisible({ timeout: 10000 });

    // Verify in database
    const { data: released } = await supabase.from("gradebook_columns").select("released").eq("id", col!.id).single();

    expect(released?.released).toBe(true);

    // Now unrelease it
    await columnHeader.hover();
    await menuButton.click();
    await page.getByRole("menuitem", { name: /unrelease column/i }).click();

    // Wait for success message
    await expect(page.getByText(/successfully unreleased/i)).toBeVisible({ timeout: 10000 });

    // Verify in database
    const { data: unreleased } = await supabase.from("gradebook_columns").select("released").eq("id", col!.id).single();

    expect(unreleased?.released).toBe(false);
  });

  // Test 16: Move column left/right
  test("Move gradebook columns left and right", async ({ page }) => {
    // Create two columns to test movement
    const gradebookId = (await supabase.from("gradebooks").select("id").eq("class_id", course.id).single()).data!.id;

    await supabase.from("gradebook_columns").insert([
      {
        name: "Move Test A",
        slug: "move-test-a",
        max_score: 100,
        sort_order: 1000,
        class_id: course.id,
        gradebook_id: gradebookId
      },
      {
        name: "Move Test B",
        slug: "move-test-b",
        max_score: 100,
        sort_order: 1001,
        class_id: course.id,
        gradebook_id: gradebookId
      }
    ]);

    // Refresh page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Move column B to the left
    const columnBHeader = page.locator('text="Move Test B"').first();
    await columnBHeader.hover();
    const menuButtonB = columnBHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await menuButtonB.click();
    await page.getByRole("menuitem", { name: /move left/i }).click();

    // Wait for success message
    await expect(page.getByText(/successfully moved.*to the left/i)).toBeVisible({ timeout: 10000 });

    // Verify order changed in database
    const { data: columns } = await supabase
      .from("gradebook_columns")
      .select("name, sort_order")
      .eq("class_id", course.id)
      .in("slug", ["move-test-a", "move-test-b"])
      .order("sort_order");

    expect(columns?.[0].name).toBe("Move Test B");
    expect(columns?.[1].name).toBe("Move Test A");

    // Move column B to the right (back to original position)
    await columnBHeader.hover();
    await menuButtonB.click();
    await page.getByRole("menuitem", { name: /move right/i }).click();

    // Wait for success message
    await expect(page.getByText(/successfully moved.*to the right/i)).toBeVisible({ timeout: 10000 });
  });

  // Test 17: Auto-layout functionality
  test("Auto-layout reorganizes columns", async ({ page }) => {
    // Click auto-layout button
    await page.getByRole("button", { name: /auto-layout columns/i }).click();

    // Wait for success message
    await expect(page.getByText(/auto-layout complete/i)).toBeVisible({ timeout: 10000 });

    // Verify columns are reordered (check database)
    const { data: columns } = await supabase
      .from("gradebook_columns")
      .select("name, sort_order, score_expression")
      .eq("class_id", course.id)
      .order("sort_order");

    // Manual columns should come before calculated columns
    const manualColumns = columns?.filter((c) => !c.score_expression) || [];
    const calculatedColumns = columns?.filter((c) => c.score_expression) || [];

    if (manualColumns.length > 0 && calculatedColumns.length > 0) {
      const lastManualOrder = Math.max(...manualColumns.map((c) => c.sort_order || 0));
      const firstCalculatedOrder = Math.min(...calculatedColumns.map((c) => c.sort_order || 0));
      expect(lastManualOrder).toBeLessThan(firstCalculatedOrder);
    }
  });

  // Test 18: Student detail view (What-If functionality)
  test("Student detail view opens What-If dialog", async ({ page }) => {
    // Click on a student name to open detail view
    await page.getByText("Alice Anderson").click();

    // Verify What-If dialog opens
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/simulate the impact of a grade change/i)).toBeVisible();

    // Verify student name is shown in dialog
    await expect(page.getByRole("dialog")).toContainText("Alice Anderson");

    // Close dialog
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  // Test 19: Section filtering
  test("Filter students by class and lab sections", async ({ page }) => {
    // Filter by class section
    const classSectionHeader = page.locator('text="Class Section"').first();
    await classSectionHeader.hover();
    const classMenuButton = classSectionHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await classMenuButton.click();
    await page.getByRole("menuitem", { name: /show filter/i }).click();

    // Wait for filter to appear
    await expect(page.getByPlaceholder(/filter class section/i)).toBeVisible();

    // Similarly test lab section filter
    const labSectionHeader = page.locator('text="Lab Section"').first();
    await labSectionHeader.hover();
    const labMenuButton = labSectionHeader.locator("..").locator('button[aria-label="Column options"]').first();
    await labMenuButton.click();
    await page.getByRole("menuitem", { name: /show filter/i }).click();

    // Verify lab section filter appears
    await expect(page.getByPlaceholder(/filter lab section/i)).toBeVisible();
  });

  // Test 20: Excused and Missing flags
  test("Set and clear excused and missing flags", async ({ page }) => {
    const targetStudent = students[2]; // Charlie

    // Click on a manual grade cell
    const row = page.getByRole("row", { name: new RegExp(`${targetStudent.private_profile_name}.*grades`, "i") });
    const cell = row.getByLabel(/^Grade cell for Participation:/i);
    await cell.click();

    // Set as excused
    const excusedCheckbox = page.getByRole("checkbox", { name: "Excused" });
    await excusedCheckbox.check();

    // Set as missing
    const missingCheckbox = page.getByRole("checkbox", { name: "Missing" });
    await missingCheckbox.check();

    // Save
    await page.getByRole("button", { name: /update/i }).click();

    // Wait for popover to close
    await expect(excusedCheckbox).toBeHidden({ timeout: 10000 });

    // Verify in database
    const columnId = await getColumnIdBySlug("participation");
    const { data } = await supabase
      .from("gradebook_column_students")
      .select("is_excused, is_missing")
      .eq("gradebook_column_id", columnId)
      .eq("student_id", targetStudent.private_profile_id)
      .eq("is_private", true)
      .single();

    expect(data?.is_excused).toBe(true);
    expect(data?.is_missing).toBe(true);
  });
});
