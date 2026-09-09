/**
 * Wall-clock budget for the repo reconciler's repair pass.
 *
 * The reconciler runs in an isolate with a 400s lifetime (`edgeFunctions.worker.timeoutMs`), and a
 * single `create_repo` has been measured at p50 279.5s under contention even though it completes in
 * ~10s when GitHub is calm. So the pass has to be bounded by TIME, not by a count of repairs.
 *
 * Two mechanisms, and it matters which one does what:
 *
 *   - The ABORT is the hard guarantee. Every repair request is issued with an AbortSignal set to
 *     the budget actually remaining, so no call can outlive the budget however slow GitHub is.
 *   - The RESERVE is only an optimisation on top of it: do not begin a repair we could not give a
 *     reasonable chance of finishing, since an aborted attempt costs an attempt slot and a Sentry
 *     event for no benefit. It is sized above the ~10-12s a healthy creation takes, NOT above the
 *     p50-under-contention figure — sizing it for the worst case would throttle the common case to
 *     one or two repairs per tick for no gain, because the abort already bounds the bad case.
 *
 * These live here, apart from the reconciler's `Deno.serve` module, so the invariant between them is
 * testable. It has already been violated once: a reserve of 280_000 against a budget of 240_000 made
 * `canStartRepair` false at zero elapsed, so the pass broke before its first request and reported
 * zero repairs on every run — silently, because reporting zero repairs is also what a healthy run
 * with nothing to do looks like.
 */
export const REPAIR_TIME_BUDGET_MS = 240_000;
export const REPAIR_RESERVE_MS = 45_000;

/** Budget left, floored at 1ms so it is always a usable AbortSignal timeout. */
export function remainingBudgetMs(elapsedMs: number): number {
  return Math.max(REPAIR_TIME_BUDGET_MS - elapsedMs, 1);
}

/** May another repair be started after `elapsedMs` of the pass has gone? */
export function canStartRepair(elapsedMs: number): boolean {
  return REPAIR_TIME_BUDGET_MS - elapsedMs >= REPAIR_RESERVE_MS;
}
