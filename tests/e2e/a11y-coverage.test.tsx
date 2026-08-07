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
 *     zero coverage before this), reading `violations` AND `incomplete`, with
 *     the screenshot-masking mode OFF so axe measures the real UI
 *   - page-title / html-lang / main-landmark / nav-landmarks, one baseline key
 *     each so a recorded defect cannot mask the criteria behind it
 *     (2.4.2 / 3.1.1 / 1.3.1)
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
import {
  assertHtmlLang,
  assertMainLandmark,
  assertNavLandmarks,
  assertPageTitle,
  assertReflowAt320
} from "./axeStudentA11y";
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
// ledger in one pass rather than per-test. `coveredRoutes` is what lets
// writeBaseline tell a full sweep from a filtered or crashed one.
const recorded: Record<string, BaselineEntry> = {};
const coveredRoutes = new Set<string>();

/**
 * Run a structural assertion and turn a failure into a Finding instead of
 * throwing, so one bad route cannot hide the rest of the sweep and so
 * structural defects are baselined on the same terms as axe findings.
 *
 * One rule id per criterion, deliberately: the baseline key is
 * route|scheme|rule|kind, so a shared id would let one recorded defect suppress
 * every other criterion behind it. `assertPageHasLandmarks` alone spans 1.3.1,
 * 2.4.2 and 3.1.1, and its try/catch stops at the first failure.
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

/** Routes whose final URL is legitimately not the one requested. */
const REDIRECTS_BY_DESIGN = new Set(["root"]);

test.describe("student pages — WCAG 2.1 AA coverage sweep", () => {
  // Update mode enables the suite too: otherwise `A11Y_BASELINE_UPDATE=1` alone
  // skips every test, afterAll never runs, and the regeneration silently no-ops.
  test.skip(
    !process.env.A11Y_COVERAGE && !isUpdateMode(),
    "coverage sweep is opt-in (set A11Y_COVERAGE=1, or A11Y_BASELINE_UPDATE=1 to re-record)"
  );
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
      // A route that never rendered still scans clean, so without these three
      // checks an unresolved fixture id ("/office-hours/null") or a bounce to
      // /sign-in counts as covered. False coverage is worse than a known gap:
      // the registry's whole claim is that it is an honest denominator.
      expect(url, `[${route.label}] path has an unresolved fixture id: ${url}`).not.toMatch(
        /\/(null|undefined)(\/|$)|\/\//
      );
      const response = await page.goto(url);
      expect(response?.status() ?? 0, `[${route.label}] ${url} returned an error status`).toBeLessThan(400);
      await page.waitForLoadState("domcontentloaded");
      // "Bounced to an auth or error shell" means landing somewhere OTHER than
      // the requested path — /sign-in is a legitimate destination for the
      // sign-in route itself.
      const intendedPath = new URL(url, "http://localhost").pathname;
      const landedPath = new URL(page.url()).pathname;
      if (!REDIRECTS_BY_DESIGN.has(route.id) && landedPath !== intendedPath) {
        expect(landedPath, `[${route.label}] ${url} redirected to ${landedPath}`).not.toMatch(
          /^\/(sign-in|login|error)$/
        );
      }
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

      // Structural checks, one baseline key per success criterion. Recorded
      // under "light" — they are scheme-independent.
      //
      // Title and lang apply to every route including auth shells; only the
      // landmark checks are exempt where a shell legitimately has none.
      perScheme.light.push(...(await structural("page-title", () => assertPageTitle(page, route.label))));
      perScheme.light.push(...(await structural("html-lang", () => assertHtmlLang(page, route.label))));
      let mainLandmarkFailed = false;
      if (route.expectLandmarks !== false) {
        const mainFindings = await structural("main-landmark", () => assertMainLandmark(page, route.label));
        mainLandmarkFailed = mainFindings.length > 0;
        perScheme.light.push(...mainFindings);
        perScheme.light.push(...(await structural("nav-landmarks", () => assertNavLandmarks(page, route.label))));
      }
      // Reflow is gated separately from the landmark checks: assertReflowAt320
      // needs a <main> to measure, but "has no nav landmark" is not a reason to
      // skip 1.4.10. Folding it into expectLandmarks left sign-in — which does
      // render <main id="main-content"> — with desktop-only coverage.
      //
      // It is skipped when the main landmark is already missing, because
      // assertReflowAt320 asserts that landmark first: recording both would put
      // two rows in the ledger for one defect, and the reflow row would read as
      // a measurement that never happened.
      if ((route.expectReflow ?? true) && !mainLandmarkFailed) {
        perScheme.light.push(...(await structural("reflow-320", () => assertReflowAt320(page, route.label))));
      }

      const all: Finding[] = [];
      coveredRoutes.add(route.id);
      for (const scheme of SCHEMES) {
        const findings = perScheme[scheme];
        Object.assign(recorded, toEntries(route.id, scheme, findings));
        all.push(...findings);

        if (!isUpdateMode()) {
          const fresh = newFindings(baseline, route.id, scheme, findings);
          expect(
            fresh,
            `[${route.label}] ${scheme} mode — accessibility findings that are new, or affect more nodes than ` +
              `baseline.json records:\n${formatFindings(fresh)}`
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
          "Entries are debt, not policy — deleting a line is the proof a defect was fixed.",
        { expected: ACTIVE_ROUTES.map((r) => r.id), covered: coveredRoutes }
      );
      console.log(`[a11y-coverage] baseline rewritten with ${Object.keys(recorded).length} entries`);
    }
  });
});
