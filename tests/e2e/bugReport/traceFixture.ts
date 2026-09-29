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
 * With `BUG_REPORT_TRACE_STRICT=1` as well, a test fails at teardown when it observed an
 * unclassified flow or PII inside `data-report-unmask`, naming the key or component and the page.
 */
import type { Browser, Fixtures, PlaywrightTestArgs, PlaywrightWorkerArgs, TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkObserved, checkSinks } from "@/lib/bugReport/traceCheck";
import { isTraceMode } from "./canaryRegistry";
import { TaintTracer } from "./taintTrace";

export { isTraceMode };

export function traceDir(): string {
  return process.env.BUG_REPORT_TRACE_DIR || path.join(process.cwd(), "test-results", "bug-report-trace");
}

export function isStrictTrace(): boolean {
  return process.env.BUG_REPORT_TRACE_STRICT === "1";
}

/** The worker's tracer. Test harness pages under /e2e-harness are left out of the committed output. */
export const workerTracer = new TaintTracer({ ignoreRoutes: /^\/e2e-harness(\/|$)/ });

const patched = new WeakSet<Browser>();

/** Makes every context `browser` creates from now on traced by `workerTracer`. */
function patchBrowser(browser: Browser) {
  if (patched.has(browser)) return;
  patched.add(browser);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
    const context = await newContext(...args);
    await workerTracer.attachContext(context);
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
        await workerTracer.flush();
        const dir = path.join(traceDir(), "partials");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, `worker-${workerInfo.parallelIndex}-${process.pid}.json`),
          JSON.stringify(workerTracer.partial())
        );
      },
      { scope: "worker", auto: true }
    ],
    _bugReportTraceTest: [
      async ({}, use, testInfo) => {
        workerTracer.currentTest = testName(testInfo);
        const before = new Set(workerTracer.observedFlows().map((f) => `${f.source}|${f.key}|${f.kind}`));
        await use();
        await workerTracer.flush();
        if (!isStrictTrace()) return;
        const fresh = workerTracer
          .observedFlows()
          .filter((f) => !before.has(`${f.source}|${f.key}|${f.kind}`) && f.test === workerTracer.currentTest);
        const failures = [
          ...checkObserved(fresh).map((f) => f.message),
          ...checkSinks(workerTracer.sinksFor(workerTracer.currentTest)).map((f) => f.message)
        ];
        if (failures.length > 0) {
          throw new Error(`Bug report taint trace:\n${[...new Set(failures)].join("\n")}`);
        }
      },
      { auto: true }
    ]
  };
