import { AxeBuilder } from "@axe-core/playwright";
import { expect, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page as PlaywrightCorePage } from "playwright-core";

const DEFAULT_EXCLUDES = [
  // Third-party / rich editors often fail strict axe rules without affecting core app UX in E2E.
  ".monaco-editor",
  ".monaco-mouse-cursor-text",
  // SurveyJS emits its own tree with unlabeled buttons and low-contrast palette.
  // Cover both legacy (sv-) and modern (sd-) class prefixes plus its action surfaces.
  "[data-surveyjs]",
  ".sv-root",
  ".sv_main",
  ".sd-root-modern",
  ".sd-btn",
  ".sv-action",
  ".sv-components-row",
  // CodeMirror-backed Pyret REPL — the editor surfaces its own unlabeled textarea
  // and focusable scroll region that axe flags.
  '[id^="pyret-repl-region-"]',
  // `Finalize Submission Early` is a PopConfirm trigger that renders `loading`/
  // `disabled` states via Chakra's built-in opacity overlay. The faded colors
  // (fg #86b296 on bg #ebfbf1, 2.22:1) trip color-contrast even though WCAG
  // 1.4.3 exempts disabled controls. The button has an explicit aria-label so
  // it contributes nothing else axe would catch; excluding the whole subtree
  // is cleaner than scoping color-contrast per-rule.
  'button[aria-label="Finalize Submission Early"]'
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
 * For each axe violation, capture the offending element's outerHTML, three
 * ancestors up, computed styles, position, and any nearby `data-testid` —
 * everything you need to map an opaque emotion class hash back to a JSX site.
 * Writes one JSON dump per call to `axe-debug/` next to the Playwright report.
 *
 * Opt-in via `DEBUG_AXE=1`. Off by default so it doesn't bloat normal runs.
 */
async function dumpViolationDebug(
  page: Page,
  contextLabel: string | undefined,
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]
): Promise<string | null> {
  if (process.env.DEBUG_AXE !== "1") return null;

  const url = page.url();
  const enriched = [];
  for (const v of violations) {
    for (const node of v.nodes) {
      const selector = Array.isArray(node.target) ? node.target.join(" ") : String(node.target);
      const detail = await page
        .evaluate(
          ({ sel }) => {
            // axe targets can include ":" without escaping; try the raw selector first,
            // then fall back to brute-forcing by id from a `#id` prefix.
            let el: Element | null = null;
            try {
              el = document.querySelector(sel);
            } catch {
              /* invalid selector */
            }
            if (!el) {
              const idMatch = /^#([^\s>+~]+)/.exec(sel);
              if (idMatch) el = document.getElementById(idMatch[1]) ?? null;
              if (!el) {
                // try the textual id without the CSS escape
                const m = /^#([^\s>+~]+)/.exec(sel.replaceAll("\\", ""));
                if (m) el = document.getElementById(m[1]) ?? null;
              }
            }
            if (!el) return { found: false as const, selector: sel };

            const ancestors: { tag: string; html: string; testId: string | null; ariaLabel: string | null }[] = [];
            let cur: Element | null = el.parentElement;
            for (let i = 0; i < 4 && cur; i++) {
              ancestors.push({
                tag: cur.tagName.toLowerCase(),
                html: cur.outerHTML.slice(0, 400),
                testId: cur.getAttribute("data-testid"),
                ariaLabel: cur.getAttribute("aria-label")
              });
              cur = cur.parentElement;
            }

            const cs = window.getComputedStyle(el as Element);
            const rect = el.getBoundingClientRect();
            const innerText = (el as HTMLElement).innerText?.trim() ?? "";

            // Walk up to find the nearest data-testid / role landmark / heading
            const findUp = (predicate: (e: Element) => boolean): { tag: string; html: string } | null => {
              let walker: Element | null = el!.parentElement;
              while (walker) {
                if (predicate(walker)) {
                  return { tag: walker.tagName.toLowerCase(), html: walker.outerHTML.slice(0, 200) };
                }
                walker = walker.parentElement;
              }
              return null;
            };

            return {
              found: true as const,
              selector: sel,
              outerHTML: (el as HTMLElement).outerHTML,
              innerText,
              attributes: Array.from((el as HTMLElement).attributes).reduce<Record<string, string>>((acc, a) => {
                acc[a.name] = a.value;
                return acc;
              }, {}),
              computed: {
                color: cs.color,
                background: cs.backgroundColor,
                opacity: cs.opacity,
                visibility: cs.visibility,
                display: cs.display,
                pointerEvents: cs.pointerEvents,
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight
              },
              rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              ancestors,
              nearestTestId: findUp((e) => e.hasAttribute("data-testid")),
              nearestRoleRegion: findUp((e) =>
                ["region", "main", "navigation", "banner", "contentinfo", "complementary", "form"].includes(
                  (e.getAttribute("role") || "").toLowerCase()
                )
              ),
              nearestHeading: findUp((e) => /^h[1-6]$/.test(e.tagName.toLowerCase()))
            };
          },
          { sel: selector }
        )
        .catch((err) => ({ found: false as const, selector, error: String(err) }));

      enriched.push({
        rule: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        failureSummary: node.failureSummary,
        target: node.target,
        ...detail
      });
    }
  }

  const slug = (contextLabel || "axe").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(process.cwd(), "axe-debug");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ url, contextLabel, violations: enriched }, null, 2));
  return file;
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

  const debugFile = await dumpViolationDebug(page, contextLabel, violations);
  const debugLine = debugFile ? `\nDEBUG_AXE dump: ${debugFile}` : "";

  expect(violations, `${prefix}axe-core WCAG 2.1 AA violations:\n${summary}${debugLine}`).toEqual([]);
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
