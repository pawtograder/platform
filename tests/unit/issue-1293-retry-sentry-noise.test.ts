/**
 * #1293: the dispatcher reports to Sentry only where it gives up on a message.
 *
 * `processMessage` has four paths that abandon work (poison pill, rejected scan path, rate-limit
 * budget exhausted, retry budget exhausted) and two that requeue. Before this change the transient
 * requeue path captured too, so a failure that succeeded on its next attempt still raised a Sentry
 * event, and a message that exhausted its budget raised one per attempt plus the final one.
 *
 * That was tolerable while transient provider failures were swallowed. #1132 made them propagate
 * here instead, which is correct and is what fixes #1077, but it means a 200-student finalize (nine
 * structured answers each, about 1800 provider calls) can produce hundreds of events for a
 * condition the backoff handles silently. The events worth triaging are the give-ups, and they were
 * buried among the recoveries.
 *
 * Source-level rather than behavioral, for the same reason as
 * `issue-1075-finalize-select-call-site.test.ts`: the worker is a Deno module and Jest cannot
 * import it. The retry behavior itself is covered by `tests/e2e/exam-finalize-provider-retry.spec.ts`,
 * which asserts the backoff still recovers; what that spec cannot see is whether Sentry was told.
 *
 * A test on the whole file's `captureException` count would be the obvious thing and would be
 * wrong: `deadLetter` captures twice on its own failure paths, and `runBatch` captures on a queue
 * read error and on a message that escapes the dispatcher. Those four are unrelated to this issue
 * and should keep reporting. So each assertion below is scoped to one region of the file.
 */
import { readFileSync } from "fs";
import { join } from "path";

const WORKER = join(__dirname, "..", "..", "supabase", "functions", "exam-async-worker", "index.ts");

/** The body of `processMessage`, from its signature to the next top-level function. */
function dispatcherBody(source: string): string {
  const start = source.indexOf("async function processMessage(");
  const end = source.indexOf("async function runBatch(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The tail of the catch block: everything after the last give-up branch returns.
 *
 * Anchored on the `retryCount >= 5` guard rather than on a comment, so rewording a comment does not
 * silently stop this from checking anything. If that guard is ever restructured this throws rather
 * than passing vacuously.
 */
function transientRequeuePath(dispatcher: string): string {
  const guard = dispatcher.indexOf("if (retryCount >= 5)");
  expect(guard).toBeGreaterThan(-1);
  const afterGuard = dispatcher.indexOf("}", dispatcher.indexOf("return;", guard));
  expect(afterGuard).toBeGreaterThan(guard);
  return dispatcher.slice(afterGuard);
}

/**
 * Line comments removed, so an assertion about what the code does is not satisfied or broken by
 * prose about it. The comment on the path below says the words "no captureException", which is
 * exactly the string a naive check would trip on.
 */
function codeOnly(region: string): string {
  return region
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("issue #1293: only give-ups reach Sentry", () => {
  const dispatcher = dispatcherBody(readFileSync(WORKER, "utf8"));

  test("the transient requeue path does not capture", () => {
    // The assertion that fails without the fix.
    expect(codeOnly(transientRequeuePath(dispatcher))).not.toContain("Sentry.captureException");
  });

  test("the transient requeue path logs the retry instead", () => {
    // Without this the rate becomes invisible rather than merely quiet, which is a worse bug than
    // the one being fixed: nobody would know the provider was failing at all.
    expect(transientRequeuePath(dispatcher)).toMatch(/log\(\s*\n?\s*`retry \$\{retryCount \+ 1\}/);
  });

  test("the rate-limit requeue path logs too", () => {
    // It never captured, so it is not part of the regression. It is here because a run can be
    // noisy with rate limits or with transient errors and those mean different things, so the two
    // retry paths have to be distinguishable in the logs.
    expect(dispatcher).toContain("`rate-limit retry ");
  });

  test("every give-up path still captures", () => {
    // The point of the change is that these become findable, not that Sentry goes quiet. If a
    // future edit removes one of these the worker would abandon work in silence. The five: the
    // poison-pill guard, a match whose pages changed under it as the last match left (#1158), a
    // rejected scan, rate limits exhausted, and transient retries exhausted.
    const captures = dispatcher.match(/Sentry\.captureException/g) ?? [];
    expect(captures).toHaveLength(5);
  });

  test("captured events carry the attempt number", () => {
    // Replaces what the per-retry events used to show. Without it a give-up event cannot say
    // whether the budget ran out on the first failure or the sixth.
    expect(dispatcher).toContain('scope.setTag("attempt"');
  });
});
