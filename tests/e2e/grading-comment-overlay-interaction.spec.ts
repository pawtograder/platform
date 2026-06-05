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
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Regression guard for comment-overlay interactivity in the Monaco grading viewer.
//
// The overlay (applied checks + comments + reply form) renders inside a Monaco *view zone*. Monaco
// paints `.view-lines` (the code text layer) after `.view-zones` with the same `z-index: auto`, so
// without intervention `.view-lines` sits on top and swallows every click aimed at the overlay's
// controls — making "Comment options", "Add comment", etc. dead. The editor lifts `.view-zones`
// above `.view-lines` while keeping the container click-through so code-line clicks still place the
// cursor. This test creates a comment through the real UI (quick-apply), then asserts its controls
// actually respond.

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Overlay Student",
      email: "overlay-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Overlay Instructor",
      email: "overlay-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Comment Overlay Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Comment overlay interaction (Monaco grading viewer)", () => {
  test.setTimeout(120_000);

  test("an applied check's overlay controls are clickable (not swallowed by the code layer)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Create a comment through the real path: apply a no-comment rubric check via the quick-apply
    // palette. The applied check renders as an annotation in a view-zone overlay.
    await page.locator(".view-line", { hasText: "main" }).first().click();
    await page.locator(".monaco-editor textarea.inputarea").first().focus();
    await page.keyboard.press("ControlOrMeta+Period");
    const palette = page.getByRole("dialog", { name: "Quick-apply rubric check" });
    await expect(palette).toBeVisible();
    await palette.getByRole("textbox", { name: "Search rubric checks" }).fill("Grading Review Check 1");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();

    // The overlay (with its action controls) appears in a view zone.
    const commentOptions = page.locator('.view-zones button[aria-haspopup="menu"]').first();
    await expect(commentOptions).toBeVisible({ timeout: 20_000 });
    // Let the view zone settle its height/position (it re-measures after content renders).
    await page.waitForTimeout(1000);

    // Clicking "Comment options" must open the actions menu. If the code text layer (`.view-lines`)
    // were stacked above the overlay, this click would be swallowed and no menu would appear — which
    // is exactly the bug the view-zone stacking fix prevents. A real (non-forced) click is used so the
    // assertion fails if anything is intercepting pointer events.
    await commentOptions.click();
    await expect(page.getByRole("menuitem").first()).toBeVisible({ timeout: 5_000 });
  });
});
