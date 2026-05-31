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

// Verifies #307 part 2, with the constraint that a grader may ONLY pick a score associated with the
// selected check — never an arbitrary number:
//   • For a check WITH sub-options, the applied score can be switched among those options in place
//     (no delete-and-reapply), and the new option's points persist.
//   • For a single-value check, there is NO score-entry control at all.

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;
let optionCheckId: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "ES Student",
      email: "es-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "ES Instructor",
      email: "es-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Editable Score Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;

  // Add an annotation check that defines sub-options (the only legitimate way to change a score).
  const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;
  const { data: optionCheck, error } = await supabase
    .from("rubric_checks")
    .insert({
      rubric_criteria_id: check1.rubric_criteria_id,
      name: "Severity Check",
      description: "Pick a severity",
      ordinal: 98,
      points: 0,
      is_annotation: true,
      is_comment_required: false,
      class_id: course.id,
      is_required: false,
      assignment_id: assignment!.id,
      rubric_id: assignment!.grading_rubric_id || 0,
      data: {
        options: [
          { label: "Minor", points: 2 },
          { label: "Major", points: 5 }
        ]
      }
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to insert option check: ${error.message}`);
  optionCheckId = optionCheck!.id;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

async function openFiles(page: Parameters<typeof loginAsUser>[0]) {
  await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
  await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText("public static void main(")).toBeVisible();
}

test.describe("Editable check score (#307, constrained to check-associated scores)", () => {
  test.setTimeout(120_000);

  test("a sub-option check's score can be switched among its options in place", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    // Apply the option check on line 4, choosing "Minor" (+2).
    await page.getByText("public static void main(").click({ button: "right" });
    await page.getByRole("option", { name: "Severity Check" }).click();
    // The sub-option select appears (closed); open it (force past the react-select value container
    // that intercepts pointer events) and choose Minor.
    await page.getByText("Select an option for this check...").click({ force: true });
    await page.getByRole("option", { name: "Minor" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText("Annotate line 4 with a check:").waitFor({ state: "hidden" });

    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("points")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", optionCheckId!)
          .single();
        return data?.points ?? null;
      })
      .toBe(2);

    // Reload so the applied annotation renders with its persisted id (stable for the edit menu).
    await openFiles(page);
    const annotation = page.getByRole("region", { name: /Grading checks on line 4/ }).first();
    await annotation.getByRole("button", { name: "Comment options" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    // The ONLY score control is a dropdown of the check's own options — no free-form numeric entry.
    await expect(page.getByRole("spinbutton", { name: "Edit check score" })).toHaveCount(0);
    const scoreSelect = annotation.getByRole("combobox", { name: "Edit check score" });
    await expect(scoreSelect).toBeVisible();

    // Switch Minor (+2) -> Major (+5); the new option's points persist.
    await scoreSelect.selectOption({ label: "+5 Major" });
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("points")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", optionCheckId!)
          .single();
        return data?.points ?? null;
      })
      .toBe(5);
  });

  test("a single-value check exposes NO score-entry control", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;

    // Apply the fixed +10 check on line 5.
    await page.getByText('System.out.println("Hello,').click({ button: "right" });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText("Annotate line 5 with a check:").waitFor({ state: "hidden" });
    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("id")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", check1.id);
        return data?.length ?? 0;
      })
      .toBe(1);

    await openFiles(page);
    const annotation = page.getByRole("region", { name: /Grading checks on line 5/ }).first();
    await annotation.getByRole("button", { name: "Comment options" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    // No way to change the score for a single-value check: neither a numeric input nor a select.
    await expect(page.getByRole("spinbutton", { name: "Edit check score" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Edit check score" })).toHaveCount(0);
    // The comment box is still editable.
    await expect(annotation.getByRole("textbox")).toBeVisible();
  });
});
