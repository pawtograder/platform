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

const VISUAL_TEST_ATTR = "data-visual-tests";

/**
 * Turn off the screenshot-masking mode for the duration of a scan.
 *
 * `tests/global-setup.ts` sets `data-visual-tests` on every page so visual
 * diffs are stable: it paints synthetic placeholder text over dates and ids,
 * makes tagged content transparent, hides `[data-visual-test="removed"]`, and
 * expands scrollable containers. Every one of those changes the pixels and the
 * DOM that axe measures, so scanning with it on reports contrast against
 * test-only rendering while hiding the real UI. `assertReflowAt320` already
 * removes it for the same reason; the axe passes never did.
 *
 * Returns whether it was on, so it can be restored for later assertions.
 */
async function disableVisualTestMasking(page: Page): Promise<boolean> {
  return await page
    .evaluate((attr) => {
      const was = document.documentElement.hasAttribute(attr);
      document.documentElement.removeAttribute(attr);
      return was;
    }, VISUAL_TEST_ATTR)
    .catch(() => false);
}

async function restoreVisualTestMasking(page: Page, wasEnabled: boolean): Promise<void> {
  if (!wasEnabled) return;
  await page.evaluate((attr) => document.documentElement.setAttribute(attr, ""), VISUAL_TEST_ATTR).catch(() => {});
}

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

/** Shape of the parts of an axe result this module reads. */
type AxeCheck = { id?: string; data?: unknown };
type AxeNode = { target?: unknown[]; all?: AxeCheck[]; any?: AxeCheck[]; none?: AxeCheck[] };
type AxeResult = { id?: string; impact?: string | null; nodes?: AxeNode[] };
type AxeResults = { violations?: unknown[]; incomplete?: unknown[] };

/**
 * `aria-valid-attr-value` never *fails* an element that carries `aria-controls`
 * next to `aria-haspopup` — it declines to judge it. axe's own message says so:
 * "Unable to determine if aria-controls referenced ID exists on the page while
 * using aria-haspopup". The rule's pre-check bails as soon as `aria-haspopup`
 * is present, without ever looking the id up, because popup content is
 * commonly rendered lazily.
 *
 * Every Chakra popover, menu and dialog trigger emits that exact pair (zag sets
 * `aria-haspopup` and `aria-controls` together on all three), so the rule fires
 * on nearly every route in the sweep and tells us nothing about whether any
 * reference is actually broken.
 *
 * Baselining that would record scanner indecision as app debt. Decide it
 * instead: look the ids up in the live page. A node whose references all
 * resolve is dropped; one that genuinely dangles stays a finding, which is the
 * signal the rule exists to give. Nodes flagged for any other reason
 * (`noId`, `idrefs`, `empty`, `ariaCurrent`) are untouched.
 */
const CONTROLS_WITHIN_POPUP = "controlsWithinPopup";

/**
 * Ids referenced by a node's undecided `aria-controls`, or `null` if the node
 * was flagged for some other reason and must be left alone.
 */
export function popupControlIdrefs(node: AxeNode): string[] | null {
  for (const check of node.all ?? []) {
    if (check.id !== "aria-valid-attr-value") continue;
    const data = check.data as { messageKey?: string; needsReview?: string } | undefined;
    if (data?.messageKey !== CONTROLS_WITHIN_POPUP) continue;
    // needsReview is rendered as `aria-controls="id1 id2"`.
    const value = /^aria-controls="(.*)"$/.exec(data.needsReview ?? "")?.[1] ?? "";
    return value.split(/\s+/).filter(Boolean);
  }
  return null;
}

/**
 * Drop the nodes whose undecided `aria-controls` references all resolve, using
 * `exists` to test one id. Returns the surviving nodes.
 */
export function withoutResolvedPopupControls(nodes: AxeNode[], exists: (id: string) => boolean): AxeNode[] {
  return nodes.filter((node) => {
    const idrefs = popupControlIdrefs(node);
    if (idrefs === null) return true;
    // An empty aria-controls resolves to nothing — keep it.
    if (idrefs.length === 0) return true;
    return !idrefs.every(exists);
  });
}

/**
 * Apply {@link withoutResolvedPopupControls} to an axe run against `page`,
 * resolving the ids in the page the results came from.
 */
async function decideUndecidedPopupControls(page: Page, results: AxeResults): Promise<AxeResults> {
  const bucket = (results.incomplete ?? []) as AxeResult[];
  const target = bucket.find((r) => r.id === "aria-valid-attr-value");
  if (!target?.nodes?.length) return results;

  const idrefs = new Set<string>();
  for (const node of target.nodes) for (const id of popupControlIdrefs(node) ?? []) idrefs.add(id);
  if (idrefs.size === 0) return results;

  const present = new Set(
    await page.evaluate((ids: string[]) => ids.filter((id) => document.getElementById(id) !== null), [...idrefs])
  );
  const kept = withoutResolvedPopupControls(target.nodes, (id) => present.has(id));
  if (kept.length === target.nodes.length) return results;

  const incomplete =
    kept.length > 0
      ? bucket.map((r) => (r === target ? { ...target, nodes: kept } : r))
      : bucket.filter((r) => r !== target);
  return { ...results, incomplete };
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
  const maskingWasOn = await disableVisualTestMasking(page);
  try {
    const tagged = await decideUndecidedPopupControls(
      page,
      await new AxeBuilder({ page: page as unknown as PlaywrightCorePage }).withTags(WCAG_TAGS).analyze()
    );
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
    await restoreVisualTestMasking(page, maskingWasOn);
    await unfreezeAnimations(page);
    await page.emulateMedia({ colorScheme: "light" });
  }
}

/** Stable key for baselining: one row per (route, scheme, rule, kind). */
export function findingKey(routeId: string, scheme: ColorScheme, f: Finding): string {
  return `${routeId}|${scheme}|${f.rule}|${f.kind}`;
}
