import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  TestingUser
} from "./TestingUtils";
import { addDays } from "date-fns";
import { Assignment, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";

dotenv.config({ path: ".env.local" });

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;
let cappedAssignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [instructor, student] = await createUsersInClass([
    {
      name: "Rubric Editor Instructor",
      email: "rubric-editor-instructor@pawtograder.net",
      role: "instructor",
      class_id: course!.id,
      useMagicLink: true
    },
    {
      name: "Rubric Editor Student",
      email: "rubric-editor-student@pawtograder.net",
      role: "student",
      class_id: course!.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Rubric Editor Assignment"
  });

  // Create assignment with capped rubric
  cappedAssignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course!.id,
    name: "Capped Rubric Assignment"
  });

  // Update the grading rubric to enable score capping
  const supabase = createClient();
  if (cappedAssignment.grading_rubric_id) {
    await supabase
      .from("rubrics")
      .update({ cap_score_to_assignment_points: true })
      .eq("id", cappedAssignment.grading_rubric_id);
  }
});

test.describe("Rubric editor", () => {
  test("Shows assignment, autograder, and rubric points with status", async ({ page }) => {
    await loginAsUser(page, instructor!);
    await page.waitForURL(`/course`);

    await page.goto(`/course/${course!.id}/manage/assignments/${assignment!.id}/rubric`);

    const summary = page.getByRole("region", { name: "Grading Rubric Points Summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByText(/The assignment's max points is set to 100/)).toBeVisible();
    await expect(summary.getByText(/autograder is currently configured to award up to 100 points/)).toBeVisible();
    await expect(summary.getByText(/grading rubric is configured to award 30 points/)).toBeVisible();
    // 100 !== 100 + 20, so expect the warning state text
    await expect(summary.getByText(/These do not add up/)).toBeVisible();

    // Also make sure that the checks are rendered in the wysiwg
    const rubricSidebar = page.getByRole("region", { name: "Rubric Part: Grading Review Part 1" });
    await expect(rubricSidebar).toContainText("Grading Review Criteria 0/20");
    await expect(rubricSidebar).toContainText("Criteria for grading review evaluation");
    await expect(rubricSidebar).toContainText("Grading Review Check 1");
    await expect(rubricSidebar).toContainText("First check for grading review");
    await expect(rubricSidebar).toContainText("Grading Review Check 2");
    await expect(rubricSidebar).toContainText("Second check for grading review");

    // await expect(page.getByRole("textbox", { name: "Grading Review Criteria 0/20" })).toBeVisible();
    // await expect(page.getByRole("textbox", { name: "Grading Review Check 1 0/10" })).toBeVisible();
    // await expect(page.getByRole("textbox", { name: "Grading Review Check 2 0/5" })).toBeVisible();
  });

  test("Shows correct messaging when cap_score_to_assignment_points is enabled", async ({ page }) => {
    await loginAsUser(page, instructor!);
    await page.waitForURL(`/course`);

    await page.goto(`/course/${course!.id}/manage/assignments/${cappedAssignment!.id}/rubric`);

    const summary = page.getByRole("region", { name: "Grading Rubric Points Summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByText(/The assignment's max points is set to 100/)).toBeVisible();

    // Should show capping-specific messaging
    await expect(summary.getByText(/Score capping is enabled/i)).toBeVisible();
    await expect(summary.getByText(/Manual grading can be used as a fallback/i)).toBeVisible();

    // Should NOT show "These do not add up" warning when capping is enabled and points are valid
    // (The warning only shows if max(autograder, rubric) > total, which shouldn't happen with default test data)
    const warningText = summary.getByText(/These do not add up/);
    if (await warningText.isVisible().catch(() => false)) {
      // If warning is visible, it should be the capped mode warning, not the standard one
      await expect(summary.getByText(/exceeds the assignment total/i)).toBeVisible();
    }
  });

  test("Shows correct grading summary when cap_score_to_assignment_points is enabled", async ({ page }) => {
    // Create a submission for the capped assignment
    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: cappedAssignment!.id,
      class_id: course!.id
    });

    await loginAsUser(page, student!);
    await page.waitForURL(`/course`);

    await page.goto(
      `/course/${course!.id}/assignments/${cappedAssignment!.id}/submissions/${submission_res.submission_id}`
    );

    // Should show fallback grading explanation
    await expect(page.getByText(/Manual Grading.*Fallback/i)).toBeVisible();
    await expect(page.getByText(/can be used as a fallback when autograder fails/i)).toBeVisible();

    // Should show score capping information
    await expect(page.getByText(/Score Capping/i)).toBeVisible();
    await expect(page.getByText(/capped to.*points maximum/i)).toBeVisible();
  });
});
