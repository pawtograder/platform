import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// The submission file viewer defaults to the new Monaco editor, but a per-user "New editor view"
// toggle can switch to the classic view; the choice persists to users.preferences.grading.useMonacoEditor.

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Toggle Student",
      email: "toggle-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Toggle Instructor",
      email: "toggle-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Editor Toggle Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Grading editor view toggle", () => {
  test.setTimeout(120_000);

  test("defaults to the Monaco editor and can be switched to the classic view (persisted)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();

    // Default: the new Monaco editor renders (no preference was set for this user).
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Turn it off via the "New editor view" toggle → classic view (no Monaco), code still shown.
    const toggle = page.getByText("New editor view");
    await toggle.click();
    await expect(page.locator(".monaco-editor")).toHaveCount(0);
    await expect(page.getByText("Hello, World!").first()).toBeVisible();

    // The preference persisted to the DB.
    await expect
      .poll(async () => {
        const { data, error } = await supabase
          .from("users")
          .select("preferences")
          .eq("user_id", instructor!.user_id)
          .single();
        if (error) throw new Error(`Failed to read user preferences: ${error.message}`);
        return (data?.preferences as { grading?: { useMonacoEditor?: boolean } } | null)?.grading?.useMonacoEditor;
      })
      .toBe(false);

    // Turn it back on → Monaco returns.
    await toggle.click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
  });
});
