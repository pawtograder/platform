import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";

dotenv.config({ path: ".env.local", quiet: true });

test.describe("Student assignments dashboard score display", () => {
  test("Latest Submission shows autograder while pending, then total after grading completes", async ({ page }) => {
    const course: Course = await createClass();
    const [student] = await createUsersInClass([
      {
        name: "Dashboard Score Student",
        email: "dashboard-score-student@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: "Dashboard Score Assignment"
    });

    const { grading_review_id } = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`, { waitUntil: "networkidle", timeout: 30000 });

    await expect(page.getByRole("link", { name: "#1 (5/10)" })).toBeVisible();

    const finalTotal = 88;
    const { error: reviewError } = await supabase
      .from("submission_reviews")
      .update({
        completed_at: new Date().toISOString(),
        total_score: finalTotal,
        released: true
      })
      .eq("id", grading_review_id);
    if (reviewError) {
      throw new Error(`Failed to update grading review: ${reviewError.message}`);
    }

    await page.reload({ waitUntil: "networkidle", timeout: 30000 });

    await expect(page.getByRole("link", { name: new RegExp(`#\\d+ \\(${finalTotal}/100\\)`) })).toBeVisible();
    await expect(page.getByRole("link", { name: "#1 (5/10)" })).not.toBeVisible();
    await assertStudentPageAccessible(page, "student assignments dashboard after grading");
  });
});
