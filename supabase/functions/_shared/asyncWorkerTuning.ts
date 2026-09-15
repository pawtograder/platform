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
 *     STILL TRUE PER LEASEHOLDER; NO LONGER TRUE FLEET-WIDE. See the 2026-09-13
 *     update at the bottom of this comment. `n` is still the ceiling for ONE
 *     leaseholder, and it is still the only knob that changes how many messages
 *     one leaseholder has in flight. What changed is that the number of
 *     leaseholders stopped being 1: per-org slots (`globalCap` below) make fleet
 *     concurrency `leaseholders x n`. The sentence "nothing about the pod count
 *     changes that" is therefore now scoped to a single leaseholder.
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
 * runs inside ONE leaseholder isolate — and that stays exactly true under
 * per-org leases, because each per-org leaseholder IS its own isolate. Both
 * ceilings are therefore PER LEASEHOLDER, not aggregates over the fleet: they
 * bound one isolate's batch of `n`, and adding leaseholders does not move
 * either one. That is the whole reason `n` can stay at 4 and
 * `EDGE_WORKER_TIMEOUT_MS` / the visibility timeout need no change to get more
 * throughput. If the batch outlives that lifetime
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
 * (The 279.5s figure is the 2026-09-07 number and is now an outlier, not the
 * norm — p50 is 23.1s as of 2026-09-13. See the update at the bottom. The model
 * is left at `n * 120` anyway: it is an upper bound, it is what the chart's
 * render-time rules encode, and re-deriving it downward would buy nothing but a
 * shorter recovery latency while costing a lockstep chart change.)
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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * UPDATE 2026-09-13 — PER-ORG LEASEHOLDERS, AND A RE-MEASUREMENT
 * ───────────────────────────────────────────────────────────────────────────
 *
 * THE 279.5s p50 QUOTED ABOVE IS NO LONGER REPRESENTATIVE. Re-measured on prod
 * 2026-09-13 over 242 `create_repo` messages: p50 23.1s, max 32.2s. That is a
 * ~12x improvement on the median and it is not noise — two things differ from
 * the 2026-09-07 sample:
 *
 * (THAT 32.2s MAX IS ONE ORG ON ONE DAY, and it was wrongly reused elsewhere in
 * this file as a PLATFORM maximum. Across all methods on the VT=480 regime,
 * 2026-09-11 onward, 2,337 messages, the real max is 97.7s and `create_repo` p99
 * is 93.8s over 489 samples. See MIN_ORG_SLOT_LEASE_TTL_SECONDS for the table,
 * and for why that does NOT move the lease-TTL floor.)
 *
 *   * the permission-sync fix landed in between, which removed the dominant
 *     uninstrumented stretch inside `createRepo`; and
 *   * the 2026-09-07 sample was entirely CS 4530, whose GitHub org has ~20k
 *     members. Org-membership-sensitive calls scale with that, so 279.5s was a
 *     worst case for the largest org on the platform, not a platform median.
 *
 * The old number is deliberately NOT deleted from this file. It is the
 * calibration behind `PER_MESSAGE_VT_BUDGET_SECONDS` and behind the chart's
 * render-time rules, and "a big org on a bad day still costs minutes" remains
 * the case the timeouts have to survive. Read every "279.5s" / "~4.7 minutes" /
 * "~280s" in this file as: the 2026-09-07 CS 4530 worst case, since improved to
 * p50 27.8s / p99 93.8s / max 97.7s across 489 `create_repo` messages on the
 * VT=480 regime (2026-09-11 onward).
 *
 * WHAT ACTUALLY CHANGED STRUCTURALLY, which matters more than the number.
 * There is no longer ONE leaseholder per deployment. `beginOrgLeaseRun`
 * (_shared/orgLeaseRun.ts) claims a slot for a SPECIFIC GitHub org out of a
 * server-side table and drains only that org's messages, and EACH LEASEHOLDER
 * IS ITS OWN ISOLATE. The consequences, stated as the invariants this file
 * exists to protect:
 *
 *   * THE TWO CEILINGS ARE PER LEASEHOLDER, NOT AGGREGATE. The 256MiB
 *     `edgeFunctions.worker.memoryLimitMb` cap bounds one isolate's heap, and
 *     `visibility timeout >= n * PER_MESSAGE_VT_BUDGET_SECONDS` bounds one
 *     isolate's batch. Neither is a statement about the fleet, so neither moves
 *     when leaseholders are added.
 *
 *   * THEREFORE CONCURRENCY COMES FROM MORE ISOLATES, NOT A BIGGER BATCH. `n`
 *     stays 4 and `EDGE_WORKER_TIMEOUT_MS` and the visibility timeout need NOT
 *     change to get more throughput. This is the point of the design: the
 *     previous way to go faster was to raise `n`, which required raising two
 *     timeouts in lockstep (and `gracefulExitTimeoutSeconds` and
 *     `terminationGracePeriodSeconds` with them) and lengthened EVERY
 *     function's isolate lifetime in the pod. Adding a leaseholder requires
 *     none of that.
 *
 *   * THE RATE LIMIT THIS IS ALL FOR IS PER ORG. The GitHub content limiter is
 *     40 concurrent / 40 per minute PER ORG (see MAX_DRAIN_CONCURRENCY below).
 *     With one FIFO leaseholder, several classes in DIFFERENT orgs releasing at
 *     once drained one behind the other and left most of GitHub's headroom
 *     unused. Per-org slots let those orgs drain in parallel. They do NOT make
 *     one org faster, which is why `MAX_ORG_SLOT_MAX_PER_ORG` is small — see
 *     its comment for the arithmetic.
 *
 * WHAT DOES NOT CHANGE. `n` is still the per-leaseholder concurrency ceiling
 * and still has to fit under both ceilings; the enforcement below is unchanged
 * and still runs. The per-org knobs are additive and DEFAULT TO OFF
 * (`globalCap: 0`), so this file keeps the property the header already
 * promises: deploying it alters nothing until an operator sets an env var.
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
 *    RE-MEASURED 2026-09-13 (242 messages, neu-cs2000): p50 23.1s, max 32.2s.
 *    Platform-wide over 489 `create_repo` messages from 2026-09-11: p50 27.8s,
 *    p99 93.8s, max 97.7s. The MEDIAN is what this argument turns on and it is
 *    unchanged in kind: a slot is held for ~23-28s, not ~280s, which flips WHICH
 *    HALF OF THE LIMITER BINDS. At
 *    ~280s the 40-way CONCURRENCY was the scarce half; at 23.1s the 40/minute
 *    RESERVOIR is, because 8 concurrent creations at 23.1s each start
 *    8 / 23.1 * 60 ~= 21 repos/minute, i.e. ~52% of the reservoir. That
 *    arithmetic is what bounds MAX_ORG_SLOT_MAX_PER_ORG below; 8 is kept here
 *    because it is still 20% of the concurrency pool and because the 2026-09-07
 *    worst case (a ~20k-member org) has not been shown to be impossible, only
 *    to be rare.
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
 *    "SEVERAL CLASSES RELEASING INTO THE SAME ORG AT ONCE" IS NOW A KNOB rather
 *    than only a hazard: `MAX_ORG_SLOT_MAX_PER_ORG` is how many leaseholders may
 *    hold a slot for ONE org at the same time, so the per-org in-flight ceiling
 *    is `maxPerOrg * n`, and `resolveAsyncWorkerTuning` holds that product at or
 *    below MAX_ORG_SLOT_IN_FLIGHT_PER_ORG by degrading `maxPerOrg`.
 *
 *    THAT PRODUCT CEILING IS NO LONGER THIS SAME 8 (changed 2026-09-14). It was,
 *    and reusing this constant for it was a conflation: this 8 is about ONE
 *    ISOLATE (heap, and the n x 120 VT model), the product is about ONE ORG's
 *    share of a fleet-wide GitHub limiter. The product ceiling is now its own
 *    constant at 16; this one is unchanged at 8 and its argument is untouched.
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
 *    that isolate is capped at `edgeFunctions.worker.memoryLimitMb` (256MiB).
 *    That is still exactly true with per-org leaseholders, because each one is
 *    its OWN isolate with its OWN 256MiB: adding leaseholders adds isolates, it
 *    does not grow this box. What it does do is consume `maxParallelism`
 *    admission slots, which is where MAX_ORG_SLOT_GLOBAL_CAP gets its bound.
 *    The isolate is capped at 256MiB
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
 *
 * THAT SEPARATE DESIGN CHANGE HAS NOW LANDED (2026-09-13), so the last sentence
 * is superseded: per-org slots are the "more than one concurrent leaseholder"
 * it points at. They do not raise this ceiling — 8 is still the right number for
 * ONE leaseholder against ONE org — they add leaseholders for OTHER orgs. See
 * MAX_ORG_SLOT_GLOBAL_CAP / MAX_ORG_SLOT_MAX_PER_ORG below and
 * _shared/orgLeaseRun.ts.
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

/**
 * ───────────────────────────────────────────────────────────────────────────
 * OPEN QUESTION (recorded 2026-09-14, DELIBERATELY NOT ACTED ON)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * THE ISOLATE-LIFETIME CAP HAS STOPPED MEANING WHAT IT SAYS ON THE ORG-LEASED
 * PATH. `resolveAsyncWorkerTuning` degrades `n` to
 * `floor(lifetime / PER_MESSAGE_VT_BUDGET_SECONDS)` on the argument that a
 * whole batch runs inside ONE isolate and must fit inside that isolate's life.
 * That argument is about a BATCH: a bounded unit of work with a start and an
 * end, which either fits or does not.
 *
 * Continuous refill does not have batches. `drainWithContinuousRefill` keeps `n`
 * in flight and tops up the shortfall as each message settles, so the drain is a
 * STREAM that is deliberately never finished — it is cut off mid-flight when
 * `beforeUnload.wallClockRatio: 50` retires the isolate at ~half the lifetime,
 * and the orphaned messages are redelivered at their visibility timeout. "Does
 * the work fit inside the lifetime" has no answer for a stream, because the
 * stream is designed not to fit. So the cap is still computed, still applied,
 * and its stated justification no longer describes the thing it is capping.
 *
 * IT IS LEFT EXACTLY AS IT IS, and not because nobody noticed:
 *
 *   * IT IS STILL CORRECT FOR THE NON-REFILL PATHS. The single-leaseholder
 *     drain (`globalCap: 0`, still the shipped default) and the batch shape
 *     reachable through the kill switch above are both genuinely batched, and
 *     for them the original argument holds unaltered.
 *   * THE DIRECTION IT ERRS IN IS SAFE. It only ever REDUCES `n`. On the refill
 *     path that costs throughput and nothing else; the failure it was written to
 *     prevent — an isolate dying before `Promise.allSettled` reaches the archive
 *     calls — is a real failure on the refill path too, just no longer bounded
 *     by this arithmetic.
 *   * CHANGING IT IS A LOCKSTEP CHART CHANGE. templates/validations.yaml encodes
 *     the same rule at render time, so any edit here is a coupled edit there,
 *     and neither should happen on an argument this file cannot yet finish.
 *
 * WHAT WOULD SETTLE IT: a measurement of what a refill stream actually loses per
 * isolate retirement, against what capping `n` actually buys it. orgLeaseRun.ts
 * already argues by Little's law that the orphan RATE is `mean duration /
 * lifetime` and is unchanged by refill (48.4/240 either way), which suggests the
 * cap buys the refill path nothing at all — but that is an argument, not a
 * measurement, and it points at the visibility timeout rather than at `n`.
 *
 * DO NOT "TIDY" THIS BY DELETING THE CAP OR BY SPECIAL-CASING THE REFILL PATH
 * without that measurement. The point of writing it down is that the next person
 * decides it deliberately instead of inheriting it.
 */

// ───────────────────────────────────────────────────────────────────────────────
// PER-ORG LEASE SLOTS (2026-09-13)
//
// THE PARSING RULES ARE THE SAME AS FOR THE TWO KNOBS ABOVE: bounded integers,
// an unparseable value falls back and is REPORTED, an out-of-range value is
// CLAMPED and reported, and the defaults reproduce today's behaviour exactly —
// here that means `globalCap: 0`, i.e. per-org leasing OFF and the
// single-leaseholder `pgmq_public.read` path still in force. Deploying this
// changes nothing until someone sets GITHUB_ASYNC_WORKER_ORG_SLOT_GLOBAL_CAP.
//
// WHERE THE VALUES COME FROM IS ALSO THE SAME: chart values only.
// `_edge-functions-workload.tpl` renders all three as explicit `env` entries
// (`edgeFunctions.githubAsyncWorker.orgSlotGlobalCap` / `.orgSlotMaxPerOrg` /
// `.orgSlotLeaseTtlSeconds`), and an `env` entry BEATS anything supplied by
// `envFrom` — so setting them through `edgeFunctions.envFromSecrets` is silently
// ignored, exactly as it is for the two knobs above. The validation below is
// therefore defence in depth against the Helm-bypass paths (a hand-edited
// Deployment, `kubectl set env`, a local `supabase functions serve`), plus the
// only thing standing between a malformed value and the RPC — which is why it
// clamps rather than refuses.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Env var for the fleet-wide cap on concurrent per-org leaseholders
 * (chart: edgeFunctions.githubAsyncWorker.orgSlotGlobalCap). 0 disables per-org
 * leasing entirely and is the default.
 */
export const ORG_SLOT_GLOBAL_CAP_ENV = "GITHUB_ASYNC_WORKER_ORG_SLOT_GLOBAL_CAP";
/**
 * Env var for how many leaseholders may hold a slot for the SAME org at once
 * (chart: edgeFunctions.githubAsyncWorker.orgSlotMaxPerOrg).
 */
export const ORG_SLOT_MAX_PER_ORG_ENV = "GITHUB_ASYNC_WORKER_ORG_SLOT_MAX_PER_ORG";
/**
 * Env var for the org slot's lease TTL in seconds
 * (chart: edgeFunctions.githubAsyncWorker.orgSlotLeaseTtlSeconds).
 */
export const ORG_SLOT_LEASE_TTL_ENV = "GITHUB_ASYNC_WORKER_ORG_SLOT_LEASE_TTL_SECONDS";
/**
 * Env var for the continuous-refill KILL SWITCH, 1 = on (the default), 0 = off
 * (chart: edgeFunctions.githubAsyncWorker.orgSlotContinuousRefill).
 */
export const ORG_SLOT_CONTINUOUS_REFILL_ENV = "GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL";

/**
 * 0 — PER-ORG LEASING OFF. This is the inert default, and it is the one place in
 * this file where 0 is a legitimate value rather than the "drains nothing while
 * every liveness signal stays green" failure MIN_DRAIN_CONCURRENCY exists to
 * forbid. The difference is what 0 selects: `n: 0` would leave the worker
 * looping and reading nothing, whereas `globalCap: 0` selects the EXISTING
 * single-leaseholder Redis-lease drain, which is a complete, shipped, draining
 * worker. Off here means "the old path", not "no path".
 */
export const DEFAULT_ORG_SLOT_GLOBAL_CAP = 0;
/** Same reasoning as the default: 0 is "use the old path", so it must be reachable. */
export const MIN_ORG_SLOT_GLOBAL_CAP = 0;
/**
 * 8, matching `edgeFunctions.maxParallelism` — and matching it for the same
 * reason MAX_DRAIN_CONCURRENCY does, but through a different mechanism.
 *
 * Every leaseholder is a RESIDENT isolate: it holds one of the pod's
 * `maxParallelism` admission slots and one `worker.memoryLimitMb` (256MiB) heap
 * for as long as it keeps draining. The chart's own memory budget is written as
 * `eszipCacheMaxMb + eszipColdLoadHeadroomMb + maxParallelism x
 * worker.memoryLimitMb + ~90Mi host` (values.yaml ~line 1172), i.e. the pod is
 * already sized for 8 concurrent isolates and no more.
 *
 * The cap is FLEET-WIDE and `maxParallelism` is PER POD, so those two are only
 * the same number under the worst case — every leaseholder landing on one pod.
 * Nothing schedules leaseholders across pods: a poke is an HTTP call through the
 * service, so placement is whatever the service picks. Production pins the edge
 * HPA at 32 replicas, so in practice 8 leaseholders spread thin; but sizing to
 * the worst case is what makes this safe without a placement guarantee. Raising
 * it past 8 needs measured per-pod colocation, not an argument about averages.
 *
 * Note what this does NOT bound: GitHub concurrency. That is bounded per org by
 * MAX_ORG_SLOT_MAX_PER_ORG and the content limiter, and 8 leaseholders against 8
 * DIFFERENT orgs is 8 separate 40-slot pools, which is the entire point of the
 * change.
 */
export const MAX_ORG_SLOT_GLOBAL_CAP = 8;

/**
 * 1. One leaseholder per org is enough to saturate an org's useful headroom at
 * the default `n`, and starting at 1 means enabling the feature (setting only
 * globalCap) buys cross-org parallelism without changing anything about how hard
 * any single org is hit — the smallest step that is still the whole point.
 *
 * THIS DID NOT MOVE WHEN THE CEILING DID (2026-09-14, MAX_ORG_SLOT_MAX_PER_ORG
 * 2 -> 4). Raising the ceiling makes higher values EXPRESSIBLE for deployments
 * whose `create_repo` is slow; it does not make them advisable, because this
 * knob has no per-org dimension and the measured spread in `create_repo` p50
 * between orgs on one platform is 2x (23.1s to 46.0s — see
 * MAX_ORG_SLOT_IN_FLIGHT_PER_ORG). Turning it up stays an operator decision
 * taken against a measurement of THEIR orgs, not a chart default.
 */
export const DEFAULT_ORG_SLOT_MAX_PER_ORG = 1;
/** 0 would mean no org can ever be drained, which is the hung-queue failure again. */
export const MIN_ORG_SLOT_MAX_PER_ORG = 1;
/**
 * 16 in flight for ONE org. This is the ceiling the product `maxPerOrg * n` is
 * held under, and it is a SEPARATE CONSTANT FROM MAX_DRAIN_CONCURRENCY ON
 * PURPOSE.
 *
 * REUSING MAX_DRAIN_CONCURRENCY FOR THIS WAS THE MISTAKE THIS CONSTANT FIXES.
 * That one bounds ONE ISOLATE'S BATCH — 256MiB of heap, and the `n x 120`
 * visibility-timeout model. This one bounds ONE ORG'S SHARE of a fleet-wide
 * GitHub limiter. They are different quantities about different resources that
 * happened to agree on the number 8, and while they shared a constant neither
 * could move without dragging the other. Only the product moved here; `n` is
 * still capped at 8 and the VT model is untouched.
 *
 * WHY 16 AND NOT 8. 8 was never wrong. It is ~50% of the reservoir at the FAST
 * end (see the table), it is 20% of the 40-slot concurrency pool, and it is the
 * only number in this file that was ever derived from a measurement rather than
 * chosen. What 2026-09-14 changed is that 8 was not expressible as a RANGE: it
 * was simultaneously the ceiling and, at the recommended `maxPerOrg: 2`, the
 * recommended value, so a deployment whose `create_repo` is slow had no way to
 * ask for more. 16 is the ceiling. It is NOT the recommendation, and nothing
 * moves to it on its own — see DEFAULT_ORG_SLOT_MAX_PER_ORG.
 *
 * THE ARITHMETIC, AND IT CUTS BOTH WAYS. The per-org content limiter has TWO
 * constraints — `maxConcurrent: 40` AND a reservoir of 40 STARTS PER 60s — and
 * the reservoir is the one that binds at today's durations. With `c` creations
 * in flight at `d` seconds each, starts per minute is `60c/d`. Measured p50
 * `create_repo` on Khoury prod over the 3 days to 2026-09-14 (`pgmq.a_async_calls`,
 * duration = `archived_at - (vt - 480s)`, prod VT 480):
 *
 *     org              d        c = 8                    c = 16
 *     ------------------------------------------------------------------------
 *     neu-cs2000       23.1s    20.8/min   (52%)         41.6/min  OVER 40/min
 *     Khoury-CS3650    46.0s    10.4/min   (26%)         20.9/min  (52%)
 *     neu-cs5004       25.7s    18.7/min   (47%)         37.4/min  (93%)
 *     neu-cs4530       30.4s    15.8/min   (39%)         31.6/min  (79%)
 *
 * READ THAT AS: 16 IN FLIGHT IS SAFE FOR A SLOW ORG AND SATURATES A FAST ONE.
 * There is a 2x spread in `d` between orgs on ONE platform, and
 * `orgSlotMaxPerOrg` IS A SINGLE GLOBAL KNOB WITH NO PER-ORG DIMENSION. An
 * operator who raises it because Khoury-CS3650 is slow raises it for
 * neu-cs2000 too, where the same setting starts creations faster than the
 * reservoir refills them. The overflow does not surface here: it queues inside
 * Bottleneck, and what it delays is everything else drawing on the same pool —
 * `reinviteToOrgTeam`'s org invitations and `sync_repo_to_handout`. That is
 * students unable to join the org while repos are created, which is the exact
 * failure the original "20% of the 40-slot pool" rule was written to prevent
 * and a worse symptom than a slow queue.
 *
 * SAMPLE SIZES, WHICH THE TABLE DOES NOT CARRY: n = 241, 187, 12 and 4
 * respectively (read_ct = 1). The bottom two rows are illustrative, not
 * measurements. The fastest org in the same window, `neu-cs4535` at p50 5.8s,
 * would be ~165/min at c=16 — FOUR TIMES the reservoir — on TWO samples. Two
 * samples is not evidence, but it is the direction the error runs, and a knob
 * with no per-org dimension has to be sized for the org that is worst for it.
 *
 * WHAT WOULD JUSTIFY MOVING THE DEFAULT UP: a per-org dimension on this knob,
 * so the ceiling can follow the measured `d` of the org it applies to. Until
 * that exists, the honest position is a wide ceiling and a conservative
 * default, and an operator who raises it has to have measured THEIR org.
 */
export const MAX_ORG_SLOT_IN_FLIGHT_PER_ORG = 16;

/**
 * 4 — which is MAX_ORG_SLOT_IN_FLIGHT_PER_ORG (16) at the shipped `n` of 4.
 * Raised from 2 on 2026-09-14.
 *
 * THIS IS A BOUND ON WHAT IS EXPRESSIBLE, NOT A RECOMMENDATION. What ships is
 * DEFAULT_ORG_SLOT_MAX_PER_ORG = 1; the recommended prod value in values.yaml
 * is 2 (8 in flight at n=4), which is the measured figure and has not moved.
 * The reservoir arithmetic for why 4 is safe on a slow org and over budget on a
 * fast one is on MAX_ORG_SLOT_IN_FLIGHT_PER_ORG above — read it before typing
 * 4 into a values file.
 *
 * The two ceilings `resolveOrgSlotTuning` enforces are unchanged in kind:
 *   * `maxPerOrg * n <= MAX_ORG_SLOT_IN_FLIGHT_PER_ORG`, so 4 is only reachable
 *     at `n <= 4`. At the maximum `n` of 8 the effective ceiling is 2, and at
 *     n=16 it would be 1 — except `n` cannot exceed 8, which is the point of
 *     keeping the two constants apart.
 *   * `maxPerOrg <= globalCap`, because a per-org allowance above the number of
 *     leaseholders that may exist at all can never be reached.
 *
 * MORE THROUGHPUT FOR ONE ORG IS STILL NOT WHAT THIS FEATURE OFFERS. The rate
 * limit is per org and this knob does not move it — raising it spends the
 * limiter's headroom, taking it from org invitations and handout syncs.
 * Throughput across CLASSES comes from globalCap, which is a different knob
 * with a different bound.
 */
export const MAX_ORG_SLOT_MAX_PER_ORG = 4;

/**
 * 60s, matching `DEFAULT_LEASE_TTL_MS` in workerRun.ts so the two lease
 * lifetimes do not drift. Renewal is at TTL/3 on an independent timer, so 60s
 * gives three renewal attempts before a slot lapses.
 */
export const DEFAULT_ORG_SLOT_LEASE_TTL_SECONDS = 60;
/**
 * 45s floor. THE NUMBER IS UNCHANGED; THE ARGUMENT FOR IT IS NOT, AND THE OLD
 * ARGUMENT WAS WRONG (corrected 2026-09-14).
 *
 * WHAT THIS FILE USED TO SAY: "the MAX observed `create_repo` was 32.2s; the
 * renewal timer runs on the same event loop as the handlers, so a busy isolate
 * can delay it; a TTL at or below the longest single unit of work means a
 * leaseholder that is genuinely working can have its slot reaped mid-message."
 * Both halves of that are wrong, and they were wrong in opposite directions,
 * which is the only reason the conclusion survived.
 *
 * THE MEASUREMENT WAS WRONG. 32.2s was never a platform maximum — it was the max
 * `create_repo` for ONE org (neu-cs2000) on ONE day. Re-measured across ALL
 * methods on the VT=480 regime (2026-09-11 onward, 2,337 messages, `read_ct=1`,
 * duration = `archived_at - (vt - 480s)`):
 *
 *     method                   n     p50     p95     p99     MAX
 *     create_repo            489   27.8s   69.9s   93.8s   97.7s
 *     sync_student_team     1168    1.0s   10.6s   16.8s   30.3s
 *     sync_repo_permissions  653    1.4s   14.6s   19.8s   21.1s
 *     sync_repo_to_handout     1   15.7s       -       -   15.7s
 *     rerun_autograder         8   11.1s       -       -   12.5s
 *     sync_staff_team         18    0.9s    7.1s    7.8s    8.0s
 *
 * The real longest unit of work is 97.7s — 3x the cited figure — and 36 of the
 * 2,337 messages (1.5%) run longer than the shipped 60s TTL. Note also that
 * `create_repo` is the worst method and `sync_repo_permissions` is nearly the
 * best: the intuition that permission sync against a ~20k-member org would
 * dominate does not survive the data.
 *
 * (METHOD NOTE, because this is easy to get wrong twice: the prod visibility
 * timeout changed from 300s to 480s on 2026-09-10, and `vt` in the archive
 * table is the read-time vt. Subtracting a flat 480 across the boundary inflates
 * every pre-09-10 duration by exactly 180s and manufactures ~480s maxima out of
 * ~300s messages. Restrict to one VT regime, or derive the VT per row.)
 *
 * THE MECHANISM WAS ALSO WRONG, AND THAT IS WHY 97.7s > 60s IS NOT A BUG.
 * Renewal is NOT coupled to the handlers. `beginOrgLeaseRun` schedules it as
 * `setInterval(renew, ttlMs / HEARTBEAT_DIVISOR)` (orgLeaseRun.ts ~line 443) —
 * a macrotask timer that fires on its own — and that independence is deliberate:
 * the generation-counter comment in `renew` rejects a lock around claim-and-renew
 * precisely because "blocking renewal behind that is exactly what the independent
 * timer exists to prevent: a long batch would let the lease lapse." The handlers
 * are await-driven I/O (137 `await`s in github-async-worker/index.ts; no
 * `readFileSync`, no synchronous (de)compression, no unbounded synchronous
 * loops), and every Octokit call and every `Bottleneck.schedule()` is awaited.
 * A 97.7s `create_repo` is 97.7s of AWAITING, during which the loop is free and
 * the timer fires ~5 times at a 60s TTL.
 *
 * THEREFORE THE QUANTITY THIS FLOOR MUST EXCEED IS NOT MESSAGE DURATION. It is
 * THE LONGEST THE EVENT LOOP CAN GO UNYIELDING. A lease lapses only if NO
 * renewal succeeds for a whole TTL, and at `TTL/3` that needs THREE consecutive
 * missed firings — a ~TTL-long unyielding stall, not a long message.
 *
 * WHY 45s IS STILL RIGHT UNDER THE CORRECTED ARGUMENT:
 *   * it tolerates a 45s unyielding stall of the isolate's event loop. Nothing
 *     in the worker blocks for anything near that; the candidates would be a
 *     huge synchronous `JSON.parse` or a file-content encoding step, and those
 *     are sub-second at realistic sizes.
 *   * it gives a 15s renewal interval against a renewal that is ONE Postgres
 *     round trip — milliseconds. That is ~3 orders of magnitude of margin, and
 *     two consecutive failures still leave a third attempt inside the TTL.
 *   * a renewal that genuinely cannot reach the database is not a silent lapse:
 *     `renew` treats an RPC error as fatal, ends the run and gives the slot up,
 *     on the argument that the lease and the queue are the same database.
 *
 * SO THE FLOOR WAS NOT RAISED TO CLEAR 97.7s, AND SHOULD NOT BE. Tying it to
 * message duration would mean re-raising it whenever a slower org appears, and
 * it would re-encode a coupling between the renewal timer and the handlers that
 * does not exist. If a future handler ever DOES block the loop — a synchronous
 * crypto or compression step, a megabyte-scale parse in a tight loop — that is
 * what moves this number, and the measurement to take then is EVENT-LOOP DELAY,
 * not time-in-queue.
 *
 * WHERE THE 97.7s FIGURE IS GENUINELY LOAD-BEARING is the RELEASE path, not this
 * floor: a run that drops its slot while handlers are still in flight leaves up
 * to 97.7s of GitHub work running with no slot, and a second leaseholder can
 * enter that org. That is `releaseSlotUnlessDraining` and the "keep renewing
 * while draining" rule in orgLeaseRun.ts, which already cites 94.8s.
 *
 * THAT FILE REACHED THE SAME CONCLUSION FROM THE OTHER DIRECTION, INDEPENDENTLY.
 * Continuous refill made it possible for a run to finish with `n-1` messages
 * still going for up to a worst-case message against a 60s TTL, and the fix
 * chosen there was to KEEP RENEWING WHILE DRAINING — not to raise the TTL. If
 * duration-vs-TTL were the binding relation that fix would be impossible, so
 * two independent lines of reasoning now agree that renewal is decoupled from
 * message duration.
 *
 * EMPIRICALLY, ~17h after per-org leaseholders went live at
 * `orgSlotLeaseTtlSeconds: 60` and including a 190-repo burst: no cap breach, no
 * org-lease errors, `create_repo` redelivery 1.9%, and `public.async_worker_slots`
 * shows 0 lapsed rows and no org holding more than `max_per_org`. That is what
 * the corrected mechanism predicts. The OLD mechanism predicts a reaped slot on
 * each of the 36 over-60s messages, and none of those happened.
 */
export const MIN_ORG_SLOT_LEASE_TTL_SECONDS = 45;
/**
 * 300s ceiling. The TTL is the SLOT RECOVERY LATENCY: when a leaseholder's
 * isolate dies without releasing, its org keeps that slot pinned until the TTL
 * lapses. Two independent limits put the ceiling at 300s and they agree:
 *
 *   * it must not outlive the messages it was holding. Those become visible
 *     again at the pgmq visibility timeout (300s by default), so a longer TTL
 *     leaves an org's headroom pinned by a dead holder while that same org's
 *     work is already redeliverable — the queue is drainable and the slot says
 *     otherwise. `resolveAsyncWorkerTuning` enforces `ttl <= visibility timeout`
 *     rather than trusting this bound alone, since the VT is itself a knob.
 *   * it must not outlive the isolate. `EDGE_WORKER_TIMEOUT_MS` is 400s, and
 *     `beforeUnload.wallClockRatio: 50` retires isolates at ~200s, so a TTL
 *     above the isolate lifetime would mean EVERY naturally-retired leaseholder
 *     leaves a slot pinned for the remainder. Also enforced, against the
 *     configured lifetime rather than the constant.
 */
export const MAX_ORG_SLOT_LEASE_TTL_SECONDS = 300;

/**
 * CONTINUOUS REFILL: ON by default, and this knob exists ONLY so it can be
 * turned off without a code deploy.
 *
 * WHAT IT SWITCHES. `drainWithContinuousRefill` (orgLeaseRun.ts) keeps `n`
 * messages in flight and claims the SHORTFALL as each one settles, instead of
 * draining a whole batch and then re-claiming. The batch shape wastes the tail
 * of every batch waiting on its straggler: measured on the 2026-09-13 burst,
 * 47 batches of exactly 4, mean message 48.4s against mean batch 68.4s, so ~27%
 * of every slot-second was a claimed slot waiting on its batch-mates, and
 * effective concurrency was 5.20 of a possible 8.
 *
 * WHY IT SHIPS ON. It is the point of the change and the utilisation argument is
 * arithmetic, not a guess. But it IS a real behavioural change to the drain
 * shape, and until yesterday the only way to undo it was `orgSlotGlobalCap: 0`
 * — which also switches off per-org leaseholders entirely and gives back the
 * cross-org throughput that is already working in production. THAT IS WHAT THIS
 * KNOB IS FOR: rolling back the drain shape while keeping the feature. It is an
 * ops affordance, not a tuning parameter, and the expected number of
 * deployments that ever set it to 0 is zero.
 *
 * WHY A BOOLEAN, WHICH WAS A REAL CHOICE AND NOT A DEFAULT. The obvious
 * alternative is a LOW-WATER MARK — "top up when in flight drops to `k`" —
 * which reduces to this switch at its endpoints (`k = n-1` is continuous
 * refill, `k = 0` is the old batch shape) and expresses the middle. There is
 * even a genuine axis underneath it: every claim takes a GLOBAL
 * `pg_advisory_xact_lock`, so refill raises claim traffic from one RPC per
 * batch to one per message, and a low-water mark would trade that against
 * utilisation. It was rejected on three grounds, and the third is dispositive:
 *
 *   1. THE AXIS IS NOT UNDER PRESSURE. Measured claim rate under refill is
 *      ~0.66/s fleet-wide at `globalCap: 8` against a measured ceiling around
 *      288/s. Tuning a resource with a 400x margin is inventing a decision.
 *   2. NOBODY HAS MEASURED THE MIDDLE. The endpoints are both measured; no
 *      value of `k` between them has ever been run, so the range would ship
 *      with only its two ends justified.
 *   3. `drainWithContinuousRefill` HAS NO SUCH PARAMETER. Its contract is "one
 *      claim per wake-up, top up the shortfall" — there is no `k` to honour.
 *      Rendering a low-water mark into the pod env would put a number in a
 *      values file that nothing reads, which is the exact failure CEILING 2
 *      below refuses for `maxPerOrg`: an unreachable number in a config file is
 *      a number someone will later believe.
 *
 * So the choice really is binary today, and a boolean is the honest shape. If
 * someone later implements a low-water mark, this env var widens from 0-1 to
 * 0-n WITHOUT changing type or name, and 0 keeps meaning "off".
 *
 * WHY AN INTEGER AND NOT A "true"/"false" STRING. `Boolean("false") === true`.
 * A string-valued boolean turns a typo — `"False"`, `"no"`, `"off"`, a trailing
 * space — into SILENT truthiness. Going through `readBounded` instead makes the
 * same input loud: it is REPORTED as rejected, with a Sentry-visible issue.
 *
 * BUT LOUD IS NOT THE SAME AS SAFE, AND THE FIRST VERSION OF THIS KNOB GOT THAT
 * WRONG. Reported or not, `readBounded`'s ordinary rules resolved a rejected
 * value to `fallback` (1) and an out-of-range value by clamping toward the
 * bound (also 1) — so `GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL=false`
 * produced `continuousRefill === true`. THE KILL SWITCH FAILED OPEN ON EXACTLY
 * THE MALFORMED VALUE AN OPERATOR IS MOST LIKELY TO TYPE WHEN REACHING FOR IT,
 * which is the failure the integer was chosen to avoid, reintroduced one layer
 * down. Caught in review on PR #982; this paragraph is kept rather than
 * rewritten because the mistake is the reason the rule below exists.
 *
 * THE RULE THAT MAKES IT ACTUALLY FAIL SAFE is `failSafeValue` on the `Bounds`
 * passed in `resolveOrgSlotTuning`: PRESENT BUT UNUSABLE resolves to 0 (off),
 * ABSENT still resolves to 1 (on). Absence means an older chart or a pre-flag
 * image and is not an edit; a malformed value means somebody edited this
 * variable and got it wrong, and the only reason to edit it is to turn refill
 * off. `"false"`, `"off"`, `"no"`, `"2"` therefore all resolve to OFF, reported.
 *
 * THIS KNOB IS THE ONLY ONE IN THIS FILE THAT NEEDS THAT, and the signature is
 * checkable: it is the only knob whose fallback equals its range MAXIMUM.
 * `globalCap` falls back to 0 (its minimum, feature off), `maxPerOrg` to 1 (its
 * minimum), and `drainConcurrency` / `visibilityTimeout` / `leaseTtl` to a value
 * strictly inside their ranges. For all of those, "fall back to the default" and
 * "fail safe" point the same way, so they deliberately do NOT set the option.
 * A unit test pins that asymmetry so the next permissive-default knob is
 * noticed rather than inherited.
 */
export const DEFAULT_ORG_SLOT_CONTINUOUS_REFILL = 1;
/** 0 = off. The whole point of the knob, so it must be reachable. */
export const MIN_ORG_SLOT_CONTINUOUS_REFILL = 0;
/**
 * 1 = on. Widen this, not the type, if a low-water mark is ever implemented —
 * see DEFAULT_ORG_SLOT_CONTINUOUS_REFILL for why the range stops here today.
 */
export const MAX_ORG_SLOT_CONTINUOUS_REFILL = 1;

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

export type OrgSlotTuning = {
  /**
   * Whether the worker should take the per-org lease path at all. False is the
   * default and means the existing single-leaseholder drain stays in force;
   * when it is false the other FOUR fields are parsed but not in force.
   */
  enabled: boolean;
  /** `max_per_org` for claim_org_slot_and_read. */
  maxPerOrg: number;
  /** `global_cap` for claim_org_slot_and_read. 0 means disabled. */
  globalCap: number;
  /** `lease_ttl_seconds` for claim_org_slot_and_read / renew_org_slot. */
  leaseTtlSeconds: number;
  /**
   * Whether to drain with `drainWithContinuousRefill` (true, the default) or
   * with the batch-and-re-claim shape (false). See
   * DEFAULT_ORG_SLOT_CONTINUOUS_REFILL: this is a kill switch, not a tuning
   * parameter.
   *
   * REPORTED AS CONFIGURED EVEN WHEN `enabled` IS FALSE, deliberately. Forcing
   * it to false with per-org leasing off would conflate "an operator rolled the
   * drain shape back" with "per-org leasing is not on", and those need
   * different responses. It only takes effect on the org-leased path.
   */
  continuousRefill: boolean;
};

export type AsyncWorkerTuning = {
  /** pgmq `read` fan-out; also ONE LEASEHOLDER's concurrency ceiling. */
  drainConcurrency: number;
  /** pgmq `read` `sleep_seconds` (visibility timeout). */
  visibilityTimeoutSeconds: number;
  /** Per-org lease slots. Disabled by default; see the 2026-09-13 header update. */
  orgSlots: OrgSlotTuning;
  /** Non-fatal problems worth surfacing exactly once per isolate. */
  issues: TuningIssue[];
};

type Bounds = {
  env: string;
  min: number;
  max: number;
  fallback: number;
  /**
   * WHAT TO USE WHEN A VALUE IS PRESENT BUT CANNOT BE HONOURED AS WRITTEN —
   * unparseable, or outside [min, max]. Opt-in, and ONE knob sets it.
   *
   * WHEN THIS IS CORRECT, WHICH IS NARROW. `fallback` is right for an ABSENT
   * value, because absence means "nobody has an opinion" and today's shipped
   * behaviour is the right answer. A value that is PRESENT but unusable means
   * the opposite: somebody had an opinion and expressed it badly. For most
   * knobs those two land in the same place anyway, because their `fallback`
   * sits at or toward the CONSERVATIVE end of their range — falling back is
   * already the safe direction, and clamping preserves a legible intent
   * ("they asked for more").
   *
   * SET THIS ONLY FOR A KNOB WHOSE `fallback` IS THE PERMISSIVE END OF ITS OWN
   * RANGE, where those two directions come apart and the default is the one you
   * do NOT want a typo to select. The signature to look for is
   * `fallback === max`. Exactly one knob in this file has it — see
   * DEFAULT_ORG_SLOT_CONTINUOUS_REFILL — and it is a kill switch, where
   * defaulting a malformed value to "on" means the switch does not switch.
   *
   * Leaving it unset preserves the three-behaviour contract below EXACTLY.
   */
  failSafeValue?: number;
};

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
 *
 * ...and one OPT-IN fourth, which only applies when `failSafeValue` is set:
 *
 *  * present but unusable (either of the two cases above)
 *                   -> `failSafeValue`, REPORTED with that as `effective`.
 *                      For a knob whose default is the PERMISSIVE end of its
 *                      range, the two rules above both resolve a typo to the
 *                      permissive answer, which is exactly backwards. See the
 *                      field's own comment on `Bounds` for when that is the
 *                      case; unset, this function behaves exactly as the three
 *                      rules describe.
 */
function readBounded(env: EnvReader, b: Bounds): { value: number; issue?: TuningIssue } {
  const raw = env.get(b.env);
  if (raw === undefined || raw.trim() === "") return { value: b.fallback };

  // Number.parseInt would happily accept "4kB" and "1.9"; require a clean
  // non-negative integer so a unit suffix or a float is reported, not truncated.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    // A PRESENT-BUT-UNUSABLE VALUE IS NOT THE SAME AS AN ABSENT ONE, and for a
    // knob with `failSafeValue` set the difference is the whole point: somebody
    // edited this variable and got it wrong, so resolving to the default — which
    // for such a knob is the permissive end — would silently ignore the edit in
    // the one direction that matters.
    const resolved = b.failSafeValue ?? b.fallback;
    return {
      value: resolved,
      issue: {
        env: b.env,
        raw,
        effective: resolved,
        kind: "rejected",
        message:
          b.failSafeValue === undefined
            ? `${b.env}=${JSON.stringify(raw)} is not a non-negative integer; falling back to ${b.fallback}`
            : `${b.env}=${JSON.stringify(raw)} is not a non-negative integer. Using the FAIL-SAFE value ` +
              `${resolved} rather than the default ${b.fallback}: this knob's default is the permissive end ` +
              `of its range, so resolving a malformed value to it would ignore the edit in exactly the ` +
              `direction that matters. Set ${b.env} to an integer in [${b.min}, ${b.max}].`
      }
    };
  }
  if (parsed < b.min || parsed > b.max) {
    const bound = parsed < b.min ? b.min : b.max;
    const which = parsed < b.min ? `below the minimum ${b.min}` : `above the maximum ${b.max}`;
    // Clamping keeps a legible intent for a RANGE knob ("they asked for more").
    // For a fail-safe knob there is no "more" to ask for — the range is binary —
    // so an out-of-range value is just as unusable as an unparseable one.
    const resolved = b.failSafeValue ?? bound;
    return {
      value: resolved,
      issue: {
        env: b.env,
        raw,
        effective: resolved,
        kind: "clamped",
        message:
          b.failSafeValue === undefined
            ? `${b.env}=${trimmed} is ${which}; clamped to ${bound}`
            : `${b.env}=${trimmed} is ${which}. Using the FAIL-SAFE value ${resolved} rather than clamping ` +
              `to ${bound}: this knob's range is binary, so an out-of-range value expresses no intent to ` +
              `preserve, and clamping it toward the default would resolve a typo to the permissive answer.`
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
    return {
      drainConcurrency: n.value,
      visibilityTimeoutSeconds: vt.value,
      orgSlots: resolveOrgSlotTuning(env, n.value, vt.value, lifetimeSeconds, issues),
      issues
    };
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

  return {
    drainConcurrency: coherentN,
    visibilityTimeoutSeconds: effectiveVt,
    orgSlots: resolveOrgSlotTuning(env, coherentN, effectiveVt, lifetimeSeconds, issues),
    issues
  };
}

/**
 * Resolve the three per-org slot knobs, against the ALREADY-EFFECTIVE `n` and
 * visibility timeout.
 *
 * Taking the effective values rather than the configured ones is the whole
 * reason this runs last: the per-org in-flight ceiling is `maxPerOrg * n`, and
 * if `n` was degraded by the coherence enforcement above then `maxPerOrg` gets
 * to be correspondingly larger. Checking against the configured `n` would
 * restrict a leaseholder that is not going to run that wide anyway.
 *
 * COHERENCE CHECKS ONLY RUN WHEN THE FEATURE IS ON. Range and parse issues are
 * always reported — a typo is a typo whether or not the value is in force — but
 * clamping `maxPerOrg` against an `n` that no leaseholder will ever use would
 * emit a Sentry warning about a number that has no effect. `globalCap: 0` is the
 * shipped default, so that noise would be on every deployment.
 *
 * `issues` is mutated rather than returned so the ordering of the issue list
 * stays "the order the knobs were resolved in", which the tests assert on.
 */
function resolveOrgSlotTuning(
  env: EnvReader,
  drainConcurrency: number,
  visibilityTimeoutSeconds: number,
  isolateLifetimeSeconds: number,
  issues: TuningIssue[]
): OrgSlotTuning {
  const cap = readBounded(env, {
    env: ORG_SLOT_GLOBAL_CAP_ENV,
    min: MIN_ORG_SLOT_GLOBAL_CAP,
    max: MAX_ORG_SLOT_GLOBAL_CAP,
    fallback: DEFAULT_ORG_SLOT_GLOBAL_CAP
  });
  if (cap.issue) issues.push(cap.issue);

  const perOrg = readBounded(env, {
    env: ORG_SLOT_MAX_PER_ORG_ENV,
    min: MIN_ORG_SLOT_MAX_PER_ORG,
    max: MAX_ORG_SLOT_MAX_PER_ORG,
    fallback: DEFAULT_ORG_SLOT_MAX_PER_ORG
  });
  if (perOrg.issue) issues.push(perOrg.issue);

  const ttl = readBounded(env, {
    env: ORG_SLOT_LEASE_TTL_ENV,
    min: MIN_ORG_SLOT_LEASE_TTL_SECONDS,
    max: MAX_ORG_SLOT_LEASE_TTL_SECONDS,
    fallback: DEFAULT_ORG_SLOT_LEASE_TTL_SECONDS
  });
  if (ttl.issue) issues.push(ttl.issue);

  // The refill kill switch. Parsed through the same bounded-integer path as the
  // other three, PLUS the only `failSafeValue` in this file.
  //
  // WHY IT NEEDS THE EXTRA RULE AND ITS NEIGHBOURS DO NOT. Every other knob here
  // has a fallback at or toward the conservative end of its own range —
  // `globalCap` falls back to 0 (feature off), `maxPerOrg` to 1 (its minimum),
  // `drainConcurrency`/`visibilityTimeout`/`leaseTtl` to the shipped middle. This
  // one is the ONLY knob whose fallback is its range MAXIMUM, and its maximum is
  // "the new drain shape is on". So the ordinary rules — reject to the default,
  // clamp toward the bound — both resolve a malformed value to ON, which is the
  // one answer a kill switch must never give: an operator reaching for this
  // variable is trying to turn refill OFF, and `false` / `off` / `no` are what
  // they are most likely to type. Failing safe means going to 0.
  //
  // ABSENT STILL MEANS ON. An older chart or a pre-flag image supplies nothing,
  // and that is not an edit — it must keep today's shipped behaviour.
  //
  // No coherence rule of its own: it changes WHEN a claim happens, not how many
  // messages or slots are in play, so it cannot conflict with any ceiling below.
  const refill = readBounded(env, {
    env: ORG_SLOT_CONTINUOUS_REFILL_ENV,
    min: MIN_ORG_SLOT_CONTINUOUS_REFILL,
    max: MAX_ORG_SLOT_CONTINUOUS_REFILL,
    fallback: DEFAULT_ORG_SLOT_CONTINUOUS_REFILL,
    failSafeValue: MIN_ORG_SLOT_CONTINUOUS_REFILL
  });
  if (refill.issue) issues.push(refill.issue);

  const enabled = cap.value > 0;
  const continuousRefill = refill.value === 1;
  let maxPerOrg = perOrg.value;
  let leaseTtlSeconds = ttl.value;

  if (!enabled) {
    return { enabled, maxPerOrg, globalCap: cap.value, leaseTtlSeconds, continuousRefill };
  }

  // CEILING 1 — the per-org content limiter. `maxPerOrg * n` handlers hit ONE
  // org's 40-concurrent / 40-per-minute pool, and MAX_ORG_SLOT_IN_FLIGHT_PER_ORG
  // is what that pool is budgeted for. NOT MAX_DRAIN_CONCURRENCY: that bounds one
  // isolate's batch (memory, and the n x 120 VT model), which is a different
  // resource that used to share this number. Degrade `maxPerOrg`, never `n`: `n`
  // is already the one value that has been made coherent with the visibility
  // timeout and the isolate lifetime above, and lowering it here would break
  // neither ceiling but would silently undo that resolution for no reason.
  const perOrgCeiling = Math.max(
    MIN_ORG_SLOT_MAX_PER_ORG,
    Math.floor(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG / drainConcurrency)
  );
  if (maxPerOrg > perOrgCeiling) {
    issues.push({
      env: ORG_SLOT_MAX_PER_ORG_ENV,
      raw: String(perOrg.value),
      effective: perOrgCeiling,
      kind: "clamped",
      message:
        `org slot maxPerOrg reduced from ${maxPerOrg} to ${perOrgCeiling}: ${maxPerOrg} leaseholders x ` +
        `${DRAIN_CONCURRENCY_ENV}=${drainConcurrency} would put ${maxPerOrg * drainConcurrency} handlers ` +
        `in flight against ONE org's content limiter, above the ${MAX_ORG_SLOT_IN_FLIGHT_PER_ORG} that ` +
        `limiter is budgeted for (40 concurrent / 40 per minute per org, shared with org invitations and ` +
        `handout syncs). The 40-per-MINUTE reservoir is the binding half: at a create_repo p50 of 23.1s ` +
        `(neu-cs2000, 2026-09-14) ${maxPerOrg * drainConcurrency} in flight start ` +
        `${Math.round((60 * maxPerOrg * drainConcurrency) / 23.1)} creations/min against a 40/min refresh. ` +
        `The per-org rate limit does not move, so extra leaseholders on one org convert into Bottleneck ` +
        `queueing — and what queues behind them is org invitations — not throughput. Raise ` +
        `${ORG_SLOT_GLOBAL_CAP_ENV} to drain more ORGS at once instead.`
    });
    maxPerOrg = perOrgCeiling;
  }

  // CEILING 2 — a per-org allowance above the fleet-wide cap is unreachable, and
  // an unreachable number in a config file is a number someone will later
  // believe. Report it rather than leave the two disagreeing.
  if (maxPerOrg > cap.value) {
    issues.push({
      env: ORG_SLOT_MAX_PER_ORG_ENV,
      raw: String(perOrg.value),
      effective: cap.value,
      kind: "clamped",
      message:
        `org slot maxPerOrg reduced from ${maxPerOrg} to ${cap.value}: ${ORG_SLOT_GLOBAL_CAP_ENV}=` +
        `${cap.value} is the total number of leaseholders that may exist at once, so a per-org allowance ` +
        `above it can never be reached.`
    });
    maxPerOrg = cap.value;
  }

  // CEILING 3 — the TTL is the slot recovery latency for a dead holder, and it
  // must not outlive either the messages that holder was working on or the
  // isolate it was working in. MAX_ORG_SLOT_LEASE_TTL_SECONDS encodes the
  // shipped values (300s VT, 400s lifetime), but both are themselves knobs, so
  // the real check is against the effective ones.
  const ttlCeiling = Math.min(visibilityTimeoutSeconds, isolateLifetimeSeconds);
  if (leaseTtlSeconds > ttlCeiling) {
    // Never below the floor: see MIN_ORG_SLOT_LEASE_TTL_SECONDS. The floor bounds
    // how long the EVENT LOOP may go unyielding between renewals, NOT how long a
    // message takes — renewal is an independent setInterval at TTL/3 and the
    // handlers await, so the real 97.7s worst message (2026-09-14) renews through
    // fine. A TTL below the floor risks a lapse on a stalled loop, after which a
    // second leaseholder enters the org and the two duplicate GitHub work against
    // the very rate limit this feature is about.
    // If the floor and the ceiling cross, the floor wins and the mismatch is
    // reported as an invariant this module cannot fix by clamping.
    const reduced = Math.max(MIN_ORG_SLOT_LEASE_TTL_SECONDS, ttlCeiling);
    const binding =
      ttlCeiling === visibilityTimeoutSeconds
        ? `${VISIBILITY_TIMEOUT_ENV}=${visibilityTimeoutSeconds}s`
        : `${ISOLATE_LIFETIME_ENV}=${isolateLifetimeSeconds}s`;
    issues.push({
      env: ORG_SLOT_LEASE_TTL_ENV,
      raw: String(ttl.value),
      effective: reduced,
      kind: reduced === ttlCeiling ? "clamped" : "invariant",
      message:
        `org slot lease TTL ${leaseTtlSeconds}s is above ${binding}. The TTL is how long a dead ` +
        `leaseholder's org stays blocked, so a TTL above the visibility timeout pins an org's slot while ` +
        `that org's messages are already redeliverable, and a TTL above the isolate lifetime means every ` +
        `naturally-retired leaseholder leaves a slot pinned. Using ${reduced}s` +
        (reduced === ttlCeiling
          ? "."
          : ` — the ${MIN_ORG_SLOT_LEASE_TTL_SECONDS}s floor, which is ABOVE that ceiling: a shorter TTL ` +
            `risks the lease lapsing on an EVENT-LOOP STALL while the leaseholder is still working ` +
            `(not on a long message: renewal is an independent timer at TTL/3 and the handlers await, ` +
            `so the 97.7s worst message renews through). Raise ${VISIBILITY_TIMEOUT_ENV} / ` +
            `edgeFunctions.worker.timeoutMs instead.`)
    });
    leaseTtlSeconds = reduced;
  }

  return { enabled, maxPerOrg, globalCap: cap.value, leaseTtlSeconds, continuousRefill };
}
