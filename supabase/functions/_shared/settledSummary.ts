// Summarize Promise.allSettled results so a bulk operation can report what actually happened.
//
// Extracted and tested because the failure mode it fixes is entirely about *reporting*: a bulk
// repo creation ran `await Promise.allSettled(...)` and then logged "All repos created + synced"
// and returned "All repositories created successfully" without ever inspecting the settled
// results. With ~200 repos created in one burst against a throttle deliberately configured not to
// retry, rejections are the expected shape of a bad day — and every one of them was discarded.
//
// Same lesson as queueHandoutSyncsForAssignments, which reads the RPC's in-payload error_count
// rather than trusting the absence of a transport error.

import { describeCause } from "./ErrorDetail.ts";

export type SettledSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Human-readable reasons, capped — see `truncatedReasons`. */
  reasons: string[];
  /** How many failures are NOT represented in `reasons`, so a caller never implies full coverage. */
  truncatedReasons: number;
};

const DEFAULT_MAX_REASONS = 10;

export function summarizeSettled(
  results: PromiseSettledResult<unknown>[],
  { label, maxReasons = DEFAULT_MAX_REASONS }: { label?: string; maxReasons?: number } = {}
): SettledSummary {
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  const shown = rejected.slice(0, maxReasons);
  return {
    attempted: results.length,
    succeeded: results.length - rejected.length,
    failed: rejected.length,
    // describeCause, not `String(reason)`: PostgREST and GoTrue reject with plain objects rather
    // than Errors, which stringify to "[object Object]".
    reasons: shown.map((r) => (label ? `${label}: ${describeCause(r.reason)}` : describeCause(r.reason))),
    truncatedReasons: rejected.length - shown.length
  };
}

/**
 * Fold several summaries into one, preserving the truncation count.
 *
 * Re-applies `maxReasons` to the concatenation. Without it, merging N already-capped summaries
 * yields N x maxReasons reasons while `truncatedReasons` still implies the cap was honoured — and
 * describeSettledSummary joins all of them into one string that assignment-create-all-repos puts in
 * a UserVisibleError, i.e. straight into a browser toast.
 */
export function mergeSettledSummaries(
  summaries: SettledSummary[],
  { maxReasons = DEFAULT_MAX_REASONS }: { maxReasons?: number } = {}
): SettledSummary {
  const merged = summaries.reduce<SettledSummary>(
    (acc, s) => ({
      attempted: acc.attempted + s.attempted,
      succeeded: acc.succeeded + s.succeeded,
      failed: acc.failed + s.failed,
      reasons: [...acc.reasons, ...s.reasons],
      truncatedReasons: acc.truncatedReasons + s.truncatedReasons
    }),
    { attempted: 0, succeeded: 0, failed: 0, reasons: [], truncatedReasons: 0 }
  );
  const shown = merged.reasons.slice(0, maxReasons);
  return {
    ...merged,
    reasons: shown,
    truncatedReasons: merged.truncatedReasons + (merged.reasons.length - shown.length)
  };
}

/** One-line description suitable for a log line, a Sentry message, or a UserVisibleError. */
export function describeSettledSummary(summary: SettledSummary): string {
  if (summary.failed === 0) {
    return `${summary.succeeded}/${summary.attempted} succeeded`;
  }
  const suffix = summary.truncatedReasons > 0 ? ` (+${summary.truncatedReasons} more)` : "";
  return `${summary.failed}/${summary.attempted} failed: ${summary.reasons.join("; ")}${suffix}`;
}
