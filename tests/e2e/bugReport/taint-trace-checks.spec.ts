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
 */
import { expect, test } from "@/tests/global-setup";
import { CURRENT_CLASSIFICATION, checkObserved, checkSinks, type Classification } from "@/lib/bugReport/traceCheck";
import { loginAsUser } from "../TestingUtils";
import { canaryPersonName, canarySentence, registerCanary, resolveCanary, type CanaryRegistry } from "./canaryRegistry";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { TaintTracer } from "./taintTrace";

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
  await loginAsUser(page, seed.students[0], seed.course);
  await page.goto(seed.routes.helpRequest);
  const request = [...seed.registry].find(([, e]) => e.column === "help_requests.request")![0];
  await expect(page.getByText(request).first()).toBeVisible();
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
  expect(message).toContain("/course/[course_id]/office-hours/request/[request_id]");
  // The value was rendered, not only fetched.
  const rendered = tracer.sinkHits().filter((h) => h.canary === request);
  expect(rendered.length).toBeGreaterThan(0);
});

test("I2: a key the schema lacks, added to a live response, fails the unmodified classification", async ({
  page,
  context
}) => {
  const registry: CanaryRegistry = new Map(seed.registry);
  const probe = canarySentence();
  registerCanary(resolveCanary({ registry })!, probe.text, {
    kind: "free_text",
    column: "profiles.i2_probe_column",
    rowId: 0,
    anchors: [probe.anchor]
  });
  const tracer = new TaintTracer({ registry });
  await tracer.attachContext(context);
  await context.route("**/rest/v1/profiles?*", async (route) => {
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
  expect(failures.join("\n")).toMatch(/profiles\.i2_probe_column from rest:\S+ carried a free_text canary on \/course/);
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
