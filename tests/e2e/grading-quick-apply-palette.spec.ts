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

// Verifies the productivity keyboard layer: the Cmd/Ctrl+. quick-apply palette inside the Monaco
// editor, and that the grading shortcuts are documented in the app's global "?" shortcuts dialog.
// Monaco is opt-in via a user preference, so we set it in the DB before logging in.

let course: Course;
let instructor: TestingUser | undefined;
let student: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "QP Student",
      email: "qp-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "QP Instructor",
      email: "qp-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Quick Apply Assignment"
  });
  const res = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = res.submission_id;

  // Opt the instructor into the Monaco grading editor.
  const { error } = await supabase
    .from("users")
    .update({ preferences: { grading: { useMonacoEditor: true } } })
    .eq("user_id", instructor!.user_id);
  if (error) throw new Error(`Failed to set Monaco preference: ${error.message}`);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Quick-apply palette + shortcuts (productivity layer)", () => {
  test.setTimeout(120_000);

  test("Cmd/Ctrl+. opens the palette in Monaco and applies a no-comment check", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();

    // Wait for the Monaco editor to mount, then place the cursor on a line.
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
    const mainLine = page.locator(".view-line", { hasText: "main" }).first();
    await mainLine.click();

    // The quick-apply chord is scoped to the editor (editor.addAction), so the editor's hidden input
    // must actually hold keyboard focus before we press it — a .view-line click alone doesn't reliably
    // focus Monaco's textarea on WebKit. Focus it explicitly and confirm before sending the chord.
    const editorInput = page.locator(".monaco-editor textarea.inputarea").first();
    await editorInput.focus();
    await expect(editorInput).toBeFocused();

    // Open the quick-apply palette scoped to the editor (Cmd/Ctrl+. — not Cmd/Ctrl+K, which is global search).
    await page.keyboard.press("ControlOrMeta+Period");
    const palette = page.getByRole("dialog", { name: "Quick-apply rubric check" });
    await expect(palette).toBeVisible();

    // Filter to the no-comment annotation check and apply it with Enter.
    await palette.getByRole("textbox", { name: "Search rubric checks" }).fill("Grading Review Check 1");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();

    const check1 = assignment!.rubricChecks.find((c) => c.name === "Grading Review Check 1")!;
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
  });

  test('the global "?" shortcuts dialog documents the grading shortcuts', async ({ page }) => {
    // The grading keys are registered in the app-wide shortcuts help (no competing overlay).
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByLabel("File navigator")).toBeVisible();

    // Press "?" with focus on the page body (handled by the global keyboard infra).
    await page.locator("body").click();
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    // Our grading section is integrated into the existing dialog.
    await expect(help.getByText("Grading (viewing submission files)")).toBeVisible();
    await expect(help.getByText("Next / previous file")).toBeVisible();
    await expect(help.getByText("Next / previous comment")).toBeVisible();
  });
});
