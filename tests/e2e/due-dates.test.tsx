import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { expect, test } from "@playwright/test";
import { addDays, addMinutes, previousMonday } from "date-fns";
import {
  createLabSectionWithStudents,
  createUserInDemoClass,
  insertAssignment,
  loginAsUser,
  TestingUser,
  updateClassStartEndDates
} from "./TestingUtils";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";

let student: TestingUser | undefined;
let labLeader: TestingUser | undefined;
let testAssignment: Assignment | undefined;
let testLabAssignment: Assignment | undefined;
const course_id = 1;

const assignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
assignmentDueDate.setHours(9, 0, 0, 0);
const labAssignmentDueDate = addDays(new TZDate(new Date(), "America/New_York"), 14);
labAssignmentDueDate.setHours(10, 0, 0, 0);
test.beforeAll(async () => {
  await updateClassStartEndDates({
    class_id: 1,
    start_date: addDays(new Date(), -30).toUTCString(),
    end_date: addDays(new Date(), 90).toUTCString()
  });
  labLeader = await createUserInDemoClass({ role: "grader" });
  student = await createUserInDemoClass({ role: "student" });
  await createLabSectionWithStudents({
    lab_leader: labLeader,
    day_of_week: "monday",
    students: [student],
    start_time: "04:00",
    end_time: "05:00"
  });
  testAssignment = await insertAssignment({
    due_date: assignmentDueDate.toUTCString()
  });
  testLabAssignment = await insertAssignment({
    due_date: labAssignmentDueDate.toUTCString(),
    lab_due_date_offset: 42
  });
});
const expectedLabAssignmentDueDate = previousMonday(labAssignmentDueDate);
expectedLabAssignmentDueDate.setHours(5, 42, 0, 0);

function getDueDateString(date: Date) {
  return formatInTimeZone(date, "America/New_York", "MMM d h:mm aaa");
}
test.describe("Lab-section assignment due dates are special", () => {
  test("Lab-section assignment due dates are calculated correctly", async ({ page }) => {
    await loginAsUser(page, student!);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const link = page.getByRole("link").filter({ hasText: "Assignments" });
    await link.click();
    await expect(page.getByText(testAssignment!.title)).toBeVisible();
    const cell = page.getByRole("cell", { name: testAssignment!.title });
    await expect(cell).toBeVisible();

    const row = page.getByRole("row").filter({ has: cell });
    await expect(row.getByText(getDueDateString(new TZDate(testAssignment!.due_date, "America/New_York")))).toBeVisible();
    
    const labRow = page.getByRole("row").filter({ has: page.getByText(testLabAssignment!.title) });
    await expect(labRow.getByText(getDueDateString(new TZDate(expectedLabAssignmentDueDate, "America/New_York")))).toBeVisible();
  });
});
test.describe("Instructors can edit due date extensions", () => {
  test("Instructors can edit due date extensions", async ({ page }) => {
    // await page.goto("/");
    // await page.getByRole("textbox", { name: "Sign in email" }).click();
    // await page.getByRole("textbox", { name: "Sign in email" }).fill(instructor_email);
    // await page.getByRole("textbox", { name: "Sign in email" }).press("Tab");
    // await page.getByRole("textbox", { name: "Sign in password" }).fill(password);
    // await page.getByRole("textbox", { name: "Sign in password" }).press("Enter");
    // await page.getByRole("button", { name: "Sign in with email" }).click();
  });
});
