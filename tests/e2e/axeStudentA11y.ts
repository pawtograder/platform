import { AxeBuilder } from "@axe-core/playwright";
import { expect, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page as PlaywrightCorePage } from "playwright-core";

const DEFAULT_EXCLUDES = [
  // NOTE: Monaco (`.monaco-editor`) is deliberately NOT excluded. The read-only
  // code viewer is configured for accessibility (ariaLabel /
  // accessibilitySupport:"on" / tabFocusMode — components/ui/code-file-monaco.tsx)
  // and axe scans it like first-party UI. If a scan surfaces a violation inside
  // Monaco internals we cannot configure away, re-add the *narrowest* selector
  // here with the axe rule id and reason.
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
  // `@uiw/react-md-editor` (used by the discussion compose form, help-request
  // forms, etc.). The toolbar renders unlabeled `<button>` + `<svg role="img">`
  // icons and the underlying contenteditable surfaces an unlabeled
  // `<textarea>`. Treat the editor as a third-party widget like Monaco —
  // exclude the whole subtree from axe scans.
  ".w-md-editor",
  // `chakra-react-select` multi-value chips render `<span aria-label="Remove
  // …"><span role="button"><svg/></span></span>`, which axe flags as
  // aria-prohibited-attr (aria-label on a plain span) AND aria-command-name
  // (role=button with no name). The library renders emotion class hashes only
  // — no stable class to exclude — so match the structural pattern instead.
  // Scoped narrowly so it can't mask first-party Remove buttons that already
  // have proper roles. Requires `:has()`, supported by every browser axe runs
  // under in our suite.
  'span[aria-label^="Remove "]:has(> span[role="button"])',
  // `Finalize Submission Early` is a PopConfirm trigger that renders `loading`/
  // `disabled` states via Chakra's built-in opacity overlay. The faded colors
  // (fg #86b296 on bg #ebfbf1, 2.22:1) trip color-contrast even though WCAG
  // 1.4.3 exempts disabled controls. The button has an explicit aria-label so
  // it contributes nothing else axe would catch; excluding the whole subtree
  // is cleaner than scoping color-contrast per-rule.
  'button[aria-label="Finalize Submission Early"]',
  // Same pattern: any Chakra Button rendered with `loading={true}` gets
  // `data-loading=""`, applying an opacity overlay that axe reads as low
  // color-contrast (e.g. Send button mid-submit on webkit: fg #fdfdfd on bg
  // #85b196, 2.36:1). WCAG exempts disabled/in-flight controls.
  "button[data-loading]"
];

/** Scope axe scanning to the rules we actually want to enforce. */
const DEFAULT_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Best-practice rules we want enforced *in addition to* the WCAG tag set.
 * `heading-order` is in `best-practice` (not `wcag*`), but skipping heading
 * levels (e.g. h1 → h3) materially hurts screen-reader navigation, so we
 * enable it explicitly.
 */
const ADDITIONAL_RULES = ["heading-order"];

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
  // Guard against a flake class: on client-side Next.js nav, the `<title>`
  // can briefly be empty until the new route's metadata resolves. axe's
  // `document-title` rule fails if we scan during that window. Wait for a
  // non-empty <title> (up to 10s) before scanning.
  await page
    .waitForFunction(() => document.title.trim().length > 0, undefined, { timeout: 10000 })
    .catch(() => {
      /* fall through — let axe report the real issue if it really is empty */
    });

  // axe samples rendered pixel colors; in-flight CSS animations / transitions
  // (e.g. chat slideInFromBottom, Chakra dialog enter/exit) cause it to read
  // intermediate opacity-blended values and flag color-contrast on text that
  // is fine once the animation settles. Snap everything to its final state
  // so the scan is deterministic.
  // Inject via evaluate rather than page.addStyleTag: addStyleTag awaits the injected
  // <style>'s load/error events, which reject when the app's nonce-based CSP blocks the
  // (un-nonced) inline style, or when the execution context churns during a post-login
  // settle — surfacing as a spurious "page.addStyleTag: ... Content Security Policy ..."
  // failure. This appends synchronously, resolves immediately, and is non-fatal: if it
  // can't run, axe still scans (the freeze is only a determinism aid).
  const FREEZE_STYLE_ID = "axe-a11y-animation-freeze";
  await page
    .evaluate((id) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `;
      document.head.appendChild(style);
    }, FREEZE_STYLE_ID)
    .catch(() => {
      /* navigation/context race — proceed without the freeze */
    });

  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  const applyCommonConfig = (b: AxeBuilder) => {
    let builder = b;
    for (const sel of excludes) builder = builder.exclude(sel);
    if (options.disableRules && options.disableRules.length > 0) {
      builder = builder.disableRules(options.disableRules);
    }
    return builder;
  };

  let tagResults;
  let ruleResults;
  try {
    // @axe-core/playwright types against playwright-core's Page; cast for compatibility with test fixtures.
    const tagBuilder = applyCommonConfig(
      new AxeBuilder({ page: page as unknown as PlaywrightCorePage }).withTags(options.tags ?? DEFAULT_WCAG_TAGS)
    );
    tagResults = await tagBuilder.analyze();

    // Second pass: best-practice rules we want enforced (heading-order). axe's
    // `withTags` filters out rules outside those tags, and `withRules` would
    // *replace* the tag filter, so run a second scoped scan and merge.
    const ruleBuilder = applyCommonConfig(
      new AxeBuilder({ page: page as unknown as PlaywrightCorePage }).withRules(ADDITIONAL_RULES)
    );
    ruleResults = await ruleBuilder.analyze();
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), FREEZE_STYLE_ID).catch(() => {});
  }

  const violations = [...(tagResults.violations ?? []), ...(ruleResults.violations ?? [])];
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
/**
 * WCAG 2.4.2 — the page is titled, and the title carries the product name.
 *
 * Split out of `assertPageHasLandmarks` so the coverage sweep can baseline it
 * under its own key: these parts span three success criteria, and a single
 * shared key would let one recorded defect mask the other two forever.
 */
export async function assertPageTitle(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";

  const title = await page.title();
  expect(title.trim(), `${prefix}page has a non-empty <title>`).not.toBe("");

  // The title template appends the product name on every route (app/layout.tsx
  // + course layout). Mirrors lib/branding.ts name resolution so re-branded
  // deployments can still run the suite.
  const brandName = process.env.BRAND_NAME?.trim() || "Pawtograder";
  expect(title, `${prefix}<title> includes the product name ("${brandName}")`).toContain(brandName);
}

/** WCAG 3.1.1 — the document declares its language. */
export async function assertHtmlLang(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";
  const lang = await page.locator("html").getAttribute("lang");
  expect(lang, `${prefix}html element has a lang attribute`).toBeTruthy();
}

/** WCAG 1.3.1 — exactly one main landmark, exposed to the a11y tree. */
export async function assertMainLandmark(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";

  // Use getByRole so we count what's *exposed to the accessibility tree* —
  // i.e. screen readers see — not raw DOM nodes. This skips siblings hidden
  // via aria-hidden (e.g. the responsive twin of the active subtree in
  // dynamicCourseNav, where mobile/desktop are both mounted but only the
  // visible one is in the a11y tree).
  await expect(page.getByRole("main").first(), `${prefix}main landmark renders`).toBeVisible({ timeout: 15000 });
  const mainCount = await page.getByRole("main").count();
  expect(mainCount, `${prefix}page has exactly one main landmark`).toBe(1);
}

/** WCAG 1.3.1 — navigation landmarks exist and are individually named. */
export async function assertNavLandmarks(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";

  const navs = page.getByRole("navigation");
  const navCount = await navs.count();
  expect(navCount, `${prefix}page has at least one nav landmark`).toBeGreaterThan(0);

  // Every visible nav landmark must expose a non-empty computed accessible
  // name (covers aria-label, aria-labelledby resolution, and other naming
  // sources; broken labelledby refs fail here).
  for (let i = 0; i < navCount; i++) {
    const nav = navs.nth(i);
    await expect(nav, `${prefix}nav landmark #${i} has an accessible name`).toHaveAccessibleName(/\S/);
  }
}

/**
 * Composite kept for the existing per-feature call sites, whose behaviour is
 * unchanged: same assertions, same order, same messages.
 */
export async function assertPageHasLandmarks(page: Page, contextLabel?: string): Promise<void> {
  await assertPageTitle(page, contextLabel);
  await assertHtmlLang(page, contextLabel);
  await assertMainLandmark(page, contextLabel);
  await assertNavLandmarks(page, contextLabel);
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

  // Reset focus to <body> so Tab order is predictable (not another control that
  // happened to be focused from a prior interaction).
  await page.evaluate(() => {
    document.body.focus();
  });
  await page.keyboard.press("Tab");
  await expect(mainLink, `${prefix}skip link targets #main-content`).toHaveAttribute("href", "#main-content");
  await expect(mainLink, `${prefix}"Skip to main content" is the first tabbable element`).toBeFocused();

  await mainLink.click();
  // focusLandmark adds tabindex=-1 to non-focusable landmarks and focuses them.
  const active = await page.evaluate(() => document.activeElement?.id ?? null);
  expect(active, `${prefix}activating skip link moves focus to #main-content`).toBe("main-content");
}

export type FocusStop = {
  tag: string;
  id: string | null;
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  text: string;
  /** Whether this stop comes after the previous stop in DOM order, judged via
   *  compareDocumentPosition inside a single evaluate (no handles persist, so
   *  detached nodes are never compared). `null` when unjudgeable: the first
   *  stop, or the previous stop unmounted between presses (realtime re-render).
   *  Robust against unrelated DOM insertions/removals, which shift document
   *  indices but not the relative order of two connected nodes. */
  followsPrevious: boolean | null;
};

const TAB_STOP_STAMP = "data-e2e-prev-tab-stop";

/**
 * Presses Tab `count` times from a body-focused state and returns a descriptor
 * of `document.activeElement` after each press. Use to assert focus order
 * (WCAG 2.4.3) — e.g. that `followsPrevious` is never `false`.
 */
export async function tabSequence(page: Page, count: number): Promise<FocusStop[]> {
  await page.evaluate((stamp) => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
    document.querySelectorAll(`[${stamp}]`).forEach((el) => el.removeAttribute(stamp));
  }, TAB_STOP_STAMP);

  const stops: FocusStop[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate<FocusStop, string>((stamp) => {
      const el = document.activeElement as HTMLElement | null;
      const prev = document.querySelector(`[${stamp}]`);
      if (!el || el === document.body) {
        return { tag: "body", id: null, role: null, ariaLabel: null, testId: null, text: "", followsPrevious: null };
      }
      const followsPrevious =
        prev && prev !== el ? Boolean(prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
      prev?.removeAttribute(stamp);
      el.setAttribute(stamp, "");
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        testId: el.getAttribute("data-testid"),
        text: (el.innerText ?? "").trim().slice(0, 80),
        followsPrevious
      };
    }, TAB_STOP_STAMP);
    stops.push(stop);
  }
  await page
    .evaluate(
      (stamp) => document.querySelectorAll(`[${stamp}]`).forEach((el) => el.removeAttribute(stamp)),
      TAB_STOP_STAMP
    )
    .catch(() => {});
  return stops;
}

/**
 * Presses a landmark-jump chord (e.g. "Alt+m") and asserts the resulting
 * `document.activeElement` matches `expectedFocusSelector` AND is actually
 * visible (bounding box larger than 1×1 — guards against focusing an element
 * that is still screen-reader-clipped, the historical Alt+K skip-links bug).
 *
 * Callers must gate to chromium: WebKit's synthetic Alt+letter composes
 * special characters instead of delivering the chord.
 */
export async function assertLandmarkJump(
  page: Page,
  chord: string,
  expectedFocusSelector: string,
  contextLabel?: string
): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";

  // Retry a few times: on a fresh navigation the chord can fire before the
  // client-side keydown listener hydrates, leaving focus on <body>.
  let result = { matched: false, visible: false, actual: "(body)" };
  for (let attempt = 0; attempt < 5 && !result.matched; attempt++) {
    // Neutral starting focus so the chord isn't swallowed by a form field.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    await page.keyboard.press(chord);
    await page.waitForTimeout(200);

    result = await page.evaluate((sel) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { matched: false, visible: false, actual: "(body)" };
      const rect = el.getBoundingClientRect();
      return {
        matched: el.matches(sel),
        visible: rect.width > 1 && rect.height > 1,
        actual: `${el.tagName.toLowerCase()}#${el.id || "(no id)"}[aria-label="${el.getAttribute("aria-label") ?? ""}"]`
      };
    }, expectedFocusSelector);
  }

  expect(
    result.matched,
    `${prefix}${chord} focuses "${expectedFocusSelector}" (active element was ${result.actual})`
  ).toBe(true);
  expect(result.visible, `${prefix}${chord} target "${expectedFocusSelector}" is visibly rendered (>1×1)`).toBe(true);
}

/**
 * WCAG 1.4.10 (Reflow) check: at a 320 CSS-px-wide viewport — the spec's
 * equivalent of a 1280px window at 400% zoom — the page must not require
 * horizontal scrolling and all content must remain reachable by vertical
 * scroll (catches `overflow:hidden` shells that clip content with no way to
 * reach it).
 *
 * If the current viewport is not already 320px wide (preferred: set it via
 * `test.use({ viewport: { width: 320, height: 640 } })` on the spec), the
 * helper resizes for the check and restores the original size afterwards.
 * A viewport-disabled context (`viewport: null`) is rejected up front: there
 * would be no original size to restore.
 */
export async function assertReflowAt320(page: Page, contextLabel?: string): Promise<void> {
  const prefix = contextLabel ? `[${contextLabel}] ` : "";
  const original = page.viewportSize();
  if (!original) {
    throw new Error(
      `${prefix}assertReflowAt320 requires a viewport (got viewport: null); set one via test.use({ viewport: { width: 320, height: 640 } })`
    );
  }
  const needsResize = original.width !== 320;
  if (needsResize) {
    await page.setViewportSize({ width: 320, height: 640 });
  }

  // The test fixture's visual-test CSS pins placeholder text (dates etc.) to a
  // fixed 18ch nowrap box, which cannot reflow and falsely trips the 320px
  // check. Disable it for the measurement — real users never load that CSS.
  await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests")).catch(() => {});

  try {
    if (needsResize) {
      // Let responsive breakpoints and dvh-based layouts settle after the resize.
      await page.waitForTimeout(250);
    }

    await expect(page.getByRole("main").first(), `${prefix}main landmark visible at 320px`).toBeVisible({
      timeout: 15000
    });

    // Layout can transiently overflow while hydration/collapse effects run;
    // poll until the page-level width settles (or the deadline hits, in which
    // case the assertions below report the persistent overflow).
    await page
      .waitForFunction(
        () => {
          const scroller = document.scrollingElement ?? document.documentElement;
          return scroller.scrollWidth <= scroller.clientWidth + 1;
        },
        undefined,
        { timeout: 5000, polling: 250 }
      )
      .catch(() => {});

    // The waitForFunction above is the sole transient-overflow filter; sample
    // the assertion metrics once after it settles (or times out).
    const metrics = await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      const main = document.querySelector('main, [role="main"]') as HTMLElement | null;

      // Detect a working vertical scroll pane (app-shell pattern). The shells
      // in this app live INSIDE <main id="main-content">, so scan descendants
      // (cheap scrollHeight check first, computed style only for candidates);
      // also walk ancestors in case a future shell wraps main instead.
      const isScrollPane = (el: HTMLElement) =>
        el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(window.getComputedStyle(el).overflowY);
      let innerScrollable = false;
      if (main) {
        innerScrollable = Array.prototype.some.call(main.querySelectorAll("*"), (el: Element) =>
          isScrollPane(el as HTMLElement)
        );
        for (
          let cur: HTMLElement | null = main;
          cur && cur !== document.body && !innerScrollable;
          cur = cur.parentElement
        ) {
          innerScrollable = isScrollPane(cur);
        }
      }

      const pageScrollable = scroller.scrollHeight > scroller.clientHeight + 1;
      const contentOverflowsViewport = main ? main.scrollHeight > window.innerHeight : false;

      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        mainHeight: main?.getBoundingClientRect().height ?? 0,
        pageScrollable,
        innerScrollable,
        contentOverflowsViewport
      };
    });

    // On persistent overflow, name the widest offending elements so the
    // failure is actionable without re-running locally.
    let offenderNote = "";
    if (metrics.scrollWidth > metrics.clientWidth + 1) {
      const offenders = await page
        .evaluate(() => {
          const limit = (document.scrollingElement ?? document.documentElement).clientWidth + 1;
          const out: string[] = [];
          document.querySelectorAll("body *").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.right <= limit || r.width <= 10) return;
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return;
            const pr = el.parentElement?.getBoundingClientRect();
            if (pr && pr.right > limit) return; // report overflow roots only
            out.push(
              `<${el.tagName.toLowerCase()} right=${Math.round(r.right)} w=${Math.round(r.width)}> "${((el as HTMLElement).innerText ?? "").slice(0, 50).replace(/\n/g, " ")}"`
            );
          });
          return out.slice(0, 5);
        })
        .catch(() => [] as string[]);
      offenderNote = offenders.length > 0 ? `\n  overflowing elements:\n  ${offenders.join("\n  ")}` : "";
    }

    expect(
      metrics.scrollWidth,
      `${prefix}no page-level horizontal scrolling at 320px (scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth})${offenderNote}`
    ).toBeLessThanOrEqual(metrics.clientWidth + 1);

    expect(metrics.mainHeight, `${prefix}main content has non-zero height at 320px`).toBeGreaterThan(0);

    // If the content is taller than the viewport, SOME scroll mechanism must
    // exist — either the document scrolls or an inner overflow:auto pane does.
    // (overflow:hidden shells with neither = the audit's "clipped, can't scroll".)
    if (metrics.contentOverflowsViewport) {
      expect(
        metrics.pageScrollable || metrics.innerScrollable,
        `${prefix}content taller than viewport is reachable by vertical scroll (document or inner pane)`
      ).toBe(true);
    }
  } finally {
    await page.evaluate(() => document.documentElement.setAttribute("data-visual-tests", "")).catch(() => {});
    if (needsResize) {
      await page.setViewportSize(original);
    }
  }
}
