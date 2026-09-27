// Which rows lost the optimistic-version race and therefore need recovering?
//
// Extracted because the bulk and scoped recalculation paths had drifted: the scoped path cleared
// `is_recalculating` and re-enqueued these rows, while the bulk path computed the same count purely
// to print it in a warning. A mismatch on the bulk path therefore left that student's gradebook row
// marked recalculating with nothing scheduled to pick it up — no recalculation, no retry, and no
// error anywhere. It fires exactly when contention is highest, which is a deadline.

export type GradebookRowBatchResult = {
  student_id: string;
  is_private: boolean;
  version_matched?: boolean;
  cleared?: boolean;
  error?: string | null;
  /** The version the worker passed to the RPC as `expected_version`. Diagnostic only. */
  expected_version?: number | null;
  /**
   * The row's live `gradebook_row_recalc_state.version` as of the end of the RPC call.
   *
   * This is the value a recovery clear must be scoped to. `expected_version` cannot be: on a
   * mismatch it is by definition not the row's version, so a predicate built from it never matches.
   * `null` means no state row exists, so there is no claim to release and no clear to issue.
   */
  current_version?: number | null;
};

/**
 * A row needs recovery when the version check did not match, nothing errored (an error is reported
 * and handled separately), and the state was not cleared — so it is still marked recalculating with
 * nothing scheduled to pick it up.
 */
export function selectVersionMismatchedRows<T extends GradebookRowBatchResult>(results: T[]): T[] {
  return results.filter((r) => !r.version_matched && !r.error && !r.cleared);
}

/** Maximum number of version-mismatch recovery re-enqueues for a single gradebook row. */
export const MAX_VERSION_MISMATCH_ATTEMPTS = 8;

const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;

/**
 * Delay, in seconds, before a version-mismatch retry becomes visible again.
 *
 * There was no backoff at all: `update_gradebook_rows_batch` archives every message id it is
 * handed, so each recovery re-enqueue is a brand-new pgmq message that is immediately visible with
 * `read_ct` reset to 0. At a deadline that turns the recovery path into a busy loop that re-reads
 * and re-writes the same contended rows as fast as the worker can poll, which is itself a source of
 * further version churn. Exponential with jitter, capped, matching `computeBackoffSeconds` in
 * github-async-worker.
 */
export function versionMismatchBackoffSeconds(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(6, Math.max(0, attempt - 1));
  const backoff = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * Math.pow(2, exp));
  const jitter = Math.floor(random() * Math.max(1, Math.floor(backoff / 4)));
  return backoff + jitter;
}

/** Key a row by the part of its identity that varies within one batch. */
export function versionMismatchRowKey(studentId: string, isPrivate: boolean): string {
  return `${studentId}:${isPrivate}`;
}

/**
 * Split mismatched rows into "retry once more, after a delay" and "give up, dead-letter it".
 *
 * `attemptFor` returns the number of recovery attempts the incoming message already recorded, so
 * the counter survives the fact that the RPC archives the old message and `send_batch` mints a new
 * one with `read_ct` back at 0.
 */
export function partitionVersionMismatchRetries<T extends GradebookRowBatchResult>(
  rows: T[],
  attemptFor: (row: T) => number,
  maxAttempts: number = MAX_VERSION_MISMATCH_ATTEMPTS
): { retries: Array<{ attempt: number; rows: T[] }>; dead: Array<{ row: T; attempt: number }> } {
  const byAttempt = new Map<number, T[]>();
  const dead: Array<{ row: T; attempt: number }> = [];

  for (const row of rows) {
    const attempt = attemptFor(row) + 1;
    if (attempt > maxAttempts) {
      dead.push({ row, attempt: attempt - 1 });
      continue;
    }
    // Grouped by attempt count because send_batch takes one sleep_seconds for the whole batch, and
    // rows in a chunk can be on different attempts. In practice this is one group.
    const arr = byAttempt.get(attempt) ?? [];
    arr.push(row);
    byAttempt.set(attempt, arr);
  }

  const retries = Array.from(byAttempt.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([attempt, rows]) => ({ attempt, rows }));

  return { retries, dead };
}
