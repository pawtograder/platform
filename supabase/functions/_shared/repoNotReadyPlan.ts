/**
 * How long `sync_repo_permissions` should wait when the repository row exists but GitHub has not
 * finished provisioning it, and when to stop waiting.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE HANDLER. The handler used to spell this wait as
 * `return false`, which leaves the message unarchived so the only thing that makes it visible again
 * is its visibility timeout expiring — `GITHUB_ASYNC_WORKER_VISIBILITY_TIMEOUT_SECONDS`, 480 in
 * Khoury production. A deliberate wait then has a floor AND a granularity of eight minutes no matter
 * how long the repo actually needed. Measured consequence, prod 2026-09-16: one message
 * (`neu-cs4535/fa26-hw1-onboarding-somshrivastava`) polled four times, spent 1968s end to end, and
 * its successful attempt did 1s of work. It fired PawtograderQueueOldestMessageAging at 19:50Z with
 * a QUEUE DEPTH OF ONE.
 *
 * That alert cannot be tuned around. Its threshold is 1200s and each poll costs 480s, so any repo
 * needing more than ~2.5 polls pages someone; and the drain-rate `unless` guard in
 * prometheus-rules.yaml cannot suppress it, because depth pinned at 1 makes deriv() ~0, never the
 * -2/min the guard looks for. The guard is there to silence healthy BULK drains and correctly
 * refuses to hide a single slow message.
 *
 * Pure and dependency-free — no Supabase client, no Sentry, no Deno globals — so the handler's
 * decision is unit-testable without any of them. Same split as asyncWorkerTuning.ts and
 * emptySubmissionVerdict.ts, and the reason this logic does not live inline in
 * github-async-worker/index.ts, which cannot be imported under jest at all.
 */

/**
 * Backoff base. Doubles to the 900s cap: 15, 30, 60, 120, 240, 480, then 900.
 *
 * The win is at the FAST end, which is where nearly all of this lives: 227 of the 230 redelivered
 * permission syncs on 2026-09-15 had read_ct 2, meaning they were ready well inside one visibility
 * timeout and paid the full 480s regardless. Those now come back in ~15s.
 */
export const REPO_NOT_READY_REQUEUE_BASE_SECONDS = 15;

/**
 * 9, NOT 10, and the difference is jitter. The ladder's nominal sum at 10 retries is 4545s, which
 * looked like a match for the old 4800s bound until the test computed it WITH the +25% jitter this
 * module adds: 5670s, 18% over. Sized at 9 it is 4546s worst case, inside the old bound. The comment
 * that got this wrong said "~76 minutes"; `repoNotReadyWorstCaseSeconds` exists so the number is
 * derived and asserted instead of asserted in prose.
 *
 * Bounds the requeue loop the way `PGMQ_MAX_READ_CT` bounds the redelivery loop — and it MUST be
 * stated separately, because requeueing SENDS A NEW MESSAGE. `read_ct` restarts at 1 on every
 * requeue, so the poison-pill limit that used to bound this path stops applying the moment the wait
 * becomes an explicit requeue. Without this ceiling a repo that never becomes ready loops forever at
 * 900s a turn with nothing to stop it. Getting this wrong converts a bounded leak into an unbounded
 * one, which is why it is a named constant with a test rather than a literal.
 */
export const REPO_NOT_READY_MAX_RETRIES = 9;

/** The cap `computeBackoffSeconds` enforces; mirrored here so the schedule is checkable in one place. */
export const REPO_NOT_READY_MAX_DELAY_SECONDS = 900;

export type RepoNotReadyPlan =
  | { action: "requeue"; delaySeconds: number; attempt: number; maxAttempts: number }
  | { action: "dlq"; retryCount: number };

export interface RepoNotReadyPlanOptions {
  /** Injectable for deterministic tests. Must return [0, 1). */
  random?: () => number;
  baseSeconds?: number;
  maxRetries?: number;
}

/**
 * Exponential backoff with jitter, matching `computeBackoffSeconds` in the worker so the two
 * schedules cannot drift apart. Jitter is up to a quarter of the delay and is added, never
 * subtracted, so `delaySeconds` is always >= the nominal backoff.
 */
export function repoNotReadyDelaySeconds(retryCount: number, opts: RepoNotReadyPlanOptions = {}): number {
  const base = Math.max(5, opts.baseSeconds ?? REPO_NOT_READY_REQUEUE_BASE_SECONDS);
  const exp = Math.min(6, Math.max(0, retryCount));
  const backoff = Math.min(REPO_NOT_READY_MAX_DELAY_SECONDS, base * Math.pow(2, exp));
  const random = opts.random ?? Math.random;
  const jitter = Math.floor(random() * Math.floor(backoff / 4));
  return backoff + jitter;
}

/** Wait again, or give up and DLQ. */
export function planRepoNotReadyWait(retryCount: number, opts: RepoNotReadyPlanOptions = {}): RepoNotReadyPlan {
  const maxRetries = opts.maxRetries ?? REPO_NOT_READY_MAX_RETRIES;
  const count = Number.isFinite(retryCount) && retryCount > 0 ? Math.floor(retryCount) : 0;
  if (count >= maxRetries) return { action: "dlq", retryCount: count };
  return {
    action: "requeue",
    delaySeconds: repoNotReadyDelaySeconds(count, opts),
    attempt: count + 1,
    maxAttempts: maxRetries
  };
}

/**
 * Worst-case wall clock the ladder can consume before it DLQs, jitter included.
 *
 * Exists so the outer bound is ASSERTABLE rather than asserted in a comment. The old path allowed
 * `PGMQ_MAX_READ_CT` (10) x one visibility timeout (480s) = 4800s; this must stay in that
 * neighbourhood, because the point of the change is the SHAPE of the wait, not a longer one.
 */
export function repoNotReadyWorstCaseSeconds(opts: RepoNotReadyPlanOptions = {}): number {
  const maxRetries = opts.maxRetries ?? REPO_NOT_READY_MAX_RETRIES;
  let total = 0;
  for (let i = 0; i < maxRetries; i++) total += repoNotReadyDelaySeconds(i, { ...opts, random: () => 0.9999 });
  return total;
}
