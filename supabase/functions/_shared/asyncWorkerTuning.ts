/**
 * Drain tuning for the pgmq-backed async workers (github-async-worker today).
 *
 * WHY THIS FILE EXISTS — the 2026-09-07 CS 4530 provisioning incident.
 *
 * CS 4530 released an assignment and enqueued 58 `create_repo` messages onto
 * `async_calls` in one shot at 04:01:00 UTC. The last one drained at 05:37:28
 * UTC: 88 MINUTES for 58 messages. Average time-in-queue was 3,230s (54 min),
 * worst 5,788s (96 min). The observed pattern was 2-4 messages completing
 * roughly every 7 minutes, which tripped `PawtograderQueueOldestMessageAging`
 * (1200s for 10m, critical) for over an hour. That alert was a TRUE POSITIVE.
 * The end state was correct — 58/58 repos provisioned, no duplicates, empty
 * DLQ — so this was purely a throughput and redelivery problem.
 *
 * Two numbers in processBatch() were hardcoded and are the whole story:
 *
 *  1. `n: 4` on the pgmq `read` call is the CONCURRENCY CEILING, not a batch
 *     size hint. `beginWorkerRun` (see workerRun.ts) grants ONE leaseholder per
 *     deployment, and that leaseholder processes the batch with
 *     `Promise.allSettled`, i.e. n messages at a time. 4 in parallel per ~7 min
 *     iteration is ~0.6 msg/min, which is exactly what was measured. Nothing
 *     about the lease, the number of pokes per minute, or the pod count changes
 *     that: `n` is the knob.
 *
 *  2. `sleep_seconds: 300` is the pgmq VISIBILITY TIMEOUT, and at a ~7 min
 *     (420s) iteration it is SHORTER THAN THE WORK. Messages became visible
 *     again while still being actively processed: 20 of the 58 messages had
 *     `read_ct` > 1 (max 3). The comment that used to sit above that call
 *     asserted 300s was "well above observed p99 handler durations" — that
 *     assertion is falsified for `create_repo` under burst, and re-reading a
 *     message that is still in flight is wasted GitHub quota at exactly the
 *     moment the queue is deepest. It also walks `read_ct` toward
 *     PGMQ_MAX_READ_CT (10), which DLQs a message as poison — at 3 reads there
 *     was margin, but a burst several times longer would not have any, and the
 *     work that would get dead-lettered is LEGITIMATE provisioning.
 *
 * THE INVARIANT, which is the part that must survive future edits:
 *
 *   The visibility timeout must exceed the worst-case time to process a WHOLE
 *   BATCH OF `n`, not the worst case for a single message.
 *
 * A batch is not "n independent messages in parallel" in wall-clock terms. The
 * GitHub calls inside the handlers funnel through the shared `Bottleneck`
 * limiters in _shared/ (one App installation quota per org), so raising `n`
 * lengthens the batch roughly linearly rather than leaving it flat. The
 * measurement is the calibration: 420s of wall clock for a batch of 4 is
 * ~105s of serialized work per message, and PER_MESSAGE_VT_BUDGET_SECONDS
 * rounds that to 120s for headroom. Hence
 * `requiredVisibilityTimeoutSeconds(n) = n * 120`.
 *
 * Raising `n` without raising the VT therefore RE-CREATES the incident, worse:
 * a longer batch against the same 300s VT means more messages redelivered
 * mid-flight, not fewer. That is why this module reports the violation instead
 * of leaving the two values as unrelated constants, and why the chart REFUSES
 * to render a raised concurrency with an unraised timeout
 * (templates/validations.yaml).
 *
 * DEFAULTS ARE TODAY'S HARDCODED VALUES ON PURPOSE (n=4, VT=300). Deploying
 * this change alters nothing until someone sets the env vars, so the throughput
 * decision stays an explicit, reviewable operator action rather than a side
 * effect of a chart upgrade. The default pair (4, 300) DOES violate the
 * invariant above — that is the measured status quo, deliberately preserved,
 * and it is reported as a warning rather than clamped.
 */

/** Env var read for the pgmq `read` fan-out (chart: edgeFunctions.githubAsyncWorker.drainConcurrency). */
export const DRAIN_CONCURRENCY_ENV = "GITHUB_ASYNC_WORKER_DRAIN_CONCURRENCY";
/** Env var read for the pgmq visibility timeout (chart: edgeFunctions.githubAsyncWorker.visibilityTimeoutSeconds). */
export const VISIBILITY_TIMEOUT_ENV = "GITHUB_ASYNC_WORKER_VISIBILITY_TIMEOUT_SECONDS";

/** Today's hardcoded `n`. Keeping this as the default is what makes the change inert until configured. */
export const DEFAULT_DRAIN_CONCURRENCY = 4;
/**
 * 1, not 0. `n: 0` reads nothing at all, so the queue drains at zero messages
 * per minute while every liveness signal (lease held, heartbeats, no errors)
 * stays green — indistinguishable from a hung queue, and the deepest failure
 * mode this whole file exists to avoid.
 */
export const MIN_DRAIN_CONCURRENCY = 1;
/**
 * 8, matching `edgeFunctions.maxParallelism`. The ceiling is not an arbitrary
 * round number; three constraints bound it, and the FIRST one is the binding
 * one:
 *
 *  * THE SHARED CONTENT LIMITER, which is the real ceiling. `create_repo`
 *    wraps the ENTIRE `github.createRepo(...)` call in a single
 *    `getCreateContentLimiter(org).schedule(...)` (github-async-worker/index.ts
 *    ~line 992), and that limiter is REDIS-BACKED, i.e. FLEET-WIDE per org, keyed
 *    `create_content:<org>:<GITHUB_APP_ID>` with
 *    `{ reservoir: 40, maxConcurrent: 40, refresh 40/60s }`
 *    (_shared/GitHubWrapper.ts ~line 254). A `create_repo` measured p50 279.5s
 *    on prod 2026-09-07 across all 58 messages, so EACH IN-FLIGHT REPO CREATION
 *    HOLDS ONE OF THE 40 CONCURRENCY SLOTS AND ONE RESERVOIR TOKEN FOR ~4.7
 *    MINUTES.
 *
 *    That pool is shared, not dedicated: `reinviteToOrgTeam`'s
 *    `POST /orgs/{org}/invitations` draws from it (GitHubWrapper.ts ~line 2508),
 *    and `sync_repo_to_handout` holds a slot for the whole sync
 *    (GitHubSyncHelpers.ts ~line 1550). So as `n` rises toward 40, minutes-long
 *    repo creations occupy the pool and ORG INVITATIONS QUEUE BEHIND THEM — a
 *    convoy that shows up as students unable to join the org, i.e. a different
 *    and worse symptom than a slow queue. `n` is per leaseholder but the limiter
 *    is per org and fleet-wide, so several classes releasing into the SAME org
 *    at once compound it. And the reservoir means only 40 creations can START
 *    per minute per org no matter what `n` is, so a large `n` buys nothing.
 *
 *    8 is 20% of the pool: even with every slot held for the full ~280s there
 *    are 32 left for invitations and syncs, and it stays far from the regime
 *    where outer jobs can monopolise the pool.
 *
 *    WARNING FOR FUTURE EDITORS — a latent deadlock, not a live one. Nothing
 *    inside `createRepo` re-enters this limiter today (verified:
 *    GitHubWrapper.ts ~1564-1720 schedules nothing), so there is no nesting on
 *    the SAME limiter and no deadlock. But "wrap a long multi-step operation in
 *    the content limiter" is one refactor away from the classic Bottleneck
 *    deadlock: move any permission/invitation call INSIDE that wrapper while
 *    >= maxConcurrent outer jobs are running, and every slot is held by an outer
 *    job waiting on an inner job that can never start. Do not move
 *    limiter-scheduled calls inside the `createRepo` wrapper. If you ever do,
 *    this ceiling has to come DOWN, not up.
 *
 *    Note also what the limiter does NOT explain: at n=4 there are only 4
 *    concurrent jobs against 40 slots and 40 tokens/minute, so nothing queued
 *    during the incident. The ~280s per repo is real work in an uninstrumented
 *    stretch of `createRepo`, and it is not this file's problem.
 *
 *  * MEMORY. All `n` handlers run inside ONE isolate — the leaseholder's — and
 *    that isolate is capped at `edgeFunctions.worker.memoryLimitMb` (256MiB)
 *    with graceful early-drop at half that (`lowMemoryMultiplier: 2`, ~128MiB).
 *    So `n` multiplies concurrent envelopes, Octokit responses and file
 *    contents inside a 256MiB box, and an isolate killed at the memory cap
 *    mid-handler is precisely the "read_ct climbs without bound" failure
 *    PGMQ_MAX_READ_CT was added for. This tier has a real OOM history
 *    (2026-08-11 and 2026-08-19 both OOM-killed PID 1; see the eszip-cache and
 *    maxParallelism notes in values.yaml and examples/values-prod.yaml) and
 *    its container budget is already ~2650Mi against a 4Gi limit, so there is
 *    no slack to grow the isolate to compensate.
 *
 *  * GITHUB QUOTA. Raising `n` multiplies concurrent GitHub API calls against
 *    ONE shared App installation quota per org. Beyond the content limiter
 *    above, the only backstops are the other `Bottleneck` limiters in _shared/
 *    and the `github_circuit_breakers` table, so past their concurrency the
 *    extra parallelism converts into queueing (or secondary-rate-limit errors),
 *    not throughput. 8 is a doubling of the measured configuration, which is the
 *    largest step worth taking without re-measuring isolate memory,
 *    content-pool occupancy and secondary-limit behaviour under a real burst.
 *
 * Note what 8 does NOT do: at ~1.2 msg/min it is ~8 hours for a 585-message
 * burst. Getting materially past that needs more than one concurrent
 * leaseholder, which is a separate design change and deliberately out of scope
 * here.
 */
export const MAX_DRAIN_CONCURRENCY = 8;

/** Today's hardcoded `sleep_seconds`. Preserved as the default; see the header. */
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
/**
 * 60s floor. Anything shorter guarantees the incident's redelivery storm even
 * for a single fast message — `create_repo` alone measured ~105s of serialized
 * GitHub work — and a VT below the work is strictly worse than no change at
 * all, because every redelivery spends quota re-doing work in flight.
 */
export const MIN_VISIBILITY_TIMEOUT_SECONDS = 60;
/**
 * 1800s (30 min) ceiling. The VT is also the RECOVERY LATENCY for a message
 * whose isolate really did die (memory cap, `worker.timeoutMs` 400s wall clock,
 * pod eviction): nothing can retry it until the VT expires. 1800s is 1.5x the
 * `PawtograderQueueOldestMessageAging` window (1200s), so a genuinely stuck
 * message is guaranteed to page a human rather than sit invisible for hours,
 * and it still leaves room for the whole legal `n` range
 * (8 x 120s = 960s < 1800s).
 */
export const MAX_VISIBILITY_TIMEOUT_SECONDS = 1800;

/**
 * Per-message share of a batch's wall clock, used to express the VT-vs-n
 * invariant. Calibrated from the incident: 420s for a batch of 4 is ~105s per
 * message, rounded up to 120s for headroom. It is per-message and not "the
 * duration of one handler" because the batch runs concurrently but its GitHub
 * calls serialize through the shared Bottleneck limiters, so batch wall clock
 * scales with `n`.
 */
export const PER_MESSAGE_VT_BUDGET_SECONDS = 120;

/** The invariant, as a function: VT must exceed the worst case for a whole batch of `n`. */
export function requiredVisibilityTimeoutSeconds(drainConcurrency: number): number {
  return drainConcurrency * PER_MESSAGE_VT_BUDGET_SECONDS;
}

/** Minimal shape of `Deno.env` this module needs, so it is testable off-Deno. */
export type EnvReader = { get(name: string): string | undefined };

export type TuningIssue = {
  /** Env var the issue is about. */
  env: string;
  /** Raw configured value, as read (undefined when the issue is not about a rejected value). */
  raw?: string;
  /** Value actually in force after clamping / falling back. */
  effective: number;
  /** Human-readable explanation, safe to log and to attach to a Sentry tag. */
  message: string;
  kind: "rejected" | "clamped" | "invariant";
};

export type AsyncWorkerTuning = {
  /** pgmq `read` fan-out; also the worker's concurrency ceiling. */
  drainConcurrency: number;
  /** pgmq `read` `sleep_seconds` (visibility timeout). */
  visibilityTimeoutSeconds: number;
  /** Non-fatal problems worth surfacing exactly once per isolate. */
  issues: TuningIssue[];
};

type Bounds = { env: string; min: number; max: number; fallback: number };

/**
 * Parse one bounded integer knob.
 *
 * Three separate behaviours, each chosen because the alternative is an outage:
 *  * unset / empty  -> default, silently. This is the normal case.
 *  * unparseable    -> default, REPORTED. A typo (`"four"`, `"4 "`, `"1e3"`,
 *                      `""` after a bad chart render) must not become 0 or NaN;
 *                      `n: 0` drains nothing and `sleep_seconds: NaN` is
 *                      rejected by pgmq, taking the worker down for a
 *                      misconfiguration it could have ridden out.
 *  * out of range   -> CLAMPED to the bound, REPORTED. Clamping rather than
 *                      falling back keeps the operator's INTENT (they asked for
 *                      "more"), while the bound keeps the pod alive.
 */
function readBounded(env: EnvReader, b: Bounds): { value: number; issue?: TuningIssue } {
  const raw = env.get(b.env);
  if (raw === undefined || raw.trim() === "") return { value: b.fallback };

  // Number.parseInt would happily accept "4kB" and "1.9"; require a clean
  // non-negative integer so a unit suffix or a float is reported, not truncated.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return {
      value: b.fallback,
      issue: {
        env: b.env,
        raw,
        effective: b.fallback,
        kind: "rejected",
        message: `${b.env}=${JSON.stringify(raw)} is not a non-negative integer; falling back to ${b.fallback}`
      }
    };
  }
  if (parsed < b.min) {
    return {
      value: b.min,
      issue: {
        env: b.env,
        raw,
        effective: b.min,
        kind: "clamped",
        message: `${b.env}=${trimmed} is below the minimum ${b.min}; clamped to ${b.min}`
      }
    };
  }
  if (parsed > b.max) {
    return {
      value: b.max,
      issue: {
        env: b.env,
        raw,
        effective: b.max,
        kind: "clamped",
        message: `${b.env}=${trimmed} is above the maximum ${b.max}; clamped to ${b.max}`
      }
    };
  }
  return { value: parsed };
}

/**
 * Resolve both knobs from the environment, clamped, plus any issues to report.
 *
 * Pure and env-injected so the clamping rules are unit-testable under Jest
 * (tests/unit/async-worker-tuning.test.ts) — this module deliberately does not
 * touch the `Deno` global.
 */
export function resolveAsyncWorkerTuning(env: EnvReader): AsyncWorkerTuning {
  const issues: TuningIssue[] = [];

  const n = readBounded(env, {
    env: DRAIN_CONCURRENCY_ENV,
    min: MIN_DRAIN_CONCURRENCY,
    max: MAX_DRAIN_CONCURRENCY,
    fallback: DEFAULT_DRAIN_CONCURRENCY
  });
  if (n.issue) issues.push(n.issue);

  const vt = readBounded(env, {
    env: VISIBILITY_TIMEOUT_ENV,
    min: MIN_VISIBILITY_TIMEOUT_SECONDS,
    max: MAX_VISIBILITY_TIMEOUT_SECONDS,
    fallback: DEFAULT_VISIBILITY_TIMEOUT_SECONDS
  });
  if (vt.issue) issues.push(vt.issue);

  // The invariant check. Reported, never enforced by mutating the values: the
  // default pair (4, 300) violates it, and silently raising the VT on a
  // default deploy would break the "defaults reproduce today's behaviour
  // exactly" contract that makes this change safe to ship. The chart refuses
  // the combination at render time for any RAISED concurrency, which is where
  // a hard failure belongs.
  const required = requiredVisibilityTimeoutSeconds(n.value);
  if (vt.value < required) {
    issues.push({
      env: VISIBILITY_TIMEOUT_ENV,
      effective: vt.value,
      kind: "invariant",
      message:
        `visibility timeout ${vt.value}s is below the ${required}s a batch of ${n.value} can take ` +
        `(${n.value} x ${PER_MESSAGE_VT_BUDGET_SECONDS}s/message, calibrated from the 2026-09-07 burst: ` +
        `~7min for a batch of 4). Messages will be re-read while still in flight — that is the ` +
        `read_ct>1 on 20 of 58 messages from that incident. Raise ${VISIBILITY_TIMEOUT_ENV} to >= ${required}.`
    });
  }

  return { drainConcurrency: n.value, visibilityTimeoutSeconds: vt.value, issues };
}
