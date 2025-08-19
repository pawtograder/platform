import { test, expect } from "@playwright/test";
import dotenv from "dotenv";
import { addDays } from "date-fns";
import { Assignment, Course, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { createClass, createUserInClass, insertAssignment, loginAsUser, TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

let course: Course | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricChecks: RubricCheck[] }) | undefined;

test.describe("Rubric points summary", () => {
  test.beforeAll(async () => {
    course = await createClass();
    instructor = await createUserInClass({ role: "instructor", class_id: course!.id });
    assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course!.id
    });
  });

  test("Shows assignment, autograder, and rubric points with status", async ({ page }) => {
    await loginAsUser(page, instructor!, course!);
    await page.goto(`/course/${course!.id}/manage/assignments/${assignment!.id}/rubric`);

    const summary = page.getByRole("region", { name: "Rubric points summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByText(/Assignment max points:\s*100/)).toBeVisible();
    await expect(summary.getByText(/Autograder points:\s*100/)).toBeVisible();
    await expect(summary.getByText(/Grading rubric points:\s*20/)).toBeVisible();
    // 100 !== 100 + 20, so expect the warning state text
    await expect(summary.getByText(/These do not add up\./)).toBeVisible();
  });
});