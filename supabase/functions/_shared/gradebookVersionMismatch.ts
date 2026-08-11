// Which rows lost the optimistic-version race and therefore need recovering?
//
// Extracted because the bulk and scoped recalculation paths had drifted: the scoped path cleared
// `is_recalculating` and re-enqueued these rows, while the bulk path computed the same count purely
// to print it in a warning. Since `is_recalculating` gates new enqueues, a mismatch on the bulk
// path left that student's gradebook row permanently frozen — no recalculation, no retry, and no
// error anywhere. It fires exactly when contention is highest, which is a deadline.

export type GradebookRowBatchResult = {
  student_id: string;
  is_private: boolean;
  version_matched?: boolean;
  cleared?: boolean;
  error?: string | null;
};

/**
 * A row needs recovery when the version check did not match, nothing errored (an error is reported
 * and handled separately), and the state was not cleared — so it is still marked recalculating with
 * nothing scheduled to pick it up.
 */
export function selectVersionMismatchedRows<T extends GradebookRowBatchResult>(results: T[]): T[] {
  return results.filter((r) => !r.version_matched && !r.error && !r.cleared);
}
