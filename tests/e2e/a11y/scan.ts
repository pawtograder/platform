/**
 * Non-throwing WCAG scan used by the student-page coverage sweep.
 *
 * Differs from `assertStudentPageAccessible` (tests/e2e/axeStudentA11y.ts) in
 * three ways that matter for coverage work, and deliberately does NOT replace
 * it — the existing per-feature call sites keep their current behaviour:
 *
 *  1. It COLLECTS instead of asserting, so one run can sweep every route and
 *     report the whole picture rather than dying on the first bad page.
 *  2. It reads axe's `incomplete` bucket as well as `violations`. `incomplete`
 *     is where `color-contrast` lands whenever axe cannot resolve the backdrop
 *     (gradients, images, transparency) — i.e. exactly the cases most likely to
 *     be real 1.4.3 failures. The existing helper reads only `violations`.
 *  3. Widget subtrees are NOT removed from the scan. `AxeBuilder.exclude()`
 *     drops a subtree from EVERY rule, so the historical excludes for SurveyJS,
 *     the markdown editor, the Pyret REPL and react-select chips also hid every
 *     unrelated rule on the app's main student interaction surfaces. Here the
 *     scan sees everything and known third-party defects are filtered afterwards
 *     by (rule × selector) — see SCOPED_SUPPRESSIONS.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Page as PlaywrightCorePage } from "playwright-core";

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Best-practice rules enforced on top of the WCAG tag set (see axeStudentA11y.ts). */
export const EXTRA_RULES = ["heading-order"];

export type ColorScheme = "light" | "dark";

export type Finding = {
  /** axe rule id, e.g. "color-contrast". */
  rule: string;
  /** "violation" = axe is certain; "incomplete" = axe needs review. */
  kind: "violation" | "incomplete";
  impact: string;
  /** Number of DOM nodes the rule matched. */
  nodes: number;
  /** First node's target selector — enough to locate, not so much that it churns. */
  sample: string;
};

/**
 * Per-rule suppressions for defects inside third-party widgets we do not own.
 *
 * This replaces the blanket subtree excludes. Each entry silences ONE rule on
 * ONE selector, so everything else about the widget is still scanned. Every
 * entry needs a reason and an owner so the list stays auditable and can be
 * burned down; an empty `owner` means nobody has picked it up yet.
 */
export type ScopedSuppression = {
  rule: string;
  selector: string;
  reason: string;
  owner: string;
};

export const SCOPED_SUPPRESSIONS: ScopedSuppression[] = [
  // Intentionally empty for the first coverage sweep. Everything the sweep
  // finds is recorded in the baseline instead, so the true state of the
  // student surface — including the previously-excluded widgets — is visible
  // in one place before we decide what to suppress vs. fix.
];

function suppressed(rule: string, target: string): boolean {
  return SCOPED_SUPPRESSIONS.some((s) => s.rule === rule && target.includes(s.selector));
}

const FREEZE_STYLE_ID = "a11y-coverage-animation-freeze";

/**
 * Snap animations to their final state so axe's pixel sampling is deterministic.
 * Same rationale as axeStudentA11y.ts: mid-transition opacity blends produce
 * phantom color-contrast findings. Injected via evaluate (not addStyleTag) so a
 * nonce-based CSP cannot reject it.
 */
async function freezeAnimations(page: Page): Promise<void> {
  await page
    .evaluate((id) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `*, *::before, *::after {
        animation-duration: 0s !important; animation-delay: 0s !important;
        transition-duration: 0s !important; transition-delay: 0s !important;
      }`;
      document.head.appendChild(style);
    }, FREEZE_STYLE_ID)
    .catch(() => {
      /* navigation race — the freeze is a determinism aid, not a requirement */
    });
}

async function unfreezeAnimations(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), FREEZE_STYLE_ID).catch(() => {});
}

/**
 * Harness invariant, not an app finding: confirm the app really switched
 * themes before we attribute anything to "dark mode".
 *
 * The app drives color mode through next-themes with `defaultTheme="system"`
 * and `attribute="class"`, so `emulateMedia({colorScheme})` should flip
 * `<html class>`. If a future change stores an explicit preference or drops
 * `enableSystem`, the dark pass would silently become a second light pass and
 * every dark-mode finding would quietly vanish — a coverage regression that
 * looks exactly like a fix. Fail loudly instead.
 */
async function assertThemeApplied(page: Page, scheme: ColorScheme): Promise<void> {
  const applied = await page
    .waitForFunction((want) => document.documentElement.classList.contains(want), scheme, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!applied) {
    const cls = await page.evaluate(() => document.documentElement.className).catch(() => "<unavailable>");
    throw new Error(
      `a11y scan: emulated colorScheme="${scheme}" but <html> class is "${cls}". ` +
        `The dark pass would duplicate the light pass — fix the theme wiring or this scan.`
    );
  }
}

function toFindings(
  results: { violations?: unknown[]; incomplete?: unknown[] },
  kind: "violation" | "incomplete"
): Finding[] {
  const bucket = (kind === "violation" ? results.violations : results.incomplete) ?? [];
  const out: Finding[] = [];
  for (const raw of bucket) {
    const r = raw as { id: string; impact?: string | null; nodes?: { target?: unknown[] }[] };
    const nodes = r.nodes ?? [];
    const sample = String(nodes[0]?.target?.[0] ?? "");
    if (suppressed(r.id, sample)) continue;
    out.push({ rule: r.id, kind, impact: r.impact ?? "unknown", nodes: nodes.length, sample });
  }
  return out;
}

/**
 * Scan the current page under one color scheme and return every finding.
 *
 * The caller is responsible for navigation and for the page being settled;
 * this only waits for a non-empty <title> (the documented flake where a
 * client-side route change briefly empties it and trips `document-title`).
 */
export async function collectFindings(page: Page, colorScheme: ColorScheme): Promise<Finding[]> {
  await page.emulateMedia({ colorScheme });
  await assertThemeApplied(page, colorScheme);
  await page
    .waitForFunction(() => document.title.trim().length > 0, undefined, { timeout: 10_000 })
    .catch(() => {
      /* let axe report an genuinely empty title */
    });
  await freezeAnimations(page);
  try {
    const tagged = await new AxeBuilder({ page: page as unknown as PlaywrightCorePage }).withTags(WCAG_TAGS).analyze();
    // withRules REPLACES the tag filter, so best-practice rules need their own pass.
    const extra = await new AxeBuilder({ page: page as unknown as PlaywrightCorePage })
      .withRules(EXTRA_RULES)
      .analyze();
    return [
      ...toFindings(tagged, "violation"),
      ...toFindings(tagged, "incomplete"),
      ...toFindings(extra, "violation"),
      ...toFindings(extra, "incomplete")
    ];
  } finally {
    await unfreezeAnimations(page);
    await page.emulateMedia({ colorScheme: "light" });
  }
}

/** Stable key for baselining: one row per (route, scheme, rule, kind). */
export function findingKey(routeId: string, scheme: ColorScheme, f: Finding): string {
  return `${routeId}|${scheme}|${f.rule}|${f.kind}`;
}
