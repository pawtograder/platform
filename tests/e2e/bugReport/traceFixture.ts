/**
 * Opt-in wiring of the taint trace into the shared Playwright `test` (`tests/global-setup.ts`).
 *
 * Under `BUG_REPORT_TRACE=1`:
 * - the seed helpers in `TestingUtils.ts` write canaries (see `canaryRegistry.ts`);
 * - every browser context a test opens, through the `context`/`page` fixtures or
 *   `browser.newContext()`/`browser.newPage()`, is traced by the worker's `TaintTracer`;
 * - each worker writes what it saw to `$BUG_REPORT_TRACE_DIR` (default
 *   `test-results/bug-report-trace`) at teardown, and the global teardown (`traceTeardown.ts`)
 *   merges the workers into `lib/bugReport/generated/`.
 *
 * With `BUG_REPORT_TRACE_UPLOAD=1` as well (phase 2), every traced test also records with the
 * course flag on and a policy listing every course page, and every would-be upload is scanned for
 * canaries; see `uploadTrace.ts`.
 *
 * With `BUG_REPORT_TRACE_STRICT=1` as well, a test fails at teardown when it observed an
 * unclassified flow or PII inside `data-report-unmask`, naming the key or component and the page,
 * or (phase 2) when a canary reached a would-be upload.
 */
import {
  test as playwrightTest,
  type Browser,
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightWorkerArgs,
  type TestInfo
} from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkObserved, checkSinks, isBlocking } from "@/lib/bugReport/traceCheck";
import { isTraceMode } from "./canaryRegistry";
import { TaintTracer } from "./taintTrace";
import { describeUploadHits, isUploadTraceMode, managesRecording, UploadScanner } from "./uploadTrace";

export { isTraceMode };

export function traceDir(): string {
  return process.env.BUG_REPORT_TRACE_DIR || path.join(process.cwd(), "test-results", "bug-report-trace");
}

export function isStrictTrace(): boolean {
  return process.env.BUG_REPORT_TRACE_STRICT === "1";
}

/**
 * The worker's tracer. Test harness pages (`/e2e-harness/*`, `/course/[course_id]/e2e-harness/*`,
 * `/e2e/*`) are left out of the committed output and the strict checks: they render canaries in
 * unmasked components on purpose, and their specs assert on that themselves.
 */
export const HARNESS_ROUTES = /^(\/course\/\[course_id\])?\/e2e-harness(\/|$)|^\/e2e(\/|$)/;
export const workerTracer = new TaintTracer({ ignoreRoutes: HARNESS_ROUTES });

/** The worker's phase-2 scanner, used only under `BUG_REPORT_TRACE_UPLOAD=1`. */
export const workerUploadScanner = new UploadScanner();

/** Time added to each test's timeout in phase 2, for collecting and redacting its uploads. */
const UPLOAD_SCAN_EXTRA_MS = 60_000;

/** The spec file of the running test or hook, or null outside one. */
function currentSpecFile(): string | null {
  try {
    return playwrightTest.info().file;
  } catch {
    return null;
  }
}

const patched = new WeakSet<Browser>();

/** Makes every context `browser` creates from now on traced by `workerTracer`. */
function patchBrowser(browser: Browser) {
  if (patched.has(browser)) return;
  patched.add(browser);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
    const context = await newContext(...args);
    await workerTracer.attachContext(context);
    if (isUploadTraceMode()) {
      const file = currentSpecFile();
      await workerUploadScanner.attachContext(context, { manage: file === null || !managesRecording(file) });
    }
    return context;
  };
}

function testName(testInfo: TestInfo): string {
  const file = path.relative(process.cwd(), testInfo.file);
  return `${file} › ${testInfo.titlePath.slice(1).join(" › ")}`;
}

type TraceWorkerFixtures = { _bugReportTraceWorker: void };
type TraceTestFixtures = { _bugReportTraceTest: void };

export const traceFixtures: Fixtures<TraceTestFixtures, TraceWorkerFixtures, PlaywrightTestArgs, PlaywrightWorkerArgs> =
  {
    _bugReportTraceWorker: [
      async ({ browser }, use, workerInfo) => {
        patchBrowser(browser);
        await use();
        if (isUploadTraceMode()) {
          workerUploadScanner.currentTest = "(after the last test)";
          await workerUploadScanner.scanAll("worker teardown");
        }
        await workerTracer.flush();
        const dir = path.join(traceDir(), "partials");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, `worker-${workerInfo.parallelIndex}-${process.pid}.json`),
          JSON.stringify({
            ...workerTracer.partial(),
            upload: isUploadTraceMode() ? workerUploadScanner.partial() : undefined
          })
        );
      },
      { scope: "worker", auto: true }
    ],
    _bugReportTraceTest: [
      async ({}, use, testInfo) => {
        workerTracer.currentTest = testName(testInfo);
        const upload = isUploadTraceMode();
        if (upload) {
          workerUploadScanner.currentTest = workerTracer.currentTest;
          if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + UPLOAD_SCAN_EXTRA_MS);
        }
        const before = new Set(workerTracer.observedFlows().map((f) => `${f.source}|${f.key}|${f.kind}`));
        await use();
        // The test's own contexts were scanned as they closed; this covers ones still open.
        if (upload) await workerUploadScanner.scanAll("test end");
        await workerTracer.flush();
        if (!isStrictTrace()) return;
        const fresh = workerTracer
          .observedFlows()
          .filter((f) => !before.has(`${f.source}|${f.key}|${f.kind}`) && f.test === workerTracer.currentTest);
        const failures = [
          ...checkObserved(fresh)
            .filter(isBlocking)
            .map((f) => f.message),
          ...checkSinks(workerTracer.sinksFor(workerTracer.currentTest)).map((f) => f.message)
        ];
        const leaks = upload ? workerUploadScanner.hitsFor(workerTracer.currentTest) : [];
        if (leaks.length > 0) failures.push(`canaries in the would-be upload:\n${describeUploadHits(leaks)}`);
        if (failures.length > 0) {
          throw new Error(`Bug report taint trace:\n${[...new Set(failures)].join("\n")}`);
        }
      },
      { auto: true }
    ]
  };
