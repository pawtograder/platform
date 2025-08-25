import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { expect, test } from "@playwright/test";
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
let labLeader: TestingUser | undefined;
let testAssignment: Assignment | undefined;
let testLabAssignment: Assignment | undefined;

const assignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
assignmentDueDate.setHours(9, 0, 0, 0);
const labAssignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
labAssignmentDueDate.setHours(10, 0, 0, 0);
test.beforeAll(async () => {
  course = await createClass();
  [labLeader, student] = await createUsersInClass([
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
