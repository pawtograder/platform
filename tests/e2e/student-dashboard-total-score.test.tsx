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

dotenv.config({ path: ".env.local" });

test.describe("Student assignments dashboard score display", () => {
  test("shows total score when grading is complete, not autograder-only", async ({ page }) => {
    const course: Course = await createClass();
    const [student] = await createUsersInClass([
      {
        name: "Dashboard Total Student",
        email: "dashboard-total-student@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: "Dashboard Total Score Assignment"
    });

    const { grading_review_id } = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Pre-baked submission uses autograder 5/10; final grade after hand-grading differs.
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

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`, { waitUntil: "networkidle", timeout: 30000 });

    await expect(page.getByRole("link", { name: new RegExp(`#\\d+ \\(${finalTotal}/100\\)`) })).toBeVisible();
    // Would incorrectly pass if the UI still showed only autograder (5/10).
    await expect(page.getByRole("link", { name: "#1 (5/10)" })).not.toBeVisible();
  });
});
