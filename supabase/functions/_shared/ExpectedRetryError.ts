/**
 * "Retry me, but this is not a fault" — an error that exists to drive a redelivery, not to page anyone.
 *
 * Several handlers deliberately throw so that the caller retries: EventBridge redelivers a webhook
 * event on a non-2xx (GitHub's webhooks reach the edge functions through EventBridge rules, so the
 * retry policy is an AWS rule/target configuration defined outside this repository — how many
 * redeliveries there are and for how long cannot be read off this code), and the async worker
 * re-queues a job. Throwing is the mechanism that makes those paths converge — it is what turns "we
 * cannot record this yet" into "we will record this shortly" instead of "this delivery is lost".
 *
 * The problem is that a throw is also how a real fault is reported, and every generic
 * `catch (err) { Sentry.captureException(err, scope) }` treats both the same. So an expected,
 * self-healing retry arrives in Bugsink at `error` level, grouped next to genuine breakage. Measured
 * in Khoury production on 2026-09-07: releasing one assignment to 58 students produced 412
 * error-level events from a single throw site in github-repo-webhook, spread over the 88 minutes the
 * async `create_repo` queue took to drain the batch. Nothing was wrong — the final state was 58/58
 * repositories ready with no lost work — but a genuinely broken repository in that same window would
 * have been indistinguishable from the noise. A 585-student class (CS 2000, Fall 2026) scales that to
 * several thousand.
 *
 * Deleting the throw is the wrong repair, and is the reason this type exists rather than a comment:
 * the retry is load-bearing. What has to change is the SEVERITY of the report, so the expected case
 * is queryable (`info`, its own fingerprint) without being alertable, while a real failure on the
 * same line stays at `error`.
 *
 * Capture sites opt in by asking for the report and, when there is one, capturing on a scope with
 * that level and fingerprint. Handlers that never throw this see no behaviour change.
 *
 * Pure and dependency-free (no Sentry import) so it can be thrown from any edge function without
 * dragging in a `Sentry.init` side effect, and unit-tested without a Sentry client — the same reason
 * ErrorDetail.ts and SentryFingerprint.ts are structured this way.
 */

/** Sentry severities an expected retry is allowed to claim. Never `error` — that is the point. */
export type ExpectedRetryLevel = "info" | "warning";

/** What a capture site needs in order to report an expected retry without alerting on it. */
export interface ExpectedRetryReport {
  level: ExpectedRetryLevel;
  /**
   * Explicit grouping key. Set at the throw site rather than derived, so the expected case cannot
   * land in the same Bugsink issue as a genuine failure from the same function and frame — which is
   * exactly what the default (type + frame + normalized message) grouping would do for two throws
   * that differ only in their prose.
   */
  fingerprint: string[];
}

/**
 * An error thrown to trigger a retry, carrying the severity it should be reported at.
 *
 * `name` is settable because Bugsink displays the exception type: giving the expected case its own
 * type ("RepoProvisioningInFlightError" and friends) is what makes it recognizable in a list, and
 * what keeps `ignoreErrors`/severity rules in front of it from having to match on message text.
 */
export class ExpectedRetryError extends Error {
  /**
   * Structural marker, checked in preference to `instanceof`. Edge functions import shared modules
   * through several specifiers (relative path here, esm.sh elsewhere), and a module loaded twice
   * yields two distinct classes — under which `instanceof` silently fails and the event is reported
   * at `error` after all. A property survives that.
   */
  readonly isExpectedRetryError = true as const;
  readonly sentryLevel: ExpectedRetryLevel;
  readonly sentryFingerprint: string[];

  constructor(message: string, options: { fingerprint: string[]; level?: ExpectedRetryLevel; name?: string }) {
    super(message);
    this.name = options.name ?? "ExpectedRetryError";
    this.sentryLevel = options.level ?? "info";
    this.sentryFingerprint = options.fingerprint;
  }
}

/** True when `err` carries an expected-retry report of its own (not counting anything it wraps). */
function isExpectedRetryError(err: unknown): err is ExpectedRetryError {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { isExpectedRetryError?: unknown; sentryFingerprint?: unknown };
  return candidate.isExpectedRetryError === true && Array.isArray(candidate.sentryFingerprint);
}

/**
 * The report for `err`, or null if it must be reported as a normal error.
 *
 * Unwraps `AggregateError.errors`, because a caller may receive the original throw wrapped in a set:
 * `@octokit/webhooks`' `eventHandler.receive` collects what its listeners threw and rethrows it, so
 * the webhook entry point can see an aggregate where the per-event catch saw the error itself. Both
 * catches capture the same underlying failure, so unwrapping is what keeps their two events at the
 * same severity instead of downgrading one and alerting on the other.
 *
 * An aggregate is expected only if EVERY child is expected, and it then takes the highest level any
 * child asked for. One genuine failure batched alongside routine retries is a genuine failure — the
 * whole reason for this module is to stop the expected case from hiding the real one, so it must not
 * reintroduce that in the aggregate case.
 *
 * `cause` is deliberately NOT followed. An expected retry wrapped in a generic Error is a generic
 * Error: the wrapper's own message and frame are what a reader triages, and if that wrapper is worth
 * throwing it is worth reporting. Only the thing that was actually thrown gets to claim `info`.
 */
export function expectedRetryReport(err: unknown): ExpectedRetryReport | null {
  if (isExpectedRetryError(err)) {
    return { level: err.sentryLevel, fingerprint: err.sentryFingerprint };
  }
  const children = (err as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(children) || children.length === 0) return null;
  const reports: ExpectedRetryReport[] = [];
  for (const child of children) {
    const report = expectedRetryReport(child);
    if (!report) return null;
    reports.push(report);
  }
  return {
    level: reports.some((r) => r.level === "warning") ? "warning" : "info",
    fingerprint: reports[0].fingerprint
  };
}
