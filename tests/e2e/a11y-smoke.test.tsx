import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createClass,
  createRegradeRequest,
  createUsersInClass,
  insertAssignment,
  insertHelpRequest,
  insertPreBakedSubmission,
  loginAsUser
} from "./TestingUtils";
import { assertPageHasLandmarks, assertSkipLinksWork, assertStudentPageAccessible } from "./axeStudentA11y";
import { A11Y_CODE_FILES, A11Y_CODE_FILE_NAME } from "./a11yAgentSeeding";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

test.describe("a11y smoke — global landmarks, skip nav, titles, keyboard shortcuts", () => {
  let course: Course;
  let student: User;

  test.beforeAll(async () => {
    course = await createClass();
    const users = await createUsersInClass([
      { role: "student", class_id: course.id, name: "A11y Student", useMagicLink: true }
    ]);
    [student] = users;
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student]);
  });

  test("sign-in page ships lang, title, and a main landmark", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveTitle(/Sign in/);
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang, "html lang attribute").toBeTruthy();
    const mainCount = await page.locator('main, [role="main"]').count();
    expect(mainCount).toBe(1);
    await assertStudentPageAccessible(page, "sign-in page");
  });

  test("course picker has landmarks, title, and skip link lands on #main-content", async ({ page }) => {
    await loginAsUser(page, student, undefined, false);
    await page.goto("/course");
    await expect(page).toHaveTitle(/Your courses/);
    await assertPageHasLandmarks(page, "course picker");
    await assertSkipLinksWork(page, "course picker");
    await assertStudentPageAccessible(page, "course picker");
  });

  test("student course dashboard: landmarks, title template, skip link, and keyboard shortcut opens help", async ({
    page
  }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);

    // Title should match the course-layout template: "<course> · Pawtograder"
    await expect(page).toHaveTitle(new RegExp(`${course.name}.*Pawtograder`));

    await assertPageHasLandmarks(page, "course dashboard");
    await assertSkipLinksWork(page, "course dashboard");

    // Pressing "?" opens the shortcuts help dialog. Focus <main> first so the
    // keydown doesn't get swallowed by whichever element the skip-link test left focused.
    await page.locator("#main-content").focus();
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: /keyboard shortcuts/i });
    await expect(dialog).toBeVisible();
    // Send Esc *into* the dialog itself — on WebKit a top-level page.keyboard.press
    // races Chakra's exit animation; sending it on the focused dialog reliably closes it.
    await dialog.press("Escape");
    // Escape sets data-state="closed" synchronously, but Ark's Presence only unmounts
    // the node after the exit animation's completion event — which is dropped under
    // headless load, leaving the node mounted+visible and hanging toBeHidden(). Assert
    // instead that no *open* dialog remains, which holds whether it unmounts or stalls.
    await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0);

    // Discoverable via the Support & Documentation menu.
    await page.getByRole("button", { name: /support & documentation/i }).click();
    await page.getByRole("menuitem", { name: /keyboard shortcuts/i }).click();
    await expect(
      page.locator('[role="dialog"][data-state="open"]').filter({ hasText: /keyboard shortcuts/i })
    ).toBeVisible();
  });

  test("student `g a` chord navigates to assignments and updates the title", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await assertPageHasLandmarks(page, "dashboard pre-chord");

    // Blur the focused skip link before sending the chord — clicking near the corner
    // can land on the revealed SkipNav and swallow subsequent keystrokes.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator("#main-content").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("a");

    await page.waitForURL(`**/course/${course.id}/assignments`);
    await expect(page).toHaveTitle(/Assignments/);
    await assertPageHasLandmarks(page, "assignments via chord");
  });

  test("assignments list page: landmarks + title inherit from template", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await expect(page.getByRole("heading", { name: /assignments/i }).first()).toBeVisible();
    await expect(page).toHaveTitle(/Assignments.*Pawtograder/);
    await assertPageHasLandmarks(page, "assignments list");
  });

  test("status messages: connection status region and theme announcement", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await expect(page.locator("#main-content")).toBeVisible();

    // The connection indicator is a keyboard-focusable control whose accessible
    // name carries the CURRENT status (4.1.2/1.4.13)…
    const connectionControl = page.getByRole("img", { name: /realtime connection status/i });
    await expect(connectionControl.first()).toBeVisible();
    expect(await connectionControl.first().getAttribute("tabindex")).toBe("0");

    // …plus a SEPARATE polite region carrying the debounced copy (4.1.3). The two
    // are distinct on purpose: the debounce keeps transient join cycles from
    // being announced, and gating the control's name on it would leave the
    // control with no status value for the first 3s and while channels flap.
    const connectionRegion = page.getByRole("status").filter({ hasText: /realtime connection status/i });
    await expect(connectionRegion.first()).toBeVisible();

    // Theme toggle announces the change via a polite live region / toast (4.1.3).
    await page.getByRole("button", { name: "Toggle color mode" }).first().click();
    // Both the global live announcer AND the toast may carry the message; either satisfies 4.1.3.
    await expect(
      page
        .locator('[role="status"], [role="alert"]')
        .filter({ hasText: /switched to .* mode|following your system/i })
        .first()
    ).toBeVisible();
  });

  test("global search input shows a visible focus indicator (WCAG 2.4.7)", async ({ page, browserName }) => {
    // :focus-visible matching after synthetic keyboard events is only reliable
    // on chromium; a top-of-test skip keeps webkit reporting honest (the other
    // status-message checks above run on every engine).
    test.skip(browserName === "webkit", "webkit focus-visible heuristics differ under synthetic input");
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await expect(page.locator("#main-content")).toBeVisible();

    await page.locator("#main-content").focus();
    await page.keyboard.press("/");
    const searchInput = page.getByRole("combobox", { name: /search pawtograder/i });
    await expect(searchInput).toBeFocused();
    const focusRing = await searchInput.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { matchesFocusVisible: el.matches(":focus-visible"), outline: cs.outlineStyle, shadow: cs.boxShadow };
    });
    expect(focusRing.matchesFocusVisible, "search input matches :focus-visible after keyboard focus").toBe(true);
    expect(
      focusRing.outline !== "none" || focusRing.shadow !== "none",
      `focused search input has a visible indicator (outline=${focusRing.outline}, shadow=${focusRing.shadow})`
    ).toBe(true);
  });
});

test.describe("a11y smoke — seeded student pages (assignments, files/Monaco, regrade, office hours)", () => {
  let course: Course;
  let student: User;
  let submissionFilesUrl: string;

  test.beforeAll(async () => {
    course = await createClass();
    const users = await createUsersInClass([
      { role: "student", class_id: course.id, name: "A11y Seeded Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "A11y Seeded Instructor", useMagicLink: true }
    ]);
    const [seededStudent, instructor] = users;
    student = seededStudent;

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "A11y Smoke Assignment",
      assignment_slug: `e2e-a11y-smoke-${course.id}`
    });
    const sub = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id,
      files: A11Y_CODE_FILES
    });
    submissionFilesUrl = `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}/files`;
    await createRegradeRequest(
      sub.submission_id,
      assignment.id,
      student.private_profile_id,
      instructor.private_profile_id,
      assignment.rubricChecks[0]!.id,
      course.id,
      "opened"
    );
    await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student.private_profile_id,
      request: "Seeded question: my tests pass locally but fail on the autograder.",
      active_staff_profile_id: instructor.private_profile_id
    });
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student]);
  });

  test("assignments list with seeded content passes axe", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await expect(page.getByText("A11y Smoke Assignment").first()).toBeVisible();
    await assertPageHasLandmarks(page, "assignments list (seeded)");
    await assertStudentPageAccessible(page, "assignments list (seeded)");
  });

  test("submission files page (Monaco in scope) passes axe", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(submissionFilesUrl);
    await expect(page.getByText(A11Y_CODE_FILE_NAME).first()).toBeVisible({ timeout: 30_000 });
    // Monaco is deliberately NOT excluded from this scan — the read-only code
    // viewer is configured for accessibility (components/ui/code-file-monaco.tsx).
    await page
      .locator(".monaco-editor")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => {});
    await assertPageHasLandmarks(page, "submission files");
    await assertStudentPageAccessible(page, "submission files");
  });

  test("regrade requests page passes axe", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/regrade-requests`);
    await expect(page.locator("#main-content, main").first()).toBeVisible();
    await assertPageHasLandmarks(page, "regrade requests");
    await assertStudentPageAccessible(page, "regrade requests");
  });

  test("office hours queue page passes axe", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/office-hours`);
    await expect(page.locator("#main-content, main").first()).toBeVisible();
    await assertPageHasLandmarks(page, "office hours");
    await assertStudentPageAccessible(page, "office hours");
  });
});
