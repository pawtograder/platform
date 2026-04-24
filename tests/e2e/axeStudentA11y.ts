import { AxeBuilder } from "@axe-core/playwright";
import { expect, Page } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";

const DEFAULT_EXCLUDES = [
  // Third-party / rich editors often fail strict axe rules without affecting core app UX in E2E.
  ".monaco-editor",
  ".monaco-mouse-cursor-text",
  "[data-surveyjs]",
  ".sv-root",
  ".sv_main",
  // CodeMirror-backed Pyret REPL — the editor surfaces its own unlabeled textarea
  // and focusable scroll region that axe flags.
  '[id^="pyret-repl-region-"]'
];

/** Scope axe scanning to the rules we actually want to enforce. */
const DEFAULT_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

export type AxeAssertOptions = {
  /** Extra CSS selectors to exclude from the scan. Merged with DEFAULT_EXCLUDES. */
  exclude?: string[];
  /** Override the WCAG tag set. Defaults to WCAG 2.1 AA. */
  tags?: string[];
  /** Rule ids to disable entirely (e.g. "color-contrast" in flaky theme scenarios). */
  disableRules?: string[];
};

function formatViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string {
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join("\n      ");
      const extra = v.nodes.length > 3 ? `\n      … and ${v.nodes.length - 3} more node(s)` : "";
      return `- ${v.id} (${v.impact}) — ${v.help}\n  ${v.helpUrl}\n  Nodes:\n      ${targets}${extra}`;
    })
    .join("\n");
}

/**
 * Runs axe-core against the current page with WCAG 2.1 AA rules and fails the
 * test if any violations are found. Call after navigations and key UI settles
 * (e.g. after expect().toBeVisible() on main content).
 */
export async function assertStudentPageAccessible(
  page: Page,
  contextLabel?: string,
  options: AxeAssertOptions = {}
): Promise<void> {
  // @axe-core/playwright types against playwright-core's Page; cast for compatibility with test fixtures.
  let builder = new AxeBuilder({ page: page as unknown as PlaywrightCorePage }).withTags(
    options.tags ?? DEFAULT_WCAG_TAGS
  );
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  for (const sel of excludes) {
    builder = builder.exclude(sel);
  }
  if (options.disableRules && options.disableRules.length > 0) {
    builder = builder.disableRules(options.disableRules);
  }
  const results = await builder.analyze();
  const violations = results.violations ?? [];
  if (violations.length === 0) return;

  const summary = formatViolations(violations);
  const prefix = contextLabel ? `[${contextLabel}] ` : "";
  expect(violations, `${prefix}axe-core WCAG 2.1 AA violations:\n${summary}`).toEqual([]);
}

/**
 * Asserts the page exposes the standard landmark structure the app ships:
 * one `<main>` (or role="main"), at least one `<nav>` (or role="navigation")
 * with an accessible name, and a non-empty `<title>`. These are WCAG 1.3.1
 * / 2.4.1 / 2.4.2 smoke checks that complement the full axe scan.
 */
export async function assertPageHasLandmarks(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";

  const title = await page.title();
  expect(title.trim(), `${prefix}page has a non-empty <title>`).not.toBe("");

  const lang = await page.locator("html").getAttribute("lang");
  expect(lang, `${prefix}html element has a lang attribute`).toBeTruthy();

  // Wait for the page to leave any <Suspense>/loading.tsx state before counting landmarks.
  const mains = page.locator('main, [role="main"]');
  await expect(mains.first(), `${prefix}main landmark renders`).toBeVisible({ timeout: 15000 });
  const mainCount = await mains.count();
  expect(mainCount, `${prefix}page has exactly one main landmark`).toBe(1);

  const navs = page.locator('nav, [role="navigation"]');
  const navCount = await navs.count();
  expect(navCount, `${prefix}page has at least one nav landmark`).toBeGreaterThan(0);

  // Every nav landmark must have an accessible name (aria-label or aria-labelledby).
  for (let i = 0; i < navCount; i++) {
    const nav = navs.nth(i);
    const label = await nav.getAttribute("aria-label");
    const labelledBy = await nav.getAttribute("aria-labelledby");
    expect(
      Boolean((label && label.trim()) || (labelledBy && labelledBy.trim())),
      `${prefix}nav landmark #${i} has an accessible name (aria-label or aria-labelledby)`
    ).toBe(true);
  }
}

/**
 * Asserts the global skip-links are present in the DOM, hidden by default,
 * and reveal + focus a landmark when activated from the keyboard.
 */
export async function assertSkipLinksWork(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";
  const skipNav = page.locator('nav[aria-label="Skip links"]');
  await expect(skipNav, `${prefix}skip-links nav exists`).toHaveCount(1);

  const mainLink = skipNav.getByRole("link", { name: /skip to main content/i });
  await expect(mainLink, `${prefix}"Skip to main content" link exists`).toHaveCount(1);
  await expect(mainLink, `${prefix}skip link targets #main-content`).toHaveAttribute("href", "#main-content");

  // Reset focus to document root so the first Tab lands on the first tabbable
  // element — SkipNav should be mounted earliest in the tree.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(mainLink, `${prefix}"Skip to main content" is the first tabbable element`).toBeFocused();

  await mainLink.click();
  // focusLandmark adds tabindex=-1 to non-focusable landmarks and focuses them.
  const active = await page.evaluate(() => document.activeElement?.id ?? null);
  expect(active, `${prefix}activating skip link moves focus to #main-content`).toBe("main-content");
}
