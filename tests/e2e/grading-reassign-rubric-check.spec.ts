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

// A grader editing a rubric-check annotation can reassign it to a DIFFERENT check in the same rubric,
// which also resets the comment's points to the new check's value. We add a second annotation check
// (different points) to the grading rubric so there's a real alternative to switch to.

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;
let check1: RubricCheck | undefined;
let altCheckId: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Reassign Student",
      email: "reassign-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Reassign Instructor",
      email: "reassign-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Reassign Check Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;

  check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;
  // Add a sibling annotation check in the same criteria with DIFFERENT points (4 vs check1's 10).
  const { data: alt, error } = await supabase
    .from("rubric_checks")
    .insert({
      rubric_criteria_id: check1.rubric_criteria_id,
      name: "Grading Review Check Alt",
      description: "Alternate annotation check",
      ordinal: 5,
      points: 4,
      is_annotation: true,
      is_comment_required: false,
      class_id: course.id,
      is_required: false,
      assignment_id: assignment!.id,
      rubric_id: check1.rubric_id
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to insert alt check: ${error.message}`);
  altCheckId = alt!.id;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Reassign a rubric-check annotation to a different check", () => {
  test.setTimeout(120_000);

  test("editing a check annotation can change its check, updating the points", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Apply "Grading Review Check 1" (10 pts) on the cursor line via the quick-apply palette.
    await page.locator(".view-line", { hasText: "main" }).first().click();
    await page.locator(".monaco-editor textarea.inputarea").first().focus();
    await page.keyboard.press("ControlOrMeta+Period");
    const palette = page.getByRole("dialog", { name: "Quick-apply rubric check" });
    await expect(palette).toBeVisible();
    await palette.getByRole("textbox", { name: "Search rubric checks" }).fill("Grading Review Check 1");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();

    // The comment exists with check1 + 10 points.
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("rubric_check_id, points")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", check1!.id);
        return data?.[0]?.points ?? null;
      })
      .toBe(10);

    // Open the comment's actions menu → Edit.
    await page.locator('.view-zones button[aria-haspopup="menu"]').first().click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    // Reassign to the alternate check via the new selector.
    const selector = page.getByLabel("Change rubric check");
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await selector.selectOption({ value: String(altCheckId) });

    // The comment is now associated with the alt check and its points reset to 4.
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("rubric_check_id, points")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", altCheckId!);
        return data?.[0] ? { id: data[0].rubric_check_id, points: data[0].points } : null;
      })
      .toEqual({ id: altCheckId, points: 4 });
  });
});
