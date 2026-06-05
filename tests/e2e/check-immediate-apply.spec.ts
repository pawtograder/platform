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

// Verifies #307 part 1: applying a rubric check that does NOT require a comment is immediate (pick the
// check from the criteria flyout, no forced comment step); a check that DOES require a comment opens
// the comment dialog first. Asserts DB state (the persisted submission_file_comments row), not just UI.
//
// Menu flow: right-click a line → Monaco context menu lists the criteria (with a ▸) → click the
// criteria → a flyout ([data-rubric-quick-pick]) lists that criteria's checks → click a check.

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

// Right-click a line, then open the criteria flyout from the Monaco context menu (all annotation
// checks here live in one criteria, so there is a single "… ▸" item). Monaco virtualizes lines, so
// scroll the target line into the rendered DOM first (lower lines can be out of view once an existing
// comment overlay + the editor chrome consume height).
async function openCriteriaFlyout(page: Parameters<typeof loginAsUser>[0], lineText: string) {
  const line = page.locator(".view-line", { hasText: lineText });
  for (let i = 0; i < 12 && (await line.count()) === 0; i++) {
    await page.locator(".monaco-editor").first().hover();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
  }
  await line
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await line.first().click({ button: "right" });
  const criteria = page.locator(".monaco-menu .action-item", { hasText: "▸" }).first();
  await criteria.hover();
  await criteria.click();
  const flyout = page.locator("[data-rubric-quick-pick]");
  if (!(await flyout.isVisible().catch(() => false))) {
    await page.keyboard.press("Enter");
  }
  await expect(flyout).toBeVisible({ timeout: 10_000 });
  return flyout;
}

test.describe("One-click check apply (#307)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("a no-comment check applies in one click and persists with an empty comment", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await openFiles(page);

    const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;

    // Picking a no-comment check from the flyout applies it immediately — no comment step.
    const flyout = await openCriteriaFlyout(page, "public static void main(");
    await flyout
      .getByText(/Grading Review Check 1\b/)
      .first()
      .click();

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

    const flyout = await openCriteriaFlyout(page, "public int doMath(int a, int");
    await flyout.getByText("Comment Required Check").click();

    // A comment-required check opens the comment dialog (no immediate Apply button).
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    // The comment-required placeholder is shown.
    await expect(page.getByRole("textbox", { name: /Add a comment about this check/ })).toBeVisible();

    // Supplying the comment then applies it.
    await page.getByRole("textbox", { name: /Add a comment about this check/ }).fill("Required note");
    await page.getByRole("button", { name: "Add Check" }).click();

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
