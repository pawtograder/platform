import { test, expect } from "@playwright/test";
import dotenv from "dotenv";
import { addDays } from "date-fns";
import { Assignment, Course, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { createClass, createUserInClass, insertAssignment, loginAsUser, TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

let course: Course | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;

test.describe("Rubric editor", () => {
  test.beforeAll(async () => {
    course = await createClass();
    instructor = await createUserInClass({ role: "instructor", class_id: course!.id });
    assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course!.id
    });
  });

  test("Shows assignment, autograder, and rubric points with status", async ({ page }) => {
    await loginAsUser(page, instructor!);
    await page.waitForURL(`/course`)

    await page.goto(`/course/${course!.id}/manage/assignments/${assignment!.id}/rubric`);

    const summary = page.getByRole("region", { name: "Grading Rubric Points Summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByText(/The assignment's max points is set to 100/)).toBeVisible();
    await expect(summary.getByText(/autograder is currently configured to award up to 100 points/)).toBeVisible();
    await expect(summary.getByText(/grading rubric is configured to award 20 points/)).toBeVisible();
    // 100 !== 100 + 20, so expect the warning state text
    await expect(summary.getByText(/These do not add up/)).toBeVisible();

    // Also make sure that the checks are rendered in the wysiwg
    const rubricSidebar = page.getByRole("region", { name: "Rubric Part: Grading Review" });
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
});
