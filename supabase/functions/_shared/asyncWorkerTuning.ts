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
 * THE INVARIANT, which is the part that must survive future edits. There are
 * TWO ceilings over the same quantity, and a batch has to fit under BOTH:
 *
 *   visibility timeout    >= worst-case time to process a whole batch of `n`
 *   isolate lifetime      >= worst-case time to process a whole batch of `n`
 *
 * i.e. neither is about a single message. The second ceiling is
 * `EDGE_WORKER_TIMEOUT_MS` (chart: `edgeFunctions.worker.timeoutMs`, 400s),
 * which the demuxer hands to EdgeRuntime as `workerTimeoutMs`. The whole batch
 * runs inside ONE leaseholder isolate, so if the batch outlives that lifetime
 * the isolate dies before `Promise.allSettled` reaches the archive calls: the
 * repos got created and the messages never got archived, so pgmq redelivers and
 * the work is redone. Note also that `beforeUnload.wallClockRatio: 50` asks the
 * isolate to retire at HALF the lifetime (~200s at 400s) — workerRun.ts's
 * bounded-mode budget comment cites that same ~200s — so 400s is the hard cap,
 * not the budget.
 *
 * WHAT THE SECOND CEILING IS AND IS NOT. It is a CONFIG-COHERENCE rule: a
 * visibility timeout the isolate cannot outlive is incoherent advice, whatever
 * the runtime happens to be doing. `n * 120` and a 400s lifetime give an honest
 * maximum coherent `n` of THREE (3 x 120 = 360 <= 400; 4 x 120 = 480 > 400), so
 * even the shipped default of 4 sits just outside the conservative model — which
 * is exactly why the chart grandfathers the EXACT legacy pair (4, 300) and
 * checks everything else. Raising the visibility timeout without raising
 * `edgeFunctions.worker.timeoutMs` produces a combination that cannot hold, and
 * the chart refuses it.
 *
 * IT IS NOT A CLAIM THAT ISOLATES ARE BEING KILLED MID-BATCH TODAY. An earlier
 * version of this comment said that, and it was MEASURED AND RETRACTED
 * (2026-09-07). The runtime logs `wall clock duraiton reached: isolate: <id>`
 * (the typo is the runtime's), and hourly counts across the functions pods were
 * FLAT at ~200/hour before, during and after the 58-repo burst (197 at 03:00,
 * 242 at 04:00, 225 at 05:00, 192 idle at 12:00). That is baseline churn:
 * leased mode deliberately keeps a resident isolate polling, so it reaches the
 * 400s wall clock and recycles roughly every 3.5 minutes per pod. Nothing in
 * that signal ties a termination to an unarchived message, so mid-batch
 * truncation is UNPROVEN and the ~20% bump during the burst is not its
 * signature. The 300s visibility timeout remains the established cause of the
 * 20-of-58 re-reads.
 *
 * Note also that the linear `n * 120` model is a deliberately CONSERVATIVE
 * upper bound. The measured ~420s cadence is a completion cadence, not a proven
 * handler duration — it includes idle-poll and re-poke latency — and a
 * perfectly parallel batch of 4 create_repos at p50 279.5s would be ~280-300s,
 * which fits inside 400s. The conservative model is kept because the fleet-wide
 * content limiter makes the batch partially serial (below) and because erring
 * toward a longer timeout costs nothing but recovery latency.
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
 * mid-flight, not fewer. Two mechanisms stop that, at different layers:
 * templates/validations.yaml REFUSES to render an incoherent combination, and
 * `resolveAsyncWorkerTuning` ENFORCES coherence at runtime by degrading `n`
 * until it fits under both ceilings (never by inflating a timeout, and never to
 * 0). The runtime half exists because the chart cannot see the Helm-bypass
 * paths — a hand-edited Deployment, `kubectl set env`, a local `supabase
 * functions serve` — and an earlier version of this module only LOGGED the
 * violation there before handing the broken numbers to processBatch anyway,
 * which defended nothing.
 *
 * DEFAULTS ARE TODAY'S HARDCODED VALUES ON PURPOSE (n=4, VT=300). Deploying
 * this change alters nothing until someone sets the env vars, so the throughput
 * decision stays an explicit, reviewable operator action rather than a side
 * effect of a chart upgrade. That exact pair DOES violate both ceilings under
 * the model, and it is the ONE combination that is reported without being
 * enforced — re-coherencing the status quo would change production behaviour on
 * deploy, which is precisely what this change promises not to do.
 */

/**
 * THE CHART VALUES ARE THE ONLY SUPPORTED INPUT for both knobs below.
 * `_edge-functions-workload.tpl` renders them as explicit `env` entries with a
 * literal `value:`, and in Kubernetes an `env` entry WINS over anything supplied
 * by `envFrom` — so setting them through `edgeFunctions.envFromSecrets` is
 * silently ignored and the pod keeps the chart-rendered numbers. An earlier
 * version of this file claimed that secret path worked and used it to justify
 * the runtime validation; the claim was wrong and is withdrawn. The validation
 * stands on its own merits (defence in depth against a hand-edited Deployment,
 * `kubectl set env`, or a local `supabase functions serve`), and it is also the
 * only thing standing between a malformed value and pgmq.
 */

/** Env var read for the pgmq `read` fan-out (chart: edgeFunctions.githubAsyncWorker.drainConcurrency). */
export const DRAIN_CONCURRENCY_ENV = "GITHUB_ASYNC_WORKER_DRAIN_CONCURRENCY";
/** Env var read for the pgmq visibility timeout (chart: edgeFunctions.githubAsyncWorker.visibilityTimeoutSeconds). */
export const VISIBILITY_TIMEOUT_ENV = "GITHUB_ASYNC_WORKER_VISIBILITY_TIMEOUT_SECONDS";
/**
 * The isolate lifetime, read only to CHECK the second ceiling — this module
 * never sets it. Rendered by the same chart template that renders the two knobs
 * above (chart: edgeFunctions.worker.timeoutMs), so it is normally present in
 * the same container env; when it is absent or malformed the ceiling falls back
 * to DEFAULT_ISOLATE_LIFETIME_SECONDS, matching the demuxer, rather than being
 * skipped.
 */
export const ISOLATE_LIFETIME_ENV = "EDGE_WORKER_TIMEOUT_MS";
/**
 * What to assume when `EDGE_WORKER_TIMEOUT_MS` is absent or malformed: 400s,
 * because that is what the demuxer that creates the isolate assumes for exactly
 * the same input — `charts/pawtograder/images/edge-functions/main.ts:61`,
 * `Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 400 * 1000`. Treating it as
 * "unknown" and skipping the ceiling would let this module bless a batch longer
 * than the isolate it will actually run in. Keep this in step with main.ts.
 */
export const DEFAULT_ISOLATE_LIFETIME_SECONDS = 400;

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

  // Read the isolate lifetime (the second ceiling). Never written, only read:
  // this module cannot change how long EdgeRuntime keeps the isolate.
  //
  // AN ABSENT OR MALFORMED VALUE IS NOT "UNKNOWN", IT IS 400s. The demuxer that
  // actually creates the isolate is not undecided about it:
  //
  //   charts/pawtograder/images/edge-functions/main.ts:61
  //   const WORKER_TIMEOUT_MS = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 400 * 1000;
  //
  // An earlier version of this function treated absent/garbage as "ceiling
  // unknown, skip the check", which green-lit a 960s batch inside an isolate
  // that really lives 400s — the resolver declining to decide something the
  // runtime had already decided. Mirroring the fallback keeps the two tied; if
  // main.ts's default ever moves, DEFAULT_ISOLATE_LIFETIME_SECONDS moves with it.
  const lifetimeRaw = env.get(ISOLATE_LIFETIME_ENV);
  const lifetimeTrimmed = lifetimeRaw?.trim() ?? "";
  let lifetimeSeconds = DEFAULT_ISOLATE_LIFETIME_SECONDS;
  if (lifetimeTrimmed !== "") {
    // `Number(...) || default` is what main.ts does, so 0, a negative and any
    // non-numeric string all land on the same 400s there. Reported separately
    // from the clamp so an operator can tell "you typed garbage" from "your
    // pair was reduced".
    const parsedMs = Number(lifetimeTrimmed);
    if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
      issues.push({
        env: ISOLATE_LIFETIME_ENV,
        raw: lifetimeRaw,
        effective: DEFAULT_ISOLATE_LIFETIME_SECONDS,
        kind: "rejected",
        message:
          `${ISOLATE_LIFETIME_ENV}=${JSON.stringify(lifetimeRaw)} is not a positive number of ` +
          `milliseconds; assuming ${DEFAULT_ISOLATE_LIFETIME_SECONDS}s, which is what main.ts falls ` +
          `back to for the same input, so the ceiling used here matches the isolate you actually get.`
      });
    } else {
      lifetimeSeconds = Math.floor(parsedMs / 1000);
    }
  }

  // THE EXACT LEGACY PAIR IS REPORTED, NOT ENFORCED. (4, 300) is what was
  // hardcoded in processBatch() before any of this was configurable, so it is
  // what every deployment is already running; "re-coherencing" it here would
  // change production behaviour on deploy, which is the one thing this change
  // promises not to do. It genuinely violates both ceilings under the n x 120
  // model, so it is reported loudly and left alone. Everything else is a
  // deliberate act by whoever set the env var, and gets ENFORCED below.
  const requiredForConfigured = requiredVisibilityTimeoutSeconds(n.value);
  const isLegacyPair = n.value === DEFAULT_DRAIN_CONCURRENCY && vt.value === DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
  if (isLegacyPair) {
    if (vt.value < requiredForConfigured) {
      issues.push({
        env: VISIBILITY_TIMEOUT_ENV,
        effective: vt.value,
        kind: "invariant",
        message:
          `visibility timeout ${vt.value}s is below the ${requiredForConfigured}s a batch of ${n.value} can ` +
          `take (${n.value} x ${PER_MESSAGE_VT_BUDGET_SECONDS}s/message, calibrated from the 2026-09-07 ` +
          `burst: ~7min for a batch of 4). Messages can be re-read while still in flight — that is the ` +
          `read_ct>1 on 20 of 58 messages from that incident. This is the LEGACY PAIR (4/300), left as-is ` +
          `on purpose; raise ${VISIBILITY_TIMEOUT_ENV} to >= ${requiredForConfigured} to fix it.`
      });
    }
    if (lifetimeSeconds < requiredForConfigured) {
      issues.push({
        env: ISOLATE_LIFETIME_ENV,
        raw: lifetimeRaw,
        effective: lifetimeSeconds,
        kind: "invariant",
        message:
          `isolate lifetime ${lifetimeSeconds}s (${ISOLATE_LIFETIME_ENV}) is below the ` +
          `${requiredForConfigured}s a batch of ${n.value} can take. The whole batch runs in ONE isolate, ` +
          `so an overrun would be killed before the archive calls and every in-flight message would be ` +
          `re-provisioned on redelivery. Legacy pair (4/300), left as-is; raise ` +
          `edgeFunctions.worker.timeoutMs to >= ${requiredForConfigured * 1000} (keeping ` +
          `gracefulExitTimeoutSeconds / terminationGracePeriodSeconds above it) to fix it.`
      });
    }
    return { drainConcurrency: n.value, visibilityTimeoutSeconds: vt.value, issues };
  }

  // ENFORCEMENT, and the direction of it is the whole point.
  //
  // This function used to only REPORT a broken pair and then hand the broken
  // numbers to processBatch anyway, which made it useless exactly where it was
  // the only check standing: on the Helm-bypass paths (hand-edited Deployment,
  // `kubectl set env`) that the chart's render-time refusals cannot see. Setting
  // GITHUB_ASYNC_WORKER_DRAIN_CONCURRENCY=8 and nothing else produced 8/300 — a
  // batch modelled at 960s going visible at 300s, i.e. duplicated in-flight
  // GitHub work and legitimate provisioning messages walking toward the
  // poison-pill DLQ. A check that observes a fault it could have prevented is
  // not defence in depth.
  //
  // We DEGRADE CONCURRENCY rather than inflate the timeout:
  //
  //   n = max(1, min(n_configured, floor(VT / 120), floor(lifetime / 120)))
  //
  //  * it satisfies BOTH ceilings simultaneously, by construction. Raising the
  //    VT to fit `n` instead would satisfy the batch invariant while possibly
  //    breaking the isolate-lifetime ceiling — trading one incoherence for
  //    another, and the isolate ceiling is the one that loses the archive calls.
  //  * it fails toward LESS THROUGHPUT, which is a slower queue. The other
  //    direction fails toward duplicated GitHub work and re-provisioned repos.
  //    A slow queue is visible and recoverable; re-provisioning is neither.
  //  * it never returns 0. `n: 0` would drain nothing while the lease is held
  //    and every heartbeat stays green — indistinguishable from a hung queue,
  //    and the worst outcome available here. When the ceilings cannot be
  //    satisfied at all (a VT below one message's 120s budget) we land on 1 and
  //    say so, because draining slowly and incoherently still beats not
  //    draining.
  //
  // We do NOT refuse to process the batch. Halting on a misconfiguration is
  // worse than draining slowly on this path specifically: there is no render
  // error for anyone to read, so a refusal would be a silent stop.
  const caps: { limit: number; because: string }[] = [
    { limit: Math.floor(vt.value / PER_MESSAGE_VT_BUDGET_SECONDS), because: `${VISIBILITY_TIMEOUT_ENV}=${vt.value}s` },
    {
      limit: Math.floor(lifetimeSeconds / PER_MESSAGE_VT_BUDGET_SECONDS),
      because: `${ISOLATE_LIFETIME_ENV}=${lifetimeSeconds}s`
    }
  ];
  const binding = caps.reduce((lowest, c) => (c.limit < lowest.limit ? c : lowest));
  const coherentN = Math.max(MIN_DRAIN_CONCURRENCY, Math.min(n.value, binding.limit));

  if (coherentN !== n.value) {
    issues.push({
      env: DRAIN_CONCURRENCY_ENV,
      effective: coherentN,
      kind: "clamped",
      message:
        `drain concurrency reduced from ${n.value} to ${coherentN}: ${binding.because} only covers ` +
        `${binding.limit} concurrent message(s) at ${PER_MESSAGE_VT_BUDGET_SECONDS}s each. Concurrency is ` +
        `degraded rather than the timeout inflated, so both the visibility timeout and the isolate ` +
        `lifetime stay above the modelled batch — the queue drains slower instead of re-serving work ` +
        `that is still in flight. To actually get ${n.value}-way concurrency, raise ` +
        `${VISIBILITY_TIMEOUT_ENV} and edgeFunctions.worker.timeoutMs to >= ${requiredForConfigured}s ` +
        `(and the graceful-exit / termination-grace values with them).`
    });
  }

  // THE FLOOR MUST STILL BE COHERENT. Flooring `n` at 1 is right — n=0 drains
  // nothing while every liveness signal stays green — but on its own it left the
  // other half of the pair broken: with VT=60 the floor returned n=1 against a
  // 60s timeout while ONE message is budgeted at 120s, so processBatch ran a
  // knowingly incoherent pair and a multi-minute create_repo was re-read
  // repeatedly. The floor has to bring the timeout up with it.
  //
  // Raising the VT here is legitimate in a way that raising it to chase `n`
  // never was: the worker passes `sleep_seconds` on every pgmq_public.read, so
  // it OWNS that value and needs no chart change to honour it, and this is the
  // one case where there is no concurrency left to give up. It is only reachable
  // when the configured VT cannot cover a single message.
  let effectiveVt = vt.value;
  const requiredForEffective = requiredVisibilityTimeoutSeconds(coherentN);
  if (effectiveVt < requiredForEffective) {
    effectiveVt = requiredForEffective;
    issues.push({
      env: VISIBILITY_TIMEOUT_ENV,
      raw: String(vt.value),
      effective: effectiveVt,
      kind: "clamped",
      message:
        `visibility timeout raised from ${vt.value}s to ${effectiveVt}s: ${binding.because} cannot cover ` +
        `even one message (${PER_MESSAGE_VT_BUDGET_SECONDS}s), so concurrency was already floored at ` +
        `${coherentN} (never 0 — that drains nothing while every liveness signal stays green) and the ` +
        `timeout had to come up with it. The worker sets sleep_seconds on every pgmq read, so this needs ` +
        `no chart change; set ${VISIBILITY_TIMEOUT_ENV} >= ${PER_MESSAGE_VT_BUDGET_SECONDS} to make it ` +
        `explicit.`
    });
  }

  // The one ceiling this function cannot fix by itself. `sleep_seconds` is ours;
  // the isolate lifetime belongs to the demuxer, so if it is below even one
  // message's budget all we can do is drain at n=1 and say so.
  if (lifetimeSeconds < requiredForEffective) {
    issues.push({
      env: ISOLATE_LIFETIME_ENV,
      effective: lifetimeSeconds,
      kind: "invariant",
      message:
        `isolate lifetime ${lifetimeSeconds}s is below the ${requiredForEffective}s a batch of ` +
        `${coherentN} needs, and this module cannot raise it — it belongs to the demuxer. Draining at ` +
        `n=${coherentN} anyway. Raise edgeFunctions.worker.timeoutMs to >= ${requiredForEffective * 1000} ` +
        `(keeping gracefulExitTimeoutSeconds / terminationGracePeriodSeconds above it).`
    });
  }

  return { drainConcurrency: coherentN, visibilityTimeoutSeconds: effectiveVt, issues };
}
