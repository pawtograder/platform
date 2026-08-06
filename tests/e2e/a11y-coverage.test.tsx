/**
 * Student-page WCAG 2.1 AA coverage sweep.
 *
 * Scans every student-facing route in `a11y/studentRoutes.ts` — 17 were
 * scanned before this suite existed; the registry covers the whole student
 * surface and names, with a reason, the handful it still cannot reach.
 *
 * Per route it checks the criteria that are decidable without new measurement
 * infrastructure:
 *   - axe WCAG 2.1 A/AA + heading-order, in BOTH color schemes (dark mode had
 *     zero coverage before this), reading `violations` AND `incomplete`
 *   - landmark structure, page title, html[lang]   (1.3.1 / 2.4.2 / 3.1.1)
 *   - reflow at 320px                              (1.4.10 — was 7 routes)
 *
 * It does NOT fail on pre-existing findings: those are recorded in
 * `a11y/baseline.json` (see baseline.ts for why). New findings fail.
 *
 * Opt-in, like the other heavy a11y lanes, until we decide the workflow is
 * worth gating on:  A11Y_COVERAGE=1 npx playwright test tests/e2e/a11y-coverage.test.tsx
 */
import { expect, test } from "../global-setup";
import { loginAsUser } from "./TestingUtils";
import { assertPageHasLandmarks, assertReflowAt320 } from "./axeStudentA11y";
import { settlePage } from "../../tools/a11y-judge/agent/pageReady";
import { collectFindings, type ColorScheme, type Finding } from "./a11y/scan";
import {
  ACTIVE_ROUTES,
  SKIPPED_ROUTES,
  seedStudentSurface,
  STUDENT_ROUTES,
  type StudentSurface
} from "./a11y/studentRoutes";
import {
  formatFindings,
  isUpdateMode,
  loadBaseline,
  newFindings,
  toEntries,
  writeBaseline,
  type BaselineEntry
} from "./a11y/baseline";

const SCHEMES: ColorScheme[] = ["light", "dark"];

// Accumulated across the file so `A11Y_BASELINE_UPDATE=1` can rewrite the
// ledger in one pass rather than per-test.
const recorded: Record<string, BaselineEntry> = {};

/**
 * Run a structural assertion and turn a failure into a Finding instead of
 * throwing, so one bad route cannot hide the rest of the sweep and so
 * structural defects are baselined on the same terms as axe findings.
 */
async function structural(rule: string, fn: () => Promise<void>): Promise<Finding[]> {
  try {
    await fn();
    return [];
  } catch (e) {
    const message = (e as Error).message.split("\n")[0].trim();
    return [{ rule, kind: "violation", impact: "serious", nodes: 1, sample: message.slice(0, 200) }];
  }
}

test.describe("student pages — WCAG 2.1 AA coverage sweep", () => {
  test.skip(!process.env.A11Y_COVERAGE, "coverage sweep is opt-in (set A11Y_COVERAGE=1)");
  // Deliberately NOT serial: this is a sweep, and one unreachable route must
  // not prevent the other 30+ from being measured.

  // A scanned route costs far more than a normal e2e test: login, settle, then
  // FOUR axe passes (violations + best-practice rules, in two color schemes),
  // plus landmark and a 320px reflow measurement. That lands around 25s per
  // route on a prod build, so the repo-wide 60s in playwright.config.ts leaves
  // no headroom — canvas-classes and public-poll timed out on it while still
  // rendering fine, which reads like a broken route rather than a slow one.
  // Raised only for this suite; the rest of the estate keeps the 60s default.
  test.describe.configure({ timeout: 180_000 });

  let surface: StudentSurface;

  test.beforeAll(async () => {
    surface = await seedStudentSurface();
  });

  test("registry covers the student surface and names its gaps", async () => {
    // A guard against the registry silently shrinking: coverage regressions
    // should be as loud as test failures.
    expect(STUDENT_ROUTES.length, "student routes declared").toBeGreaterThanOrEqual(40);
    for (const r of SKIPPED_ROUTES) {
      expect(r.skip, `skipped route ${r.id} must say why`).toBeTruthy();
    }
    console.log(
      `[a11y-coverage] ${ACTIVE_ROUTES.length} routes scanned, ${SKIPPED_ROUTES.length} skipped:\n` +
        SKIPPED_ROUTES.map((r) => `    - ${r.id}: ${r.skip}`).join("\n")
    );
  });

  for (const route of ACTIVE_ROUTES) {
    test(`${route.id} — ${route.label}`, async ({ page }) => {
      const baseline = loadBaseline();

      if (!route.anonymous) {
        await loginAsUser(page, surface.student, surface.course);
      }
      const url = route.path(surface);
      await page.goto(url);
      await page.waitForLoadState("domcontentloaded");
      // Settle before scanning. Without this the two color-scheme passes see
      // different DOMs: popovers and checkbox groups mount late (after realtime
      // connects), so the second pass picks up rules the first never saw and the
      // baseline never reproduces. settlePage is the a11y-judge harness's shared
      // wait — it blocks until realtime reports connected and every live region's
      // text stops changing, which is the same non-determinism the evidence
      // collector had to solve.
      await settlePage(page);

      const perScheme: Record<ColorScheme, Finding[]> = { light: [], dark: [] };
      for (const scheme of SCHEMES) {
        perScheme[scheme] = await collectFindings(page, scheme);
      }

      // Structural checks. Both need a <main> landmark (assertReflowAt320
      // measures it directly), so auth shells that legitimately have none are
      // exempt. Recorded under "light" — they are scheme-independent.
      if (route.expectLandmarks !== false) {
        perScheme.light.push(
          ...(await structural("landmark-structure", () => assertPageHasLandmarks(page, route.label)))
        );
        perScheme.light.push(...(await structural("reflow-320", () => assertReflowAt320(page, route.label))));
      }

      const all: Finding[] = [];
      for (const scheme of SCHEMES) {
        const findings = perScheme[scheme];
        Object.assign(recorded, toEntries(route.id, scheme, findings));
        all.push(...findings);

        if (!isUpdateMode()) {
          const fresh = newFindings(baseline, route.id, scheme, findings);
          expect(
            fresh,
            `[${route.label}] ${scheme} mode — NEW accessibility findings (not in baseline.json):\n${formatFindings(fresh)}`
          ).toEqual([]);
        }
      }

      if (all.length > 0) {
        console.log(`[a11y-coverage] ${route.id}: ${all.length} finding(s)\n${formatFindings(all)}`);
      }
    });
  }

  test.afterAll(async () => {
    if (isUpdateMode()) {
      writeBaseline(
        recorded,
        "Pre-existing findings on student-facing routes at the time the coverage sweep was introduced. " +
          "Entries are debt, not policy — deleting a line is the proof a defect was fixed."
      );
      console.log(`[a11y-coverage] baseline rewritten with ${Object.keys(recorded).length} entries`);
    }
  });
});
