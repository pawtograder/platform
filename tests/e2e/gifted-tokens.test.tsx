import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { test, expect } from "@/global-setup";
import { addDays, addHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  loginAsUser,
  TestingUser,
  supabase,
  generateMagicLink
} from "@/tests/e2e/TestingUtils";

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignments: Assignment[] = [];

const NUM_INITIAL_TOKENS = 4;
const NUM_ASSIGNMENTS_TO_USE_TOKENS = 4;
const TOKENS_TO_GIFT = 1;

function getDueDateString(date: Date) {
  return formatInTimeZone(date, "America/New_York", "MMM d, h:mm a zzz");
}

test.beforeEach(async () => {
  course = await createClass({ name: "Gifted Token Test Class" });

  const { data: updatedClasses, error: lateTokensUpdateError } = await supabase
    .from("classes")
    .update({ late_tokens_per_student: NUM_INITIAL_TOKENS })
    .eq("id", course.id)
    .select("id");
  if (lateTokensUpdateError) {
    throw new Error(`Failed to set late_tokens_per_student: ${lateTokensUpdateError.message}`);
  }
  if (!updatedClasses?.length) {
    throw new Error("Failed to set late_tokens_per_student: no rows updated");
  }
  course.late_tokens_per_student = NUM_INITIAL_TOKENS;

  [student, instructor] = await createUsersInClass([
    {
      name: "Gifted Token Student",
      email: "gifted-token-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Gifted Token Instructor",
      email: "gifted-token-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  assignments = [];
  for (let i = 0; i < NUM_ASSIGNMENTS_TO_USE_TOKENS + 1; i++) {
    const dueDate = addDays(new TZDate(new Date(), "America/New_York"), 14 + i);
    dueDate.setHours(9 + i, 0, 0, 0);
    const assignment = await insertAssignment({
      due_date: dueDate.toUTCString(),
      class_id: course.id,
      name: `Token Test Assignment ${i + 1}`
    });
    assignments.push(assignment);
  }

  for (let i = 0; i < NUM_ASSIGNMENTS_TO_USE_TOKENS; i++) {
    const { error } = await supabase.from("assignment_due_date_exceptions").insert({
      assignment_id: assignments[i].id,
      student_id: student!.private_profile_id,
      class_id: course.id,
      creator_id: student!.private_profile_id,
      hours: 24,
      minutes: 0,
      tokens_consumed: 1
    });
    if (error) {
      throw new Error(`Failed to create due date exception for assignment ${i + 1}: ${error.message}`);
    }
  }

  const { error: giftError } = await supabase.from("assignment_due_date_exceptions").insert({
    assignment_id: assignments[0].id,
    student_id: student!.private_profile_id,
    class_id: course.id,
    creator_id: instructor!.private_profile_id,
    hours: 0,
    minutes: 0,
    tokens_consumed: -TOKENS_TO_GIFT,
    note: "Gifted token for testing"
  });
  if (giftError) {
    throw new Error(`Failed to gift tokens: ${giftError.message}`);
  }
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== "failed") return;
  for (const user of [student, instructor].filter(Boolean)) {
    console.log(`\nFailed test - login as ${user!.email}: ${await generateMagicLink(user!)}`);
  }
});
test.describe("Gifted tokens bug (#648)", () => {
  test("Student with gifted tokens can still see and apply remaining tokens", async ({ page }) => {
    const lastAssignment = assignments[NUM_ASSIGNMENTS_TO_USE_TOKENS];

    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await expect(page).toHaveURL(/\/assignments\b/);

    await page.getByRole("link", { name: lastAssignment.title }).click();
    await expect(page.getByText("This is a test assignment for E2E testing")).toBeVisible();
    await expect(page.locator("text=/Due:/")).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("You have no remaining late tokens")).not.toBeVisible();

    await expect(page.getByRole("button", { name: "Extend Due Date" })).toBeVisible();
    await page.getByRole("button", { name: "Extend Due Date" }).click();

    await expect(page.getByText("You can extend the due date for this assignment")).toBeVisible();
    await expect(page.getByText(`You have ${TOKENS_TO_GIFT} late tokens remaining`)).toBeVisible();

    await page.getByRole("button", { name: "Consume a late token for a 24" }).click();

    const expectedDueDate = addHours(new TZDate(lastAssignment.due_date, "America/New_York"), 24);
    await expect(page.getByText(getDueDateString(expectedDueDate))).toBeVisible();
  });
});
