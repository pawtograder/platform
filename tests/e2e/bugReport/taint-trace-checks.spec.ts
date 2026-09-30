/**
 * Taint trace checks, nightly tier (spec §7.3 I2, I3).
 *
 * I2: a rendered column that `privacy.ts` does not classify fails the check, naming the column and
 * the page. The "new column" is simulated against the classification: the trace records a real
 * page, and the check runs against a copy of the classification with that column removed, which is
 * exactly what the check sees after a migration adds a column the generator has not classified.
 * A second case adds a key the schema doesn't have to a real PostgREST response (a route
 * rewrite), which the unmodified classification must reject too.
 *
 * I3: a name rendered inside a `data-report-unmask` component (the E2E-only harness page) fails
 * the check, naming the component.
 *
 * Phase 2: the upload scan finds a canary that reached a would-be upload (a console breadcrumb no
 * ingest point saw), and says on which route and where in the upload.
 */
import { expect, test } from "@/tests/global-setup";
import { CURRENT_CLASSIFICATION, checkObserved, checkSinks, type Classification } from "@/lib/bugReport/traceCheck";
import { loginAsUser } from "../TestingUtils";
import { canaryPersonName, canarySentence, registerCanary, resolveCanary, type CanaryRegistry } from "./canaryRegistry";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { waitForRecording } from "./report";
import { TaintTracer } from "./taintTrace";
import { describeUploadHits, isUploadTraceMode, UploadScanner } from "./uploadTrace";

test.describe.configure({ mode: "serial" });

let seed: CanarySeed;

test.beforeAll(async () => {
  seed = await seedCanaryClass({ studentCount: 2 });
});

function without(c: Classification, column: string): Classification {
  const COLUMNS = { ...c.COLUMNS };
  delete COLUMNS[column];
  return { ...c, COLUMNS };
}

test("I2: an unclassified rendered column fails, naming the column and page", async ({ page, context }) => {
  const tracer = new TaintTracer({ registry: seed.registry });
  await tracer.attachContext(context);
  await loginAsUser(page, seed.instructor, seed.course);
  await page.goto(seed.routes.manageHelpRequest);
  const request = [...seed.registry].find(([, e]) => e.column === "help_requests.request")![0];
  // Rendered (possibly in a collapsed notification), which is what a recording would capture.
  await expect(page.getByText(request).first()).toBeAttached();
  await tracer.scanNow(context);
  await tracer.flush();

  const flows = tracer.observedFlows();
  expect(flows.some((f) => f.key === "help_requests.request")).toBe(true);
  // The real classification covers it...
  expect(checkObserved(flows.filter((f) => f.key === "help_requests.request"))).toEqual([]);
  // ...and without the entry the check fails, naming the column and the page.
  const failures = checkObserved(flows, without(CURRENT_CLASSIFICATION, "help_requests.request"));
  const message = failures.map((f) => f.message).join("\n");
  expect(message).toContain("help_requests.request");
  expect(message).toContain("/course/[course_id]/manage/office-hours/request/[request_id]");
  // The value was rendered, not only fetched.
  const rendered = tracer.sinkHits().filter((h) => h.canary === request);
  expect(rendered.length).toBeGreaterThan(0);
});

test("I2: a key the schema lacks, added to a live response, fails the unmodified classification", async ({
  page,
  context
}) => {
  // A deliberate probe: kept out of `workerCanaries` (as the phase 2 probe is), so the worker's
  // trace and the run's strict check never count it; only this test's tracer looks for it.
  const registry: CanaryRegistry = new Map(seed.registry);
  const probe = canarySentence();
  registry.set(probe.text, {
    kind: "free_text",
    column: "user_roles.i2_probe_column",
    rowId: 0,
    anchors: [probe.anchor]
  });
  const tracer = new TaintTracer({ registry });
  await tracer.attachContext(context);
  await context.route("**/rest/v1/user_roles?*", async (route) => {
    const response = await route.fetch();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    const add = (row: unknown) =>
      row && typeof row === "object" ? { ...(row as object), i2_probe_column: probe.text } : row;
    const patched = Array.isArray(body) ? body.map(add) : add(body);
    await route.fulfill({ response, json: patched });
  });
  await loginAsUser(page, seed.instructor, seed.course);
  await page.goto(seed.routes.manageEnrollments);
  await page.waitForLoadState("networkidle").catch(() => {});
  await tracer.flush();
  const failures = checkObserved(tracer.observedFlows()).map((f) => f.message);
  expect(failures.join("\n")).toMatch(
    /user_roles\.i2_probe_column from rest:\S+ carried a free_text canary on \/course/
  );
});

test("I3: a name inside data-report-unmask fails, naming the component", async ({ page, context }) => {
  const registry: CanaryRegistry = new Map();
  const person = canaryPersonName();
  registerCanary(resolveCanary({ registry })!, person.full, {
    kind: "name",
    column: "profiles.name",
    rowId: "harness",
    anchors: [person.first.toLowerCase(), person.last.toLowerCase()]
  });
  const tracer = new TaintTracer({ registry });
  await tracer.attachContext(context);
  await page.goto(`/e2e-harness/bug-report-unmask?name=${encodeURIComponent(person.full)}`);
  await expect(page.getByTestId("unmask-harness-name")).toHaveText(person.full);
  // Naming the component needs component annotation (`data-sentry-component`), which only the
  // full build profile has. The PR tier builds with ci-fast, so it skips there; the nightly
  // trace (BUG_REPORT_TRACE=1, full profile) must not.
  const annotated = (await page.locator("[data-sentry-component]").count()) > 0;
  if (!annotated && process.env.BUG_REPORT_TRACE !== "1" && process.env.BUG_REPORT_TRACE !== "true") {
    test.skip(true, "needs a full-profile build (SENTRY_BUILD_PROFILE=full) for component names");
  }
  expect(annotated, "this build has no data-sentry-component annotations (build with the full profile)").toBe(true);
  await tracer.scanNow(context);
  await tracer.flush();

  const sinks = tracer.sinks();
  expect(sinks["/e2e-harness/bug-report-unmask"]).toBeDefined();
  const failures = checkSinks(sinks).map((f) => f.message);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("BugReportUnmaskHarness carries data-report-unmask");
  expect(failures[0]).toContain("name");
  expect(failures[0]).toContain("/e2e-harness/bug-report-unmask");
});

test("phase 2: a canary that reaches a would-be upload is found, with the route and its place", async ({
  page,
  context
}) => {
  test.skip(!isUploadTraceMode(), "phase 2 runs only under BUG_REPORT_TRACE_UPLOAD=1 (and needs an E2E_ENABLE build)");
  // Logged on a recorded page without passing through any ingest point, so nothing taints it and
  // the console breadcrumb carries it into the upload. Kept out of `workerCanaries`, so the
  // worker's own scan (and the run's report) never counts this deliberate leak.
  const probe = canarySentence();
  const registry: CanaryRegistry = new Map([
    [probe.text, { kind: "free_text", column: "phase2.console_probe", rowId: 0, anchors: [probe.anchor] }]
  ]);
  const scanner = new UploadScanner({ registry });
  scanner.currentTest = "phase 2 probe";
  await scanner.attachContext(context, { manage: true });
  await loginAsUser(page, seed.students[0], seed.course);
  await page.goto(seed.routes.studentAssignments);
  await waitForRecording(page);
  // eslint-disable-next-line no-console
  await page.evaluate((text) => console.log(text), probe.text);

  await scanner.scanPage(page, "probe");
  const hits = scanner.hitsFor("phase 2 probe");
  expect(hits.map((h) => h.column)).toContain("phase2.console_probe");
  const hit = hits.find((h) => h.column === "phase2.console_probe")!;
  expect(hit.route).toBe("/course/[course_id]/assignments");
  expect(hit.where).toMatch(/Custom breadcrumb console/);
  expect(describeUploadHits([hit])).toContain("phase2.console_probe");
});
