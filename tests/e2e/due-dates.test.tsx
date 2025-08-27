import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { test, expect } from "../global-setup";
import { addDays, addHours, previousMonday } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  createClass,
  createLabSectionWithStudents,
  createUsersInClass,
  insertAssignment,
  loginAsUser,
  TestingUser
} from "./TestingUtils";

let course: Course;
let student: TestingUser | undefined;
let student2: TestingUser | undefined;
let instructor: TestingUser | undefined;
let labLeader: TestingUser | undefined;
let testAssignment: Assignment | undefined;
let testLabAssignment: Assignment | undefined;

const assignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
assignmentDueDate.setHours(9, 0, 0, 0);
const labAssignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
labAssignmentDueDate.setHours(10, 0, 0, 0);
test.beforeAll(async () => {
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
      name: "Due Dates Student",
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
});
const expectedLabAssignmentDueDate =
  labAssignmentDueDate.getDay() === 1 ? labAssignmentDueDate : previousMonday(labAssignmentDueDate);
expectedLabAssignmentDueDate.setHours(5, 42, 0, 0);

function getDueDateString(date: Date) {
  return formatInTimeZone(date, "America/New_York", "MMM d h:mm aaa");
}
function getDueDateShortString(date: Date) {
  return formatInTimeZone(date, "America/New_York", "MM/dd/yyyy, h:mm a");
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
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const link = page.getByRole("link").filter({ hasText: "Assignments" });
    await link.click();
    //Wait for the page to load to avoid race condition
    await expect(page).toHaveURL(/\/assignments\b/);
    await expect(page.getByText(testAssignment!.title)).toBeVisible();
    const cell = page.getByRole("cell", { name: testAssignment!.title });
    await expect(cell).toBeVisible();

    const row = page.getByRole("row").filter({ has: cell });
    await expect(
      row.getByText(getDueDateString(new TZDate(testAssignment!.due_date, "America/New_York")))
    ).toBeVisible();

    const labRow = page.getByRole("row").filter({ has: page.getByText(testLabAssignment!.title) });
    await expect(
      labRow.getByText(getDueDateString(new TZDate(expectedLabAssignmentDueDate, "America/New_York")))
    ).toBeVisible();
  });
  test("When students extend their due date, the due date is updated on the assignments page", async ({ page }) => {
    //Test with the lab section assignment
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const link = page.getByRole("link").filter({ hasText: "Assignments" });
    await link.click();
    //Wait for the page to load to avoid race condition
    await expect(page).toHaveURL(/\/assignments\b/);
    await page.getByRole("link", { name: testLabAssignment!.title }).click();

    await expect(page.getByText("This is a test assignment for E2E testing")).toBeVisible();
    await expect(
      page.getByText(getDueDateString(new TZDate(expectedLabAssignmentDueDate, "America/New_York")))
    ).toBeVisible();
    await page.getByRole("button", { name: "Extend Due Date" }).click();
    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();
    await expect(
      page.getByText(getDueDateString(addHours(new TZDate(expectedLabAssignmentDueDate, "America/New_York"), 24)))
    ).toBeVisible();

    //Test with the non-lab section assignment
    await link.click();
    await page.getByRole("link", { name: testAssignment!.title }).click();

    await expect(page.getByText("This is a test assignment for E2E testing")).toBeVisible();
    await expect(page.getByText(getDueDateString(new TZDate(assignmentDueDate, "America/New_York")))).toBeVisible();
    await page.getByRole("button", { name: "Extend Due Date" }).click();
    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();
    await expect(
      page.getByText(getDueDateString(addHours(new TZDate(assignmentDueDate, "America/New_York"), 24)))
    ).toBeVisible();
  });
});

test.describe("Due Date Exceptions & Extensions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Due Date Extensions" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Due Date Extensions" }).click();
  });
  test("Edit Late Token Allocation works correctly", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Due Date Extensions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Due Date Exceptions Management" })).toBeVisible();
    await expect(page.getByText(`Manage late tokens and due date exceptions for ${course.name}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Class Late Token Settings" })).toBeVisible();
    await expect(page.getByText("Configure how many late tokens each student gets in this class.")).toBeVisible();
    await expect(
      page.getByText(`Current Setting: Each student receives ${course.late_tokens_per_student} late tokens`)
    ).toBeVisible();
    const newLateTokenAllocation = course.late_tokens_per_student + 2;
    await page.getByRole("button", { name: "Edit Late Token Allocation" }).click();
    await page.locator('input[name="late_tokens_per_student"]').fill(newLateTokenAllocation.toString());
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(
      page.getByText(`Current Setting: Each student receives ${newLateTokenAllocation} late tokens`)
    ).toBeVisible();
  });
  test("Assignment Due Date Exceptions work correctly", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();
    // Test adding a due date exception for a student for a given assignment
    await page.getByRole("button", { name: "Add Exception" }).click();
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
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} 0 ${tokensConsumed} ${instructor!.private_profile_name} ${note}`
      })
    ).toBeVisible();
    // Test Delete
    await page
      .getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} 0 ${tokensConsumed} ${instructor!.private_profile_name} ${note}`
      })
      .getByLabel("Delete")
      .click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} 0 ${tokensConsumed} ${instructor!.private_profile_name} ${note}`
      })
    ).not.toBeVisible();
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
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} 0 0 ${-tokensGifted} ${instructor!.private_profile_name} Tokens gifted by instructor`
      })
    ).toBeVisible();
    // Clean up
    await page
      .getByRole("row", {
        name: `${student2!.private_profile_name} 0 0 ${-tokensGifted} ${instructor!.private_profile_name} Tokens gifted by instructor`
      })
      .getByLabel("Delete")
      .click();
    await page.getByRole("button", { name: "Confirm action" }).click();
  });
  test("Student Due Date Extensions work correctly", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();
    await page.getByText("Student Extensions").click();
    await expect(page.getByText("Due Date Extensions").first()).toBeVisible();
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
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} No`
      })
    ).toBeVisible();
    // Check that the extension is applied to the assignment exceptions
    await page.getByText("Assignment Exceptions").click();
    await expect(page.getByRole("heading", { name: "Assignment Due Date Exceptions" })).toBeVisible();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} 0 0 ${instructor!.private_profile_name} Class-wide extension applied by instructor`
      })
    ).toBeVisible();
    // Test Delete
    await page.getByText("Student Extensions").click();
    await page.getByText("Student Extensions").click();
    const studentExtRow = page.getByRole("row", {
      name: `${student2!.private_profile_name} ${hours} No`
    });
    await studentExtRow.getByLabel("Delete").click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} No`
      })
    ).not.toBeVisible();
    // Deleting the student-wide extension should not retroactively delete pre-existing assignment exceptions
    await page.getByText("Assignment Exceptions").click();
    await expect(
      page.getByRole("row", {
        name: `${student2!.private_profile_name} ${hours} 0 0 ${instructor!.private_profile_name} Class-wide extension applied by instructor`
      })
    ).toBeVisible();
  });
});
