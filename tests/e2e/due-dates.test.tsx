import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addDays, addHours, previousMonday } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createClass,
  createLabSectionWithStudents,
  createUsersInClass,
  formatDateForTest,
  insertAssignment,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";

let course: Course;
let student: TestingUser | undefined;
let student2: TestingUser | undefined;
let instructor: TestingUser | undefined;
let labLeader: TestingUser | undefined;
let testAssignment: Assignment | undefined;
let testLabAssignment: Assignment | undefined;
let testGroupAssignment: Assignment | undefined;
let assignmentGroup: { id: number } | undefined;

const assignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
assignmentDueDate.setHours(9, 0, 0, 0);
const labAssignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
labAssignmentDueDate.setHours(10, 0, 0, 0);
const groupAssignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
groupAssignmentDueDate.setHours(11, 0, 0, 0);
test.beforeEach(async () => {
  course = await createClass();
  [labLeader, student, student2, instructor] = await createUsersInClass([
    {
      name: "Due Dates Lab Leader",
      email: "due-dates-lab-leader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Due Dates Student 1",
      email: "due-dates-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Due Dates Student 2",
      email: "due-dates-student-2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Due Dates Instructor",
      email: "due-dates-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  await createLabSectionWithStudents({
    class_id: course.id,
    lab_leader: labLeader,
    day_of_week: "monday",
    students: [student],
    start_time: "04:00",
    end_time: "05:00"
  });
  testAssignment = await insertAssignment({
    due_date: assignmentDueDate.toUTCString(),
    class_id: course.id,
    name: "Due Dates Assignment"
  });
  testLabAssignment = await insertAssignment({
    due_date: labAssignmentDueDate.toUTCString(),
    lab_due_date_offset: 42,
    class_id: course.id,
    name: "Due Dates Lab Assignment"
  });

  // Create group assignment
  const { data: selfReviewSettingData, error: selfReviewSettingError } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: course.id,
      enabled: true,
      deadline_offset: 2,
      allow_early: true
    })
    .select("id")
    .single();

  if (selfReviewSettingError) {
    throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
  }

  const { data: insertedGroupAssignmentData, error: groupAssignmentError } = await supabase
    .from("assignments")
    .insert({
      title: "Due Dates Group Assignment",
      description: "This is a test group assignment for E2E testing",
      due_date: groupAssignmentDueDate.toUTCString(),
      template_repo: "pawtograder-playground/test-e2e-handout-repo-java",
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: course.id,
      slug: "group-assignment-due-dates",
      group_config: "groups",
      allow_not_graded_submissions: false,
      self_review_setting_id: selfReviewSettingData.id,
      max_group_size: 6,
      group_formation_deadline: addDays(new Date(), -1).toUTCString()
    })
    .select("*")
    .single();

  if (groupAssignmentError) {
    throw new Error(`Failed to create group assignment: ${groupAssignmentError.message}`);
  }

  testGroupAssignment = insertedGroupAssignmentData;

  // Create assignment group
  const { data: insertedGroupData, error: groupError } = await supabase
    .from("assignment_groups")
    .insert({
      name: "Test Group 1",
      class_id: course.id,
      assignment_id: testGroupAssignment.id
    })
    .select("id")
    .single();

  if (groupError) {
    throw new Error(`Failed to create assignment group: ${groupError.message}`);
  }

  assignmentGroup = insertedGroupData;

  // Add both students to the group
  const { error: member1Error } = await supabase.from("assignment_groups_members").insert({
    assignment_group_id: assignmentGroup.id,
    profile_id: student!.private_profile_id,
    assignment_id: testGroupAssignment.id,
    class_id: course.id,
    added_by: instructor!.private_profile_id
  });

  if (member1Error) {
    throw new Error(`Failed to add student 1 to group: ${member1Error.message}`);
  }

  const { error: member2Error } = await supabase.from("assignment_groups_members").insert({
    assignment_group_id: assignmentGroup.id,
    profile_id: student2!.private_profile_id,
    assignment_id: testGroupAssignment.id,
    class_id: course.id,
    added_by: instructor!.private_profile_id
  });

  if (member2Error) {
    throw new Error(`Failed to add student 2 to group: ${member2Error.message}`);
  }
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, student2, instructor, labLeader]);
});
const expectedLabAssignmentDueDate =
  labAssignmentDueDate.getDay() === 1 ? labAssignmentDueDate : previousMonday(labAssignmentDueDate);
expectedLabAssignmentDueDate.setHours(5, 42, 0, 0);

function getDueDateShortString(date: Date) {
  return formatDateForTest(date, "America/New_York", "Pp");
}
test.describe("Assignment due dates", () => {
  test("Lab-section and non-lab-section assignment due dates are calculated correctly on the course landing page and on the assignments page", async ({
    page
  }) => {
    await loginAsUser(page, student!, course);
    await expect(page.locator("body")).toContainText(
      `${testAssignment!.title}Due${getDueDateShortString(new TZDate(testAssignment!.due_date, "America/New_York"))}Most recent submissionNo submissions`
    );
    await expect(page.locator("body")).toContainText(
      `${testLabAssignment!.title}Due${getDueDateShortString(new TZDate(expectedLabAssignmentDueDate, "America/New_York"))}Most recent submissionNo submissions`
    );
    await expect(page.locator("body")).toContainText(
      `${testGroupAssignment!.title}Due${getDueDateShortString(new TZDate(testGroupAssignment!.due_date, "America/New_York"))}Most recent submissionNo submissions`
    );
    await expect(page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const link = page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" });
    await link.click();
    //Wait for the page to load to avoid race condition
    await expect(page).toHaveURL(/\/assignments\b/);
    await expect(page.getByText(testAssignment!.title)).toBeVisible();
    const cell = page.getByRole("cell", { name: testAssignment!.title });
    await expect(cell).toBeVisible();

    const row = page.getByRole("row").filter({ has: cell });
    await expect(
      row.getByText(formatDateForTest(new TZDate(testAssignment!.due_date, "America/New_York")))
    ).toBeVisible();

    const labRow = page.getByRole("row").filter({ has: page.getByText(testLabAssignment!.title) });
    await expect(
      labRow.getByText(formatDateForTest(new TZDate(expectedLabAssignmentDueDate, "America/New_York")))
    ).toBeVisible();

    const groupRow = page.getByRole("row").filter({ has: page.getByText(testGroupAssignment!.title) });
    await expect(
      groupRow.getByText(formatDateForTest(new TZDate(testGroupAssignment!.due_date, "America/New_York")))
    ).toBeVisible();
    await assertStudentPageAccessible(page, "due dates assignments table");
  });
  test("When students extend their due date, the due date is updated on the assignments page", async ({ page }) => {
    //Test with the lab section assignment
    await loginAsUser(page, student!, course);
    await expect(page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const link = page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" });
    await link.click();
    //Wait for the page to load to avoid race condition
    await expect(page).toHaveURL(/\/assignments\b/);
    await page.getByRole("link", { name: testLabAssignment!.title }).click();

    await expect(page.getByText("This is a test assignment for E2E testing")).toBeVisible();
    // Wait for the assignment detail page to fully load and the due date component to render
    await expect(page.locator("text=/Due:/")).toBeVisible({ timeout: 10000 });
    // The lab-adjusted due date only resolves once the student's user role (lab_section_id),
    // lab sections, and lab-section meetings have all loaded and the memo recomputes. Under
    // webkit + CI contention that chain can take longer than the 20s default, so give it room.
    await expect(
      page.getByText(formatDateForTest(new TZDate(expectedLabAssignmentDueDate, "America/New_York")))
    ).toBeVisible({ timeout: 35_000 });
    await page.getByRole("button", { name: "Extend Due Date" }).click();
    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();
    // The dialog closes only after assignmentDueDateExceptions.create() resolves — an insert
    // whose response waits on DB triggers (gradebook recalc, etc.) and can stall badly under
    // CI load, especially on webkit. Rather than asserting on the incidental dialog teardown
    // (which then hangs the timeout), wait for the page's applied-extension indicator, which
    // confirms the write landed and the due date recomputed. This also leaves the dialog gone
    // before the date assertion below, avoiding a strict-mode clash with the dialog's preview.
    await expect(page.getByText(/extension applied/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(
      page
        .getByText(formatDateForTest(addHours(new TZDate(expectedLabAssignmentDueDate, "America/New_York"), 24)))
        .and(page.locator(':not([role="dialog"] *)'))
    ).toBeVisible();

    //Test with the non-lab section assignment
    await link.click();
    await page.getByRole("link", { name: testAssignment!.title }).click();

    await expect(page.getByText("This is a test assignment for E2E testing")).toBeVisible();
    await expect(page.getByText(formatDateForTest(new TZDate(assignmentDueDate, "America/New_York")))).toBeVisible();
    await page.getByRole("button", { name: "Extend Due Date" }).click();
    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();
    // The dialog closes only after assignmentDueDateExceptions.create() resolves — an insert
    // whose response waits on DB triggers (gradebook recalc, etc.) and can stall badly under
    // CI load, especially on webkit. Rather than asserting on the incidental dialog teardown
    // (which then hangs the timeout), wait for the page's applied-extension indicator, which
    // confirms the write landed and the due date recomputed. This also leaves the dialog gone
    // before the date assertion below, avoiding a strict-mode clash with the dialog's preview.
    await expect(page.getByText(/extension applied/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(
      page
        .getByText(formatDateForTest(addHours(new TZDate(assignmentDueDate, "America/New_York"), 24)))
        .and(page.locator(':not([role="dialog"] *)'))
    ).toBeVisible();

    //Test with the group assignment
    await link.click();
    await page.getByRole("link", { name: testGroupAssignment!.title }).click();

    await expect(page.getByText("This is a test group assignment for E2E testing")).toBeVisible();
    await expect(
      page.getByText(formatDateForTest(new TZDate(groupAssignmentDueDate, "America/New_York")))
    ).toBeVisible();
    await page.getByRole("button", { name: "Extend Due Date" }).click();
    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();
    // The dialog closes only after assignmentDueDateExceptions.create() resolves — an insert
    // whose response waits on DB triggers (gradebook recalc, etc.) and can stall badly under
    // CI load, especially on webkit. Rather than asserting on the incidental dialog teardown
    // (which then hangs the timeout), wait for the page's applied-extension indicator, which
    // confirms the write landed and the due date recomputed. This also leaves the dialog gone
    // before the date assertion below, avoiding a strict-mode clash with the dialog's preview.
    await expect(page.getByText(/extension applied/i).first()).toBeVisible({ timeout: 45_000 });
    await expect(
      page
        .getByText(formatDateForTest(addHours(new TZDate(groupAssignmentDueDate, "America/New_York"), 24)))
        .and(page.locator(':not([role="dialog"] *)'))
    ).toBeVisible();
    await assertStudentPageAccessible(page, "due dates after token extensions");
  });
});

test.describe("Due Date Exceptions & Extensions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions`);
  });
  test("Edit Late Token Allocation works correctly", async ({ page }) => {
    await expect(
      page.getByText(`Current Setting: Each student receives ${course.late_tokens_per_student} late tokens`).first()
    ).toBeVisible();
    const newLateTokenAllocation = course.late_tokens_per_student + 2;
    await page.getByRole("button", { name: "Edit Late Token Allocation" }).click();
    await page.locator('input[name="late_tokens_per_student"]').fill(newLateTokenAllocation.toString());
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(
      page.getByText(`Current Setting: Each student receives ${newLateTokenAllocation} late tokens`).first()
    ).toBeVisible();
  });
  test("Assignment Due Date Exceptions work correctly", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();
    // Test adding a due date exception for a student for a given assignment
    const globalAddExceptionButton = page.getByRole("button", { name: "Add Exception" }).first();
    await globalAddExceptionButton.click();
    const addExceptionModal = page.getByRole("dialog");
    await addExceptionModal
      .locator("div")
      .filter({ hasText: /^Select assignment$/ })
      .first()
      .click();
    await page.getByRole("option", { name: testAssignment!.title }).click();
    await addExceptionModal
      .locator("div")
      .filter({ hasText: /^Select student$/ })
      .first()
      .click();
    await page.getByRole("option", { name: student2!.private_profile_name }).click();
    const hours = 24;
    const tokensConsumed = 1;
    await addExceptionModal.locator('input[name="hours"]').fill(hours.toString());
    await addExceptionModal.locator('input[name="tokens_consumed"]').fill(tokensConsumed.toString());
    const note = "This is a test exception";
    await addExceptionModal.getByPlaceholder("Optional note").fill(note);
    await addExceptionModal.getByRole("button", { name: "Add Exception" }).click();
    // The consolidated due-date exceptions table now renders rows as:
    //   Assignment | Student/Group (with "Individual exception" subtext) | Hours | Minutes | Tokens | Grantor | Note | Date | Actions
    // Use the note (unique to this row) as the anchor for substring matching.
    const exceptionRow = page
      .getByRole("row")
      .filter({ hasText: note })
      .filter({ hasText: student2!.private_profile_name });
    await expect(exceptionRow).toBeVisible();
    await expect(exceptionRow).toContainText(testAssignment!.title);
    await expect(exceptionRow).toContainText("Individual exception");
    await expect(exceptionRow).toContainText(String(hours));
    await expect(exceptionRow).toContainText(String(tokensConsumed));
    await expect(exceptionRow).toContainText(instructor!.private_profile_name);
    // Test Delete
    await exceptionRow.getByRole("button", { name: "Delete exception" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await expect(exceptionRow).not.toBeVisible();
    // Test Gift Tokens to a student
    await page.getByRole("button", { name: "Gift Tokens" }).click();
    const giftTokensModal = page.getByRole("dialog");
    await giftTokensModal
      .locator("div")
      .filter({ hasText: /^Select assignment$/ })
      .first()
      .click();
    await page.getByRole("option", { name: testAssignment!.title }).click();
    await giftTokensModal
      .locator("div")
      .filter({ hasText: /^Select student$/ })
      .first()
      .click();
    await page.getByRole("option", { name: student2!.private_profile_name }).click();
    const tokensGifted = 13;
    await giftTokensModal.locator('input[type="number"]').fill(tokensGifted.toString());
    await giftTokensModal.getByRole("button", { name: "Gift Tokens" }).click();
    const giftRow = page
      .getByRole("row")
      .filter({ hasText: "Tokens gifted by instructor" })
      .filter({ hasText: student2!.private_profile_name });
    await expect(giftRow).toBeVisible();
    await expect(giftRow).toContainText(String(-tokensGifted));
    await expect(giftRow).toContainText(instructor!.private_profile_name);
    // Clean up
    await giftRow.getByRole("button", { name: "Delete exception" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
  });
  test("Student Due Date Extensions work correctly", async ({ page }) => {
    // The Chakra `Button asChild` wrapping NextLink in the nav doesn't reliably
    // fire client-side navigation under Playwright in this env, so navigate by URL.
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions/student-extensions`);
    await expect(page.getByRole("heading", { name: "Student-Wide Extensions" })).toBeVisible();
    await page.getByRole("button", { name: "Add Extension" }).click();
    const addExtensionModal = page.getByRole("dialog");
    await addExtensionModal
      .locator("div")
      .filter({ hasText: /^Select student$/ })
      .first()
      .click();
    await page.getByRole("option", { name: student2!.private_profile_name }).click();
    const hours = 24;
    await addExtensionModal.locator('input[name="hours"]').fill(hours.toString());
    await addExtensionModal.getByRole("button", { name: "Add Extension" }).click();
    // create() waits on DB triggers that backfill assignment exceptions; the dialog
    // only closes after that resolves. Wait for the success toast (write landed)
    // rather than dialog teardown, which can race webkit's exit animation.
    await expect(page.getByText("Extension added")).toBeVisible();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} No`
      })
    ).toBeVisible();
    // Check that the extension is applied to the consolidated assignment exceptions table.
    // The single virtualized table includes auto-generated rows with the instructor-granted note.
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions`);
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();
    await expect(page.getByText("Loading exceptions...")).toBeHidden();

    // The student-deadline-extension trigger creates per-assignment exceptions
    // keyed by `student_id` — even for group assignments — so each row renders as
    // an "Individual exception" for student2 in the consolidated table.
    const autoExceptionNote = "Instructor-granted extension for all assignments in class";
    const individualAutoRow = page
      .getByRole("row")
      .filter({ hasText: autoExceptionNote })
      .filter({ hasText: testAssignment!.title })
      .filter({ hasText: student2!.private_profile_name })
      .filter({ hasText: "Individual exception" });
    await expect(individualAutoRow.first()).toBeVisible();
    await expect(individualAutoRow.first()).toContainText(String(hours));

    const groupAutoRow = page
      .getByRole("row")
      .filter({ hasText: autoExceptionNote })
      .filter({ hasText: testGroupAssignment!.title })
      .filter({ hasText: student2!.private_profile_name });
    await expect(groupAutoRow.first()).toBeVisible();
    await expect(groupAutoRow.first()).toContainText(String(hours));

    // Test Delete of the student-wide extension itself
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions/student-extensions`);
    const studentExtRow = page.getByRole("row", {
      name: `${student2!.private_profile_name} ${hours} No`
    });
    await studentExtRow.getByLabel("Delete").click();
    const confirmDialog = page.getByRole("alertdialog");
    await page.getByRole("button", { name: "Confirm action" }).click();
    // alertdialog unmounts cleanly on dismiss (unlike the regular dialog used
    // earlier in this test), so visibility resolves correctly to "not found".
    await expect(confirmDialog).not.toBeVisible();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} No`
      })
    ).not.toBeVisible();
    // Deleting the student-wide extension should not retroactively delete pre-existing assignment exceptions
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions`);
    await expect(page.getByText("Loading exceptions...")).toBeHidden();
    await expect(individualAutoRow.first()).toBeVisible();
  });

  test("Group-level exception displays group name and members", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();

    // Insert a group-level exception for the group assignment
    const hours = 12;
    const note = "Group-level exception for test";
    const { error: insertError } = await supabase.from("assignment_due_date_exceptions").insert({
      class_id: course.id,
      assignment_id: testGroupAssignment!.id,
      assignment_group_id: assignmentGroup!.id,
      creator_id: instructor!.private_profile_id,
      hours: hours,
      minutes: 0,
      tokens_consumed: 0,
      note
    });
    if (insertError) {
      throw new Error(`Failed to insert group-level exception: ${insertError.message}`);
    }

    // Reload the page
    await page.reload();

    // The consolidated exceptions table is unique by note. The "Student / Group" cell
    // shows the group label plus a details line listing every group member.
    const groupRow = page
      .getByRole("row")
      .filter({ hasText: /Group-level exception for test/ })
      .filter({ hasText: testGroupAssignment!.title });
    await expect(groupRow).toBeVisible();
    await expect(groupRow).toContainText("Group: Test Group 1");
    await expect(groupRow).toContainText(student!.private_profile_name);
    await expect(groupRow).toContainText(student2!.private_profile_name);

    // Clean up by deleting the inserted group-level exception via UI
    await groupRow.getByRole("button", { name: "Delete exception" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await expect(groupRow).not.toBeVisible();
  });

  test("Roster Tokens displays per-student token usage including group exceptions", async ({ page }) => {
    // Insert exceptions that use up tokens using the UI
    const globalAddExceptionButton = page.getByRole("button", { name: "Add Exception" }).first();
    await globalAddExceptionButton.click();
    const addExceptionModal = page.getByRole("dialog");
    await addExceptionModal
      .locator("div")
      .filter({ hasText: /^Select assignment$/ })
      .first()
      .click();
    await page.getByRole("option", { name: testAssignment!.title }).click();
    await addExceptionModal
      .locator("div")
      .filter({ hasText: /^Select student$/ })
      .first()
      .click();
    await page.getByRole("option", { name: student2!.private_profile_name }).click();
    const hours = 24;
    const tokensConsumed = 2;
    await addExceptionModal.locator('input[name="hours"]').fill(hours.toString());
    await addExceptionModal.locator('input[name="tokens_consumed"]').fill(tokensConsumed.toString());
    const note = "This is a test exception";
    await addExceptionModal.getByPlaceholder("Optional note").fill(note);
    await addExceptionModal.getByRole("button", { name: "Add Exception" }).click();
    // Wait for the exception to appear in the consolidated table before navigating away
    // so the in-flight insert finishes before we leave the page.
    await expect(
      page.getByRole("row").filter({ hasText: note }).filter({ hasText: student2!.private_profile_name }).first()
    ).toBeVisible();
    // Navigate to the Roster Tokens tab (use goto: see note in "Student Due Date Extensions" test).
    await page.goto(`/course/${course.id}/manage/course/due-date-extensions/roster-tokens`);
    await expect(page.getByRole("heading", { name: "Roster Tokens" })).toBeVisible();

    const student1Row = page.getByRole("row").filter({ has: page.getByText(student!.email) });
    await expect(student1Row).toBeVisible();
    await expect(student1Row.getByRole("cell").nth(1)).toHaveText("0");
    await expect(student1Row.getByRole("cell").nth(2)).toHaveText("10");

    const student2Row = page.getByRole("row").filter({ has: page.getByText(student2!.email) });
    await expect(student2Row).toBeVisible();
    await expect(student2Row.getByRole("cell").nth(1)).toHaveText("2");
    await expect(student2Row.getByRole("cell").nth(2)).toHaveText("8");
  });
});
