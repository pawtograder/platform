/**
 * Visual walkthrough for issue #446: after a submission review is released,
 * graders lose the comment edit/delete menu; instructors keep it.
 * Saves PNGs under test-results/issue-446-walkthrough/ (gitignored).
 */
import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUserWithPassword,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local" });

const OUT_DIR = path.join(process.cwd(), "test-results", "issue-446-walkthrough");

let course: Course;
let student: TestingUser;
let student2: TestingUser;
let instructor: TestingUser;
let grader: TestingUser;
let submission_id: number;
let submission_id2: number;
let assignment: Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

const GRADER_COMMENT = "Issue 446 grader comment — visible until release";
const INSTRUCTOR_COMMENT = "Issue 446 instructor comment — instructor may edit after release";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  course = await createClass({ name: "Issue 446 Walkthrough Class" });
  [student, instructor, grader, student2] = await createUsersInClass([
    {
      name: "446 Student A",
      email: "issue446-student-a@pawtograder.net",
      role: "student",
      class_id: course.id
    },
    {
      name: "446 Instructor",
      email: "issue446-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id
    },
    {
      name: "446 Grader",
      email: "issue446-grader@pawtograder.net",
      role: "grader",
      class_id: course.id
    },
    {
      name: "446 Student B",
      email: "issue446-student-b@pawtograder.net",
      role: "student",
      class_id: course.id
    }
  ]);

  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Issue 446 Assignment"
  });

  const sub1 = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  submission_id = sub1.submission_id;

  const sub2 = await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  submission_id2 = sub2.submission_id;

  const review_assignment_res = await supabase
    .from("review_assignments")
    .insert({
      assignee_profile_id: grader.private_profile_id,
      class_id: course.id,
      assignment_id: assignment.id,
      submission_id: submission_id2,
      submission_review_id: sub2.grading_review_id!,
      rubric_id: assignment.grading_rubric_id!,
      due_date: addDays(new Date(), 1).toUTCString()
    })
    .select("id")
    .single();
  if (review_assignment_res.error) {
    throw new Error(`Failed to create review assignment: ${review_assignment_res.error.message}`);
  }
  await supabase.from("review_assignment_rubric_parts").insert({
    review_assignment_id: review_assignment_res.data!.id,
    rubric_part_id: assignment.rubricParts[2]!.id,
    class_id: course.id
  });
});

test("Walkthrough: grader menu before release, release, grader loses menu / instructor keeps", async ({ page }) => {
  test.setTimeout(180_000);
  // 1) Grader adds a rubric comment (submission B) while review is unreleased
  await loginAsUserWithPassword(page, grader, course);
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id2}/files`);
  await expect(page.getByText("public static void main(")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
    el.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.getByRole("checkbox", { name: /Grading Review Check 3/ }).click({ force: true });
  const graderCheckCommentBox = page.getByRole("textbox", {
    name: "Optional: comment on check Grading Review Check 3"
  });
  await graderCheckCommentBox.waitFor({ state: "visible", timeout: 15_000 });
  await graderCheckCommentBox.fill(GRADER_COMMENT);
  await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "Add Check" }).click();
  await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

  const graderRegionBefore = page
    .getByRole("region", { name: "Grading check Grading Review Check 3" })
    .filter({ hasText: GRADER_COMMENT });
  await expect(graderRegionBefore.getByRole("button")).not.toHaveCount(0);
  await graderRegionBefore.screenshot({ path: path.join(OUT_DIR, "01-grader-comment-menu-before-release.png") });

  // 2) Instructor adds a grading comment (submission A) and completes the grading review
  await loginAsUserWithPassword(page, instructor, course);
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/files`);
  await expect(page.getByText("public static void main(")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
    el.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.getByText("public static void main(").click({ button: "right" });
  await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
  await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(INSTRUCTOR_COMMENT);
  await page.getByRole("button", { name: "Add Check" }).click();
  await page.getByText("Annotate line 4 with a check:").waitFor({ state: "hidden" });

  // Required checks 2 and 3 (popover blocks "Mark as Complete" until all required checks are applied)
  await page.getByRole("checkbox", { name: /Grading Review Check 2/ }).click({ force: true });
  await page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 2" }).fill("req2");
  await page.getByRole("button", { name: "Add Check" }).click();
  await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

  await page.getByRole("checkbox", { name: /Grading Review Check 3/ }).click({ force: true });
  await page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" }).fill("req3");
  await page.getByRole("button", { name: "Add Check" }).click();
  await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Complete Review" }).click();
  await page.getByRole("button", { name: "Mark as Complete" }).click();
  await expect(page.getByText("Completed by")).toBeVisible({ timeout: 30_000 });

  const instructorRegionBefore = page.getByRole("region", { name: /Grading checks on line 4/ }).filter({
    hasText: INSTRUCTOR_COMMENT
  });
  await expect(instructorRegionBefore).toBeVisible();
  await instructorRegionBefore.screenshot({
    path: path.join(OUT_DIR, "02-instructor-comment-menu-before-release.png")
  });

  // 3) Release all submission reviews for the assignment
  await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}`);
  await page.getByRole("button", { name: "Release All Submission Reviews", exact: true }).click();
  await expect(page.getByRole("button", { name: "Release All Submission Reviews", exact: true })).toBeEnabled();

  // 4) Instructor still sees edit/delete (⋯) on their released comment
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id}/files`);
  await expect(page.getByText("Released to studentYes")).toBeVisible({ timeout: 30_000 });
  const instructorRegionAfter = page.getByRole("region", { name: /Grading checks on line 4/ }).filter({
    hasText: INSTRUCTOR_COMMENT
  });
  await expect(instructorRegionAfter.getByRole("button")).not.toHaveCount(0);
  await instructorRegionAfter.screenshot({ path: path.join(OUT_DIR, "03-instructor-comment-menu-after-release.png") });

  // 5) Grader no longer sees the comment action menu after release
  await loginAsUserWithPassword(page, grader, course);
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission_id2}/files`);
  await expect(page.getByText("public static void main(")).toBeVisible({ timeout: 60_000 });
  const graderRegionAfter = page
    .getByRole("region", { name: "Grading check Grading Review Check 3" })
    .filter({ hasText: GRADER_COMMENT });
  await expect(graderRegionAfter).toBeVisible();
  await expect(graderRegionAfter.getByRole("button")).toHaveCount(0);
  await graderRegionAfter.screenshot({ path: path.join(OUT_DIR, "04-grader-no-menu-after-release.png") });
});
