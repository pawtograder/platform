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

// Verifies #307 part 1: applying a rubric check that does NOT require a comment is a single click
// ("Apply"), with no forced comment step; a check that DOES require a comment keeps the old flow.
// Asserts DB state (the persisted submission_file_comments row), not just the UI.

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;
let requiredCheckId: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "IA Student",
      email: "ia-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "IA Instructor",
      email: "ia-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Immediate Apply Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;

  // Add a comment-REQUIRED annotation check to the grading rubric, sharing the criteria of the
  // existing "Grading Review Check 1" (which is is_comment_required=false).
  const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;
  const { data: required, error } = await supabase
    .from("rubric_checks")
    .insert({
      rubric_criteria_id: check1.rubric_criteria_id,
      name: "Comment Required Check",
      description: "Requires a comment",
      ordinal: 99,
      points: 7,
      is_annotation: true,
      is_comment_required: true,
      class_id: course.id,
      is_required: false,
      assignment_id: assignment!.id,
      rubric_id: assignment!.grading_rubric_id || 0
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to insert required check: ${error.message}`);
  requiredCheckId = required!.id;
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

test.describe("One-click check apply (#307)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("a no-comment check applies in one click and persists with an empty comment", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;

    await page.getByText("public static void main(").click({ button: "right" });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();

    // The one-click "Apply" button is present because the check does not require a comment.
    const applyBtn = page.getByRole("button", { name: "Apply", exact: true });
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();

    // Popup closes without ever needing the comment box.
    await page.getByText("Annotate line 4 with a check:").waitFor({ state: "hidden" });

    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("rubric_check_id, points, comment")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", check1.id);
        return data?.length ?? 0;
      })
      .toBe(1);

    const { data } = await supabase
      .from("submission_file_comments")
      .select("points, comment, line")
      .eq("submission_id", submission_id!)
      .eq("rubric_check_id", check1.id)
      .single();
    expect(data!.points).toBe(10);
    expect(data!.comment ?? "").toBe("");
    expect(data!.line).toBe(4);
  });

  test("a comment-required check shows NO one-click Apply and forces a comment", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    await page.getByText("public int doMath(int a, int").click({ button: "right" });
    await page.getByRole("option", { name: "Comment Required Check" }).click();

    // No immediate Apply button for a comment-required check.
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    // The comment-required placeholder is shown.
    await expect(page.getByRole("textbox", { name: /Add a comment about this check/ })).toBeVisible();

    // Supplying the comment then applies it.
    await page.getByRole("textbox", { name: /Add a comment about this check/ }).fill("Required note");
    await page.getByRole("button", { name: "Add Check" }).click();
    await page.getByText(/Annotate line \d+ with a check:/).waitFor({ state: "hidden" });

    await expect
      .poll(async () => {
        const { data } = await supabase
          .from("submission_file_comments")
          .select("comment")
          .eq("submission_id", submission_id!)
          .eq("rubric_check_id", requiredCheckId!);
        return data?.[0]?.comment ?? null;
      })
      .toBe("Required note");
  });
});
