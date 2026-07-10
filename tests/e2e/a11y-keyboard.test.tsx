import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, TestingUser } from "./TestingUtils";
import { assertLandmarkJump, tabSequence } from "./axeStudentA11y";

/**
 * WCAG 2.1.1 / 2.4.1 keyboard-navigation suite: landmark-jump chords
 * (Alt+M/N/U/K) and the skip-link menu. Alt-chord tests are chromium-only —
 * WebKit's synthetic Alt+letter composes special characters instead of
 * delivering the chord — while the skip-link tests run on every engine and
 * are the guaranteed cross-browser path to the same landmarks.
 */

let course: Course;
let student: TestingUser;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E A11y Keyboard Class" });
  [student] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Keyboard Student", useMagicLink: true }
  ]);
  await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Keyboard Nav Assignment",
    assignment_slug: `e2e-a11y-keyboard-${course.id}`
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student]);
});

test.describe("landmark jump chords (Alt+letter)", () => {
  test.beforeEach(async ({ browserName }) => {
    test.skip(browserName === "webkit", "WebKit synthesizes composed characters for Alt+letter");
  });

  test("Alt+M focuses main content", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await expect(page.locator("#main-content")).toBeVisible();
    await assertLandmarkJump(page, "Alt+m", "#main-content", "dashboard");
  });

  test("Alt+N focuses the visible course navigation", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await expect(page.locator('[data-landmark="primary-nav"]').locator("visible=true")).toBeVisible();
    await assertLandmarkJump(page, "Alt+n", '[data-landmark="primary-nav"]', "dashboard");
  });

  test("Alt+U focuses the user menu region", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await assertLandmarkJump(page, "Alt+u", '[data-landmark="user-menu"]', "dashboard");
  });

  test("Alt+K reveals and focuses a skip link (regression: container focus showed nothing)", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    // assertLandmarkJump requires the focused element to be visibly rendered
    // (>1×1) — the historical bug focused the skip-links <nav> container while
    // every link stayed screen-reader-clipped at 1×1.
    await assertLandmarkJump(page, "Alt+k", "#skip-links a", "dashboard");
  });
});

test.describe("skip links (engine-agnostic)", () => {
  test("Tab from top reaches skip links; 'Skip to navigation' lands focus in the nav", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await expect(page.locator("#main-content")).toBeVisible();

    // First two Tab stops are skip links, in declared order.
    const stops = await tabSequence(page, 2);
    expect(stops[0].text).toMatch(/skip to main content/i);
    expect(stops[1].text).toMatch(/skip to navigation/i);

    // Activate "Skip to navigation": focus moves to the VISIBLE nav landmark…
    await page.keyboard.press("Enter");
    const navFocused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return el.matches('[data-landmark="primary-nav"]') && rect.width > 1 && rect.height > 1;
    });
    expect(navFocused, "skip link focuses the visible course navigation").toBe(true);

    // …and the next Tab enters the nav's first link, so keyboard users can
    // walk the main toolbar (the audit's "Tab does not reach the main toolbar").
    await page.keyboard.press("Tab");
    const inNav = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && el.closest('[data-landmark="primary-nav"]') && el.tagName === "A");
    });
    expect(inNav, "Tab after the skip lands on the first navigation link").toBe(true);
  });
});

test.describe("focus order (WCAG 2.4.3)", () => {
  test("assignments page tab order follows document order with no positive tabindex", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await expect(page.getByRole("heading", { name: /assignments/i }).first()).toBeVisible();

    // Positive tabindex is the classic way focus order diverges from reading order.
    const positiveTabindexCount = await page.locator("[tabindex]:not([tabindex='-1']):not([tabindex='0'])").count();
    expect(positiveTabindexCount, "no element uses a positive tabindex").toBe(0);

    // Walk the page's tab order and assert every stop comes AFTER the previous
    // one in DOM order — i.e. keyboard traversal matches the reading sequence.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    let prev = await page.evaluateHandle(() => document.body as Element);
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const result = await page.evaluate((prevEl) => {
        const cur = document.activeElement;
        if (!cur || cur === document.body) return { done: true, inOrder: true };
        const inOrder =
          prevEl === document.body || Boolean(prevEl.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { done: false, inOrder, label: (cur as HTMLElement).innerText?.slice(0, 60) };
      }, prev);
      if (result.done) break; // wrapped around — traversal complete
      expect(result.inOrder, `tab stop #${i + 1} (${result.label ?? "?"}) follows the previous stop in DOM order`).toBe(
        true
      );
      prev = await page.evaluateHandle(() => document.activeElement as Element);
    }
  });
});
