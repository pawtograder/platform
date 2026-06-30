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

// The Monaco right-click rubric menu lists one item per criteria (its name shown once); clicking a
// criteria opens a flyout of that criteria's checks. This avoids repeating long criteria names and
// keeps the criteria itself non-applyable. Only annotation checks from the writable review's rubric
// are offered (non-annotation checks must not appear as line annotations).

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submission_id: number | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Menu Student",
      email: "menu-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Menu Instructor",
      email: "menu-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Context Menu Assignment"
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

test.describe("Monaco rubric context menu", () => {
  test.setTimeout(120_000);

  test("lists criteria that open a flyout of annotation checks (no non-annotation checks)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByText("Lint Results: Passed").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    // Right-click a code line to open Monaco's native context menu, then read its items immediately.
    await page.locator(".view-line", { hasText: "main" }).first().click({ button: "right" });
    await page.locator(".monaco-menu .action-item").first().waitFor({ timeout: 10_000 });
    const labels = await page
      .locator(".monaco-menu .action-item .action-label")
      .evaluateAll((els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean));

    // The menu lists the criteria (with a ▸ affordance), NOT the checks directly.
    const criteriaItem = labels.find((l) => l.includes("▸"));
    expect(criteriaItem, `expected a criteria item (▸) in: ${JSON.stringify(labels)}`).toBeTruthy();
    expect(labels.some((l) => l.includes("Grading Review Check"))).toBe(false);

    // Clicking the criteria opens the flyout listing its checks. (Click the menu row, then confirm via
    // Enter as a fallback — Monaco activates items on the row, not the inner label span.)
    const criteriaRow = page.locator(".monaco-menu .action-item", { hasText: "▸" }).first();
    await criteriaRow.hover();
    await criteriaRow.click();
    const flyout = page.locator("[data-rubric-quick-pick]");
    if (!(await flyout.isVisible().catch(() => false))) {
      await page.keyboard.press("Enter");
    }
    await expect(flyout).toBeVisible({ timeout: 5_000 });
    // Even a single-check criteria opens the flyout (it must not apply/open a comment form directly).
    await expect(flyout.getByText(/Grading Review Check 1\b/).first()).toBeVisible();
    // Non-annotation checks must not be offered as line annotations.
    await expect(flyout.getByText("Grading Review Check 2")).toHaveCount(0);
    await expect(flyout.getByText("Grading Review Check 3")).toHaveCount(0);
  });
});
