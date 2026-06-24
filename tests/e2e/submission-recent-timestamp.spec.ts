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
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Verifies #103b: the most recent submission time is visible in the header without opening the
// Submission History popover.

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "TS Student",
      email: "ts-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "TS Instructor",
      email: "ts-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Timestamp Assignment"
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

test.describe("Recent submission timestamp in header (#103b)", () => {
  test.setTimeout(120_000);

  test("shows the submission time without opening Submission History", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });

    // The relative "Submitted …" text is in the header — visible immediately, before opening history.
    const submitted = page.getByText(/^· Submitted /).first();
    await expect(submitted).toBeVisible();

    // It reflects the active submission's created_at and is not the history-table content (which only
    // appears after opening the history popover — "Auto Grader Score" is a history-table column header).
    await expect(page.getByText("Auto Grader Score")).toHaveCount(0);
  });
});
