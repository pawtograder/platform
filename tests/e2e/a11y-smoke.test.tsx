import { expect, test } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";
import { assertPageHasLandmarks, assertSkipLinksWork, assertStudentPageAccessible } from "./axeStudentA11y";

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
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("student `g a` chord navigates to assignments and updates the title", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await assertPageHasLandmarks(page, "dashboard pre-chord");

    await page.locator("body").click({ position: { x: 1, y: 1 } });
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
});
