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
 * Gated on A11Y_COVERAGE so a normal `npx playwright test` skips it, but it is
 * NOT opt-in in CI: the `e2e-local` job in .github/workflows/deploy.yml runs it
 * against the same stack on every PR, and a new finding fails the build. That
 * is what makes a baseline deletion an assertion rather than a claim.
 *
 * Locally:
 *   npm run a11y:coverage
 *   (= A11Y_COVERAGE=1 playwright test tests/e2e/a11y-coverage.test.tsx --project=chromium)
 *
 * After fixing a defect, re-record with `npm run a11y:coverage:update` and
 * commit the shorter ledger; CI runs in check mode and fails if the sweep
 * modifies baseline.json.
 *
 * `--project=chromium` is not optional. playwright.config.ts declares chromium
 * AND webkit, and baseline.json is keyed route|scheme|rule|kind with no browser
 * dimension, so a two-project run compares webkit findings against a
 * chromium-recorded ledger and, under A11Y_BASELINE_UPDATE, has two afterAll
 * hooks race to rewrite the same file. The describe below also skips non-chromium
 * projects so forgetting the flag costs nothing.
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

// Read once per worker: the ledger cannot change mid-run (writeBaseline only
// runs in afterAll), so re-parsing it inside every route test was 37 synchronous
// reads of the same file.
const baseline = loadBaseline();

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
    // `e` is normally a Playwright assertion error, but a browser/target crash
    // or a `throw "string"` would otherwise make `.message.split` a TypeError
    // inside the catch and take down the whole route test.
    const raw = e instanceof Error ? e.message : String(e);
    const message = (raw ?? "").split("\n")[0].trim();
    return [{ rule, kind: "violation", impact: "serious", nodes: 1, sample: message.slice(0, 200) }];
  }
}

/**
 * Routes whose final URL is legitimately not the one requested.
 *
 * `root` is here because an AUTHENTICATED visit to `/` is bounced to `/course`
 * by utils/supabase/middleware.ts. The sweep visits it signed out, where
 * app/page.tsx renders in place, so today the entry is inert — but it stays,
 * because the day the sweep gains a signed-in pass it stops being inert.
 */
const REDIRECTS_BY_DESIGN = new Set(["root"]);

test.describe("student pages — WCAG 2.1 AA coverage sweep", () => {
  // Update mode enables the suite too: otherwise `A11Y_BASELINE_UPDATE=1` alone
  // skips every test, afterAll never runs, and the regeneration silently no-ops.
  test.skip(
    !process.env.A11Y_COVERAGE && !isUpdateMode(),
    "coverage sweep is opt-in (set A11Y_COVERAGE=1, or A11Y_BASELINE_UPDATE=1 to re-record)"
  );
  // One browser only. baseline.json's key is route|scheme|rule|kind with no
  // browser dimension, so a second project would measure webkit's accessible-name
  // and contrast resolution against a chromium-recorded ledger — and in update
  // mode both projects' afterAll hooks would rewrite the same file, last writer
  // wins. Pick chromium, matching the documented regeneration command.
  test.skip(({ browserName }) => browserName !== "chromium", "the ledger is recorded on chromium only");
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
    // The declared total is not the number that matters: moving rows into
    // SKIPPED_ROUTES leaves it untouched while shrinking what is actually
    // measured — and writeBaseline derives `expected` from ACTIVE_ROUTES too, so
    // a shrunk active set passes the partial-run guard and drops those routes'
    // rows from the ledger. Since deleting a row is how this repo claims a fix,
    // that would fabricate the proof. Assert the measured count as well.
    expect(ACTIVE_ROUTES.length, "student routes actually scanned").toBeGreaterThanOrEqual(39);
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
      if (!route.anonymous) {
        await loginAsUser(page, surface.student, surface.course);
      }
      const url = route.path(surface);
      // A route that never rendered still scans clean, so without these three
      // checks an unresolved fixture id ("/office-hours/null") or a bounce to
      // /sign-in counts as covered. False coverage is worse than a known gap:
      // the registry's whole claim is that it is an honest denominator.
      //
      // A segment is bad when it is empty, "null", "undefined" or "NaN" — the
      // four things a missing id stringifies to. Matching on segments (split on
      // `/`, after dropping any query/hash) rather than on the raw string is what
      // catches `/flashcards/` and `/flashcards/null?tab=x`, which the earlier
      // `/(null|undefined)(\/|$)/` form let through.
      const pathname = url.split(/[?#]/)[0];
      const badSegment = (pathname === "/" ? [] : pathname.split("/").slice(1)).find(
        (seg) => seg === "" || seg === "null" || seg === "undefined" || seg === "NaN"
      );
      expect(
        badSegment,
        `[${route.label}] path has an unresolved fixture id (segment "${badSegment}"): ${url}`
      ).toBeUndefined();
      const response = await page.goto(url);
      // `?? 599` deliberately fails closed: `page.goto` resolves to null when the
      // navigation produced no document response, and `?? 0` would have made the
      // one case this guard exists for pass silently.
      expect(response?.status() ?? 599, `[${route.label}] ${url} returned no/error status`).toBeLessThan(400);
      await page.waitForLoadState("domcontentloaded");
      // Any redirect is a coverage problem, not just a bounce to an auth shell.
      // The earlier form only rejected /sign-in, /login and /error, which let a
      // route be recorded under its own baseline key while a completely
      // different page was scanned — `/course` redirecting to `/course/<id>`
      // (app/course/page.tsx: `sortedRoles?.length === 1`) filed the course
      // dashboard's findings under `course-picker`. A route that legitimately
      // moves declares it in REDIRECTS_BY_DESIGN or carries a `skip` reason.
      const intendedPath = new URL(url, "http://localhost").pathname;
      const landedPath = new URL(page.url()).pathname;
      if (!REDIRECTS_BY_DESIGN.has(route.id)) {
        expect(
          landedPath,
          `[${route.label}] ${url} redirected to ${landedPath}; the findings would be recorded under "${route.id}". ` +
            `Reach the intended page, add the id to REDIRECTS_BY_DESIGN, or give the route a skip reason.`
        ).toBe(intendedPath);
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
    // A worker that ran no route at all (every test skipped by the browser
    // modifier, or filtered out by --grep) has nothing to record and nothing to
    // prove; writing would hit the partial-run guard and report a spurious
    // afterAll failure. Zero covered is a no-op, not a partial run.
    if (isUpdateMode() && coveredRoutes.size > 0) {
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
