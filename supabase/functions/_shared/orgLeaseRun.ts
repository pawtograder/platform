import * as Sentry from "npm:@sentry/deno@10.10.0";
import { workerLeaseScope } from "./workerRun.ts";
import { type EnvReader } from "./SentryContext.ts";

/**
 * Per-org leaseholders for the pgmq-backed `async_calls` drain.
 *
 * ## Why this is a sibling of workerRun.ts and not a mode inside it
 *
 * `beginWorkerRun` is a Redis lease, end to end: it constructs an ioredis/Upstash
 * client, its two safety properties are expressed as Lua compare-and-swap scripts, and its whole
 * `redis: RedisClient | null` seam is meaningless here. This lease lives in POSTGRES, reached
 * through PostgREST like everything else the worker touches, and it differs in shape as well as in
 * substrate:
 *
 *   * THE CLAIM AND THE READ ARE ONE OPERATION. `claim_org_slot_and_read` picks the neediest org
 *     with slot headroom, claims a slot for it, and returns that org's messages in the same
 *     statement. There is no "acquire, then loop, then read" to fit into `beginWorkerRun`'s
 *     lifecycle — a run cannot know which org it is for until its first batch arrives, so the claim
 *     has to be a method on the run rather than a step before it. That is why `claim()` exists here
 *     and has no analogue there.
 *   * THE HOLDER TOKEN IS THE KEY, NOT THE VALUE. The Redis lease has one key per worker and stores
 *     a token in it, so renew and release MUST be compare-and-swap or one isolate stomps another's
 *     lease. Here `(queue_name, holder)` IS the row identity, so `release_org_slot` can only ever
 *     delete our own row in one pool. Several defensive shapes in workerRun.ts (`RELEASE_IF_OWNED`,
 *     "do NOT delete it here: it may already belong to that next holder") are therefore
 *     unnecessary, and we can do something workerRun.ts deliberately cannot: release on the stall
 *     path.
 *   * A LEASE THIS RUN FORGETS DECAYS ON ITS OWN. The slot pools are per queue, and all three RPCs
 *     are scoped to a queue, so renewing the pool we are draining does NOT extend a lease we still
 *     hold in the other pool. That is what makes rotation safe without any bookkeeping: a run that
 *     moves from `async_calls` to `async_calls_low_priority` may briefly hold a slot in each, and
 *     the one it stopped renewing lapses at its TTL — the same bound the design already accepts for
 *     an isolate that dies without releasing. The eager release on rotation below is a LATENCY
 *     optimization on top of that, not the thing that makes it correct.
 *   * THERE IS NO SECOND MODE TO DEGRADE INTO. `beginWorkerRun` falls back to bounded when Redis is
 *     missing or broken. Falling back to an unleased drain here would be wrong — the whole point of
 *     the slot table is that it also enforces the per-org and fleet-wide caps, so a fallback that
 *     ignored it would put unbounded concurrency on the rate limit this feature exists to respect.
 *     A run that cannot claim goes IDLE and returns, and the next cron poke tries again.
 *
 * Merging those into workerRun.ts would mean a module with two backends, two lifecycles and a set
 * of options where roughly half are inert for whichever mode you picked. The interface is kept
 * deliberately close, though — `shouldContinue` / `heartbeat` / `onIdle` / `onError` / `release`
 * with the same meanings — so the caller's loop is the same loop, and so the TTL and stall
 * semantics stay legible next to each other.
 *
 * ## What the safety properties are, and what enforces each one
 *
 *   * TTL EXPIRY IS THE REAL SAFETY NET, exactly as in workerRun.ts. Everything below is
 *     best-effort; the only thing that is guaranteed to free a slot is the server reaping a lease
 *     whose `lease_ttl_seconds` has elapsed. Every failure path is written to be survivable by that
 *     alone, so an isolate that is SIGKILLed, evicted, or retired at `EDGE_WORKER_TIMEOUT_MS` costs
 *     one org up to one TTL of headroom and nothing else.
 *   * A WEDGED HOLDER GIVES UP ITS SLOT. The renewal timer fires whether or not the loop is still
 *     going round — that independence is the point, since a batch legitimately outlives the TTL —
 *     which means renewal on its own is not evidence of progress. `maxStallMs` is: if no loop
 *     method has been called for that long, the run stops renewing, releases, and ends. Same defect
 *     and same fix as workerRun.ts, where a holder parked on a promise that never settled kept a
 *     lease renewed through 425 refused pokes.
 *   * ERRORS DEGRADE TO IDLE, NEVER TO A HALT AND NEVER TO AN UNLEASED DRAIN. An RPC failure ends
 *     the run after `maxConsecutiveClaimErrors` consecutive attempts, which returns the isolate and
 *     its admission slot; the cron poke brings a fresh one. This matters more than usual here
 *     because the SQL side ships separately: if this code reaches a database whose
 *     `claim_org_slot_and_read` does not exist yet, PostgREST answers `PGRST202` forever, and a
 *     worker that retried that forever would hold an admission slot doing nothing for the length of
 *     the deploy skew. Two classes of claim failure are therefore fatal on the FIRST attempt rather
 *     than after three: a missing function (`PGRST202`), and the server refusing the call outright
 *     (`P0001`, which covers an unseeded slot pool for the requested queue). Neither can come right
 *     on a retry, and the unseeded-pool one in particular must stay loud — that failure used to
 *     present as zero rows forever with every liveness signal green.
 *
 * ## Why an idle run does not stay resident
 *
 * `beginWorkerRun`'s leased mode sleeps and keeps looping when the queue is empty, because there is
 * exactly ONE holder and its residency is what gives sub-minute latency. That reasoning does not
 * carry over. `invoke_github_async_worker_background_task` spawns exactly 2 isolates a minute, and
 * every one of them tries to claim; if the ones that find nothing stayed resident they would
 * accumulate at 2/minute against `maxParallelism: 8` until the runtime retired them — the precise
 * admission-slot exhaustion workerRun.ts was written to stop, arriving from the other direction.
 *
 * So residency is earned by WORK, not by holding a lease: a run that is draining keeps looping
 * (bounded only by the stall guard and the isolate lifetime), and a run that finds nothing gets a
 * short wall-clock idle budget and then returns. The cost is idle latency, bounded by the cron
 * period, and it is the same trade workerRun.ts's bounded mode makes for the same reason.
 *
 * "FINDS NOTHING" SPLITS IN TWO, and they get different answers:
 *
 *   * `no_demand` — the queue is genuinely empty. Idle on the budget, because nobody else is
 *     working this queue either and a resident isolate is the lowest-latency way to pick up whatever
 *     arrives next. Waiting is useful.
 *   * `no_capacity` — the queue has work and every slot is taken. RETURN IMMEDIATELY. The fleet is
 *     at its configured concurrency by definition, so this isolate cannot add throughput, only
 *     occupancy; and the event it would be waiting for is a whole batch completing, which outlasts
 *     the idle budget anyway. Waiting is not useful, it is just a held admission slot.
 *
 * ## Why a BUSY run does not stay resident either (2026-09-15)
 *
 * The section above bounds an IDLE run and says nothing about a working one, and for a year that
 * gap was the design: residency is earned by work, so a run that keeps finding work keeps going.
 * `shouldContinue()` is `!finished`, and `finished` is set only by a lost slot, a spent idle
 * budget, the stall guard, or a dead RPC — none of which a healthy busy run ever reaches. So it
 * drained until the RUNTIME ended it, and that is not an ending this module gets to design:
 * EdgeRuntime kills the isolate at `EDGE_WORKER_TIMEOUT_MS` mid-batch, mid-archive, mid-anything.
 *
 * THAT COST WAS MEASURED ON 2026-09-15 AND IT IS NOT SMALL. 664 "wall clock duration reached"
 * kills in 75 minutes across 27 pods; every message the killed isolate had read and not archived
 * stayed invisible for the rest of its visibility timeout, which in production EQUALS the isolate
 * lifetime (480s both). In `pgmq.a_async_calls` that reads as groups sharing one `enqueued_at`
 * second with `read_ct = 2` and `archived_at - enqueued_at` at 482-507s for work that took 1-13s.
 * `sync_repo_permissions` redelivery reached 35.4%, whole-queue 14.5%, and
 * PawtograderQueueOldestMessageAging fired on a queue whose depth never exceeded 27.
 *
 * SO A BUSY RUN NOW HAS A WALL-CLOCK BUDGET TOO, and the three decisions in it are the whole
 * design:
 *
 *   * IT GATES THE CLAIM, NOT THE WORK. Past the deadline `claim()` stops claiming and ends the
 *     run; the messages already in flight run to completion, the lease keeps being renewed while
 *     they do, and the slot is not handed back until they finish. Every one of those behaviours
 *     already existed for `no_capacity` — this is a fourth way to reach the same state, not a new
 *     state. Cutting the in-flight work off at the deadline would BE the strand, self-inflicted.
 *   * IT IS ANCHORED TO THE ISOLATE, NOT TO THE RUN, and that is the difference between a fix and
 *     a fix-shaped no-op. `github-async-worker/index.ts` resets its `started` guard in a
 *     `.finally()` when `runBatchHandler` exits, so ONE ISOLATE HOSTS A SEQUENCE OF RUNS: the cron
 *     is `* * * * *` and pokes twice per tick, while an idle run returns after a 50s idle budget,
 *     so an isolate spends its 480s life taking poke after poke. That is the steady state, not an
 *     edge case, and it is what makes the anchor load-bearing rather than merely tidy.
 *
 *     THE DANGEROUS RUN IS A YOUNG RUN THAT STARTS LATE IN THE ISOLATE'S LIFE. A run-scoped
 *     deadline hands it a fresh full allowance, it claims happily, and the runtime kills the
 *     isolate minutes before that allowance runs out — i.e. exactly today's defect, now with a
 *     budget in front of it. A run-scoped budget also PASSES every plausible injected-clock unit
 *     test, which is why the budget is MODULE STATE that each run inherits and draws down, and why
 *     the test that matters is the one that builds two runs against one module instance without
 *     injecting the anchor at all.
 *   * IT ENDS THE RUN RATHER THAN SLEEPING. Same argument as `no_capacity`: re-entry is
 *     rate-limited by pg_cron, so a fresh isolate with a fresh budget arrives within ~30s and
 *     nothing here has to loop. The cost is that tail-end idleness — see the sizing note on
 *     ORG_SLOT_RUN_BUDGET_ENV in asyncWorkerTuning.ts, which is where the number lives and where
 *     the honest limits of it are written down.
 *
 * Once `globalCap` is reached this is the STEADY STATE, not an edge case — the cron spawns 2
 * isolates a minute regardless, so several will hit `no_capacity` every minute for the length of a
 * release. That is precisely why it must not sleep-and-retry: re-entry has to stay rate-limited by
 * the cron rather than by a loop in here.
 *
 * ## Why claiming is CONTINUOUS rather than batch-at-a-time
 *
 * A claim used to be a batch: read `n`, run all `n` under `Promise.allSettled`, claim again only
 * once every one of them had settled. That costs the difference between the mean message and the
 * SLOWEST message in each group of `n`, and on 2026-09-14 that difference was measured rather than
 * guessed. A 190-repo burst for one org drained in 29.5 minutes at an effective concurrency of 5.20
 * against 8 configured, and the loss factorizes exactly:
 *
 *     configured (orgSlotMaxPerOrg 2 x drainConcurrency 4)   8.00
 *   x leaseholder residency (~1.8 of 2 slots resident)       7.20
 *   x within-batch utilization                               5.26   <- measured 5.20
 *
 * Reconstructed from `pgmq.a_async_calls` (`vt - 480s` is the read time, `archived_at` the finish):
 * 47 batches of exactly 4, mean message duration 48.4s, mean batch duration 68.4s, so 48.4/68.4 =
 * 0.71 within a batch; across the burst, roughly 27% of every slot-second was a claimed slot waiting
 * on its batch-mates. Sampling in-flight count every 30s showed the sawtooth this predicts: 8, then
 * 1-2, then 8 again.
 *
 * `drainWithContinuousRefill` below keeps `n` messages in flight instead: as each message settles,
 * the SHORTFALL is claimed rather than the whole batch re-read. The sawtooth flattens, and the
 * within-batch term goes to ~1.
 *
 * FOUR THINGS THAT CHANGE BECAUSE A CLAIM CAN NOW LAND WHILE WORK IS IN FLIGHT, all of them here
 * rather than in the driver, because they are statements about the LEASE:
 *
 *   1. A RUN MUST NOT GIVE BACK A SLOT IT IS STILL USING. `no_demand` and `no_capacity` both
 *      released the slot, which was correct when they could only be reached between batches — there
 *      was nothing running. With refill they are reached with up to `n-1` messages still going, and
 *      releasing there would tell the slot table this org has zero concurrency while this isolate
 *      runs `n-1` handlers against it, letting a second leaseholder in on top. So every release
 *      inside `claim()` is now conditional on `inFlightCount() === 0`; the driver drains before the
 *      caller's `release()`, which is what actually returns the slot.
 *   2. THE LEASE IS KEPT ALIVE WHILE DRAINING, EVEN AFTER THE RUN IS OVER. `finished` used to stop
 *      renewal, and could only be set with nothing in flight. Now `no_capacity` (or a fatal claim
 *      error) can finish a run that still has messages running for up to one worst-case message
 *      (94.8s measured) against a 60s default TTL — the lease would lapse mid-drain and the org
 *      would be handed to someone else while we are still working it.
 *   3. THE IDLE BUDGET DOES NOT START WHILE WORK IS IN FLIGHT. A leaseholder that is draining is not
 *      idle; starting the budget on the first `no_demand` of a busy stream would make the run exit
 *      the moment that stream ended, instead of waiting out the budget for the next arrival.
 *   4. A TOP-UP MAY ONLY EXTEND WHAT THE RUN IS ALREADY DOING — same org, same queue, or no claim
 *      at all. Both halves of that are load-bearing and both are about the same count. The
 *      allocator re-points THIS HOLDER'S slot row at whichever org it picks, so an unpinned top-up
 *      hands our row to the neediest org while `n-1` messages are still running for the org we just
 *      left, and those stop being counted: that org reaches `max_per_org x n + (n-1)`, which at
 *      `maxPerOrg` 2 and `n` 4 is 11 against a budgeted 8. Landing on a different QUEUE loses the
 *      same count a level up, by releasing the pool the in-flight messages were claimed under. So a
 *      top-up carries `pin_org` and probes only the held queue; a claim issued with nothing in
 *      flight is unpinned and probes everything in priority order, because that is the moment when
 *      rotating is free. Preemption is bought back by streaming ONLY the highest-priority queue;
 *      see `claim()`.
 *
 * ## Why a pinned stream has a QUANTUM (2026-09-15)
 *
 * Point 4 closed a cap breach and opened a fairness hole. It makes that argument for QUEUES, calls
 * the loss of upward preemption "a regression against batch-at-a-time, which re-probed at every
 * boundary", and buys it back by streaming only the highest-priority queue. The identical property
 * for ORGS is neither mentioned there nor bought back anywhere.
 *
 * WHAT IT COSTS. An unpinned claim is the only moment the allocator may move this holder's row onto
 * a different org, and `claim()` issues one only with nothing in flight. A deep stream under refill
 * never has nothing in flight; that is what refill IS. So a holder that took its slot while one org
 * was backed up keeps that org until the backlog runs dry, `runBudgetMs` is spent, or the runtime
 * retires the isolate, while every fresh cron invocation is answered `no_capacity`. A new holder is
 * counted against `global_cap`; an existing one re-pointing its own row is not, because `a_others`
 * and the cap test both exclude the caller. At the recommended `globalCap` 8 and `maxPerOrg` 2, four
 * releasing orgs take the whole fleet and a fifth class gets zero throughput. Batch-at-a-time did
 * not have this defect: every batch boundary issued an unpinned claim, `order by a_others asc`
 * prefers the org holding fewest OTHER holders' slots, and that moved a holder off a saturated org
 * onto a starved one inside one boundary, 68.4s on the measured burst.
 *
 * SO A STREAM KEEPS ITS PIN FOR A BOUNDED NUMBER OF MESSAGES AND THEN HAS TO WIN IT AGAIN. Past the
 * quantum a top-up is SKIPPED rather than unpinned: the in-flight set drains to empty, and the claim
 * that follows is unpinned by the rule that was already there. Reaching the reconsideration by
 * WAITING rather than by relaxing the pin is the whole of it, and it is what makes the answer to
 * "without violating the in-flight accounting" a proof rather than a bound. The hazard point 4
 * describes is specifically an unpinned claim issued with this org's messages still running, and
 * after a drain-out there are none. The reachable per-org concurrency stays `max_per_org x n` at
 * every quantum, including a quantum of one, because no quantum can cause an unpinned claim while
 * anything is in flight. This is `quiesced_for_priority` on a counter instead of on a queue name,
 * and it is strictly the cheaper of the two: that path pays a drain-out per BATCH.
 *
 * WHY THE QUANTUM IS COUNTED IN MESSAGES AND NOT IN SECONDS. A drain-out costs exactly one tail. The
 * set stops being topped up, so the leaseholder idles from the first completion to the last, which
 * is `E[max of n] - E[X]` per slot and is a MESSAGE-shaped quantity: 68.4 - 48.4 = 20.0s on the
 * create_repo burst, and near a second for `sync_repo_permissions` (p50 1.4s) and
 * `sync_student_team` (p50 1.0s), which are ~78% of real traffic. One wall-clock number would
 * therefore cost two orders of magnitude more on one of those workloads than on the other, which is
 * not a quantity anyone can size. Counting messages holds the FRACTION steady instead, at about
 * `(E[max of n] - E[X]) / (k x E[X])` for a quantum of `k` refills, and lets the wall-clock cadence
 * fall out of the workload: ~11s between reconsiderations on the fast mix, ~244s on the create_repo
 * burst (measured, k=8). The slow end is the honest limit of this change and is stated rather than
 * papered over. On a burst of 48s messages the quantum barely improves on `runBudgetMs`, which
 * already ends the run at 330s and frees the slot for the next poke's unpinned claim, and buying
 * more there means paying the 20s tail more often.
 *
 * WHY EIGHT REFILLS. The fraction above predicts 0.41/8.41 = 4.9% at `k` 8, and the simulation
 * measures 5.4 points of leaseholder utilization on the 190-message fixture: 99.1% to 93.7% with the
 * backoff disabled, which is the cost a CONTENDED stream actually pays. Refill recovered about 27
 * points, so the quantum spends a fifth of that win on the fairness property batch-at-a-time had.
 * Halving it doubles the bill (k=4 measures 90.1%) to beat a cadence `runBudgetMs` mostly caps
 * anyway; doubling it (k=16 measures 96.5%) pushes the create_repo cadence past `runBudgetMs`, where
 * the quantum stops being reachable within a run at all. The number is a COST BUDGET rather than a
 * latency target, and STREAM_QUANTUM_BACKOFF_CAP is what stops it being paid where it buys nothing.
 *
 * AND THE RECONSIDERATION IS NOT FREE ON THE ALLOCATOR EITHER, which is the other reason it is
 * rationed. The allocator rewrite made a PINNED claim flat in queue depth (22.80ms to 1.78ms at
 * depth 5000) and left an UNPINNED one scanning the whole backlog with a per-row class lookup:
 * 8.01ms to 10.07ms on a six-org storm, and storm throughput 143-147 down to 114-120 claim calls per
 * second. Every claim takes the one global `pg_advisory_xact_lock`, so this is a shared cost, not a
 * private one. At `k` 8 a streaming holder issues one unpinned claim per ~32 pinned ones, so ~3% of
 * its claim traffic moves onto the expensive path. The drain-out is the expensive half of a
 * reconsideration by a wide margin; the RPC is rounding.
 *
 * WHAT IT DOES NOT DO. It bounds ONE holder's pin. Whether the fleet is fair also depends on what
 * the allocator picks when the quantum hands it the choice, and that is the migration's business:
 * `a_others asc` serves a starved org first, but once that key ties the winner is alphabetical, so a
 * reconsideration can legitimately re-pick the org it just left while another org waits. The backoff
 * treats that answer as evidence and the cap keeps the resulting stretch bounded.
 *
 * What does NOT change: the status contract (`claimed` rows, or exactly one `no_demand` /
 * `no_capacity` row), advancing to the fallback queue only on `no_demand`, `no_capacity` ending the
 * run, the generation counter guarding stale renewals, `touchedQueues` release-on-exit, the stall
 * guard, and the `P0001` / `PGRST202` fatal paths. Refill changes WHEN you claim, not who holds the
 * lease.
 */

/**
 * One row of `claim_org_slot_and_read`: a pgmq message plus the org whose slot was claimed.
 *
 * `org` is not always a real GitHub org. The SQL buckets messages whose `class_id` does not resolve
 * to a `classes.github_org` under the literal `(unresolved)` so they still drain rather than
 * becoming unclaimable, and that sentinel arrives here like any other org — it gets a slot, it
 * competes for `global_cap`, and it lands on the `github_org` Sentry tag. Treat this field as a
 * partition key, not as a name you can hand to the GitHub API.
 */
export type OrgQueueMessage<T = unknown> = {
  org: string;
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: T;
};

/**
 * A raw row from `claim_org_slot_and_read`, which no longer returns only messages.
 *
 * ZERO ROWS USED TO MEAN TWO DIFFERENT THINGS and the worker could not tell them apart: "this queue
 * has no ready work" and "this queue has ready work but every slot is taken". Those want opposite
 * responses — the first should move on to the fallback queue, the second must NOT, because the main
 * queue is backed up and the fleet is already draining it at full configured concurrency. Treating
 * the second as the first sent isolates off to do repo-analytics work with GitHub capacity the
 * urgent queue needed.
 *
 * So a claim never comes back genuinely empty now. Either every row is a message with
 * `status = 'claimed'`, or there is exactly ONE row carrying `no_demand` / `no_capacity` and NULLs
 * everywhere else.
 */
export type OrgSlotRow<T = unknown> = {
  status: string | null;
  org: string | null;
  msg_id: number | null;
  read_ct: number | null;
  enqueued_at: string | null;
  vt: string | null;
  message: T | null;
};

/** What one `claim_org_slot_and_read` call against one queue turned out to be. */
export type OrgClaimStatus = "claimed" | "no_demand" | "no_capacity";

/** A claimed slot and the batch that came with it. */
export type OrgClaim<T = unknown> = {
  /** The org this leaseholder now holds a slot for. */
  org: string;
  /** Which queue the batch came from, for archiving and for Sentry. */
  queueName: string;
  messages: OrgQueueMessage<T>[];
};

/** Shape of a PostgREST response, narrowed to what this module reads. */
export type RpcResult<T> = {
  data: T | null;
  error: { message?: string; code?: string } | null;
};

/**
 * The three pinned RPCs, as an injectable interface.
 *
 * Injected rather than taking a SupabaseClient so this module stays free of the generated `Database`
 * type and is testable under `deno test` with no network and no client — the same reason
 * asyncWorkerTuning.ts takes an `EnvReader` instead of touching `Deno.env`.
 */
export interface OrgSlotRpc {
  claim(args: {
    queue_name: string;
    sleep_seconds: number;
    n: number;
    holder: string;
    lease_ttl_seconds: number;
    max_per_org: number;
    global_cap: number;
    /**
     * Restrict the claim to ONE org instead of letting the allocator pick the neediest.
     *
     * Omitted entirely — not sent as null — when the run is free to rotate, and that distinction is
     * load-bearing rather than stylistic. PostgREST resolves an RPC by the SET OF ARGUMENT NAMES in
     * the body, so sending `pin_org` to a database whose `claim_org_slot_and_read` predates the
     * parameter answers `PGRST202`. Sending it on every claim would therefore make the whole
     * org-leased path fail closed during any window where the image is ahead of the migration;
     * sending it only on a top-up means the unpinned claims that start a run keep working, and
     * `claimOnce` degrades the top-ups to batch-at-a-time. `pin_org` has a server-side DEFAULT, so
     * the other skew direction (new database, old image) needs nothing.
     *
     * Case does not matter: the allocator's org expression is already `lower(...)` and the server
     * normalizes this the same way, so any `org` a previous claim returned can be passed back
     * verbatim — including the `(unresolved)` and `(unknown-method)` sentinels.
     */
    pin_org?: string;
  }): Promise<RpcResult<OrgSlotRow[]>>;
  // `queue_name` leads on all three, matching claim_org_slot_and_read. Renewal and release are
  // scoped to ONE pool: renewing the queue we are draining must not extend a lease the same holder
  // still has in another queue's pool, or an abandoned slot would be resurrected on every heartbeat
  // instead of lapsing.
  renew(args: { queue_name: string; holder: string; lease_ttl_seconds: number }): Promise<RpcResult<boolean>>;
  release(args: { queue_name: string; holder: string }): Promise<RpcResult<unknown>>;
}

export interface OrgLeaseRun {
  readonly mode: "org_leased";
  /** Stable identity of this leaseholder, as passed to every RPC. Logged, so make it readable. */
  readonly holder: string;
  /**
   * This leaseholder's `n`, exposed so a driver can check its own in-flight target against the
   * number the allocator is budgeting for rather than trusting the two call sites to agree.
   */
  readonly drainConcurrency: number;
  /**
   * Whether this run was given an `inFlightCount`, i.e. whether it can actually see what the driver
   * is running. False means every behavior keyed on "work in flight" is inert, which is correct
   * for the batch driver and unsafe for the refill one — see `drainWithContinuousRefill`.
   */
  readonly tracksInFlight: boolean;
  /** The org whose slot is currently held, or null when this run holds none. */
  heldOrg(): string | null;
  /** Which queue's pool the held slot is in, or null when this run holds none. */
  heldQueue(): string | null;
  /**
   * False once the slot is lost, either wall-clock budget is spent, or the run gave up on the RPC.
   *
   * "Stop" here means STOP CLAIMING. It never means abandon work: the driver's `finally` waits for
   * everything in flight, and the lease goes on being renewed until it has.
   */
  shouldContinue(): boolean;
  /**
   * Claim a slot and read that org's messages.
   *
   * `null` means nothing was claimed, and the reasons are NOT equivalent — check `shouldContinue()`
   * afterwards. `no_demand` on every queue leaves the run alive and idling; `no_capacity` ENDS it,
   * because the fleet is already at its configured concurrency and this isolate cannot add
   * throughput, only occupancy; and a spent `runBudgetMs` ends it WITHOUT calling the RPC at all,
   * because this isolate is close enough to its wall-clock death that anything it read now would
   * likely be killed unarchived. Throws when the RPC itself failed.
   *
   * `maxMessages` is how continuous refill asks for the SHORTFALL rather than a whole batch. It is
   * clamped into `[1, drainConcurrency]`: `drainConcurrency` is still this leaseholder's ceiling and
   * nothing may claim past it, and 0 would be a round trip that can only ever come back `no_demand`.
   * Omit it to claim a full batch, which is what every non-refill caller wants.
   *
   * A `null` return no longer implies an RPC was made. When this run has messages in flight and
   * topping up would not be safe — the stream is on a lower-priority queue, or the database has no
   * `pin_org` — the claim is SKIPPED and `lastOutcome()` keeps reporting the last real answer. The
   * caller's handling is the same either way: nothing was claimed, and with work in flight the thing
   * to wait for is a completion.
   */
  claim(maxMessages?: number): Promise<OrgClaim | null>;
  /** The status of the last claim attempt, for observability. */
  lastOutcome(): OrgClaimStatus | null;
  /** Call once per loop iteration. Renews when due; ends the run if the slot is gone. */
  heartbeat(): Promise<void>;
  /** Called when a claim found no work. Returns whether to keep looping. */
  onIdle(): Promise<boolean>;
  /** Called after an iteration threw, to back off. */
  onError(): Promise<void>;
  /** Best-effort slot release. TTL expiry is the real safety net. */
  release(): Promise<void>;
}

export interface BeginOrgLeaseRunOptions {
  /** Stable worker identity; becomes part of the holder string. */
  name: string;
  rpc: OrgSlotRpc;
  /** Queues to try in priority order, e.g. `["async_calls", "async_calls_low_priority"]`. */
  queueNames: readonly string[];
  /** pgmq `n` — this ONE leaseholder's concurrency ceiling. */
  drainConcurrency: number;
  /** pgmq `sleep_seconds` (visibility timeout). */
  visibilityTimeoutSeconds: number;
  maxPerOrg: number;
  globalCap: number;
  /** How long to sleep when a claim found no work. */
  idleSleepMs: number;
  /** How long to sleep after an iteration threw. */
  errorSleepMs: number;
  leaseTtlMs?: number;
  /** How long the loop may go silent before the holder gives its slot up. */
  maxStallMs?: number;
  /** Wall-clock budget for idling without a slot before the run returns. */
  idleBudgetMs?: number;
  /**
   * Wall-clock budget for CLAIMING, measured from ISOLATE START — not from the start of this run.
   *
   * Past it `claim()` claims nothing more and ends the run, the messages already in flight run to
   * completion, and the caller's `release()` gives the slot back afterwards. `tuning.orgSlots
   * .runBudgetSeconds * 1000` is the value the worker passes; asyncWorkerTuning.ts owns the number
   * and the argument for it.
   *
   * OMITTED LEAVES A RUN UNBOUNDED, which is today's behaviour, and so does a value that is not a
   * finite number above zero. That is the opposite of the fail-safe direction the TUNING layer
   * uses for the same quantity, and the two are guarding different mistakes. There, the input is an
   * operator who edited an env var, the only reason to edit it is to stop earlier, and a value that
   * cannot be honoured resolves DOWN. Here, the input is a caller's arithmetic, and a zero or a NaN
   * arriving from a bad calculation would mean an isolate that is past its deadline before it has
   * claimed anything — a queue that stops draining while the lease, the heartbeats and the error
   * count all stay green, which this module treats as the worst outcome available (see
   * MIN_DRAIN_CONCURRENCY). Unbounded is a known, survivable failure; never claiming is not.
   */
  runBudgetMs?: number;
  /**
   * When this isolate started, in the same clock as `now`. TEST SEAM ONLY — production leaves it
   * out and gets the module-level capture, which is the whole point of the budget.
   *
   * REQUIRED WHENEVER `now` IS INJECTED AND A BUDGET IS ARMED, and `beginOrgLeaseRun` throws if it
   * is missing, because the alternative is a test that proves nothing. The module capture is in
   * `Date.now()`'s epoch and an injected clock usually starts at 0, so mixing them puts the
   * deadline ~1.7e12 ms in a fake future: the budget silently never fires, and a test written to
   * exercise it passes for the reason it was supposed to rule out.
   */
  isolateStartedAt?: number;
  /** Consecutive claim-RPC failures tolerated before the run ends. */
  maxConsecutiveClaimErrors?: number;
  /**
   * How many messages this run has claimed and not yet finished.
   *
   * THE LEASE HAS TO KNOW THIS, and nothing else does: the driver owns the in-flight set, but the
   * decisions it changes — whether a slot may be given back, whether the lease must keep being
   * renewed past the end of the run, whether the idle budget has started, which queues may be
   * probed — are all decisions about the LEASE. Defaults to `() => 0`, which is exactly the
   * batch-at-a-time world: a claim could only ever land between batches, so nothing was ever in
   * flight when one of those decisions was taken.
   */
  inFlightCount?: () => number;
  /**
   * How many times a pinned stream may refill its in-flight set before it has to let that set drain
   * and claim UNPINNED again. The quantum in messages is this times `drainConcurrency`.
   *
   * See "Why a pinned stream has a quantum" in the header for the number and for the measurement it
   * comes from. Exposed as an option so the tests can drive the quantum from both sides; there is no
   * env var behind it yet, and asyncWorkerTuning.ts is where one would go.
   *
   * AN UNUSABLE VALUE LEAVES THE STREAM UNBOUNDED, matching `runBudgetMs` rather than the tuning
   * layer's fail-down. Both directions here are survivable but they are not equally survivable: an
   * unbounded stream is the behaviour that shipped, and it costs a waiting org some latency, whereas
   * a quantum that resolved to "quiesce constantly" would drain the in-flight set on every top-up
   * and hand back the whole 27% continuous refill was written to recover, on every leaseholder, with
   * nothing in the logs to say why throughput halved.
   */
  streamQuantumRefills?: number;
  scope?: Sentry.Scope;
  /** Reads deployment identity for the holder string. Injectable so tests need no process env. */
  readEnv?: EnvReader;
  /** Test seams, matching workerRun.ts. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setIntervalFn?: (cb: () => void, ms: number) => number;
  clearIntervalFn?: (handle: number) => void;
}

/** Matches `DEFAULT_LEASE_TTL_MS` in workerRun.ts so the two lease lifetimes do not drift. */
const DEFAULT_LEASE_TTL_MS = 60_000;
/** Renew at a third of the TTL, so two consecutive renewal failures still leave time to recover. */
const HEARTBEAT_DIVISOR = 3;
/**
 * Matches `DEFAULT_MAX_STALL_MS` in workerRun.ts. Generous on purpose: a batch of `n` create_repos
 * against a large org legitimately runs for minutes (the 2026-09-07 worst case was ~280s for ONE
 * message), and this value is the ceiling on how long a wedged holder can keep an org to itself,
 * not a latency target.
 */
const DEFAULT_MAX_STALL_MS = 15 * 60_000;
/**
 * Matches `DEFAULT_BOUNDED_BUDGET_MS` in workerRun.ts, and sized the same way: well inside the
 * ~200s at which `beforeUnload.wallClockRatio: 50` retires the isolate, so an idle run ends on its
 * own terms. At the shipped 15s idle sleep that is 3-4 polls, and the cron replaces the isolate
 * within 30s, so the idle-latency cost of returning rather than staying resident is bounded by the
 * cron period.
 */
const DEFAULT_IDLE_BUDGET_MS = 50_000;
/**
 * Three consecutive claim failures ends the run.
 *
 * Low on purpose. Unlike a handler error, a failing claim means this isolate cannot do ANY work, so
 * retrying in place only holds an admission slot; ending the run costs one cron period and hands
 * the retry to a fresh isolate that will also re-resolve its environment. Three rather than one so
 * a single PostgREST blip does not churn the isolate.
 */
const DEFAULT_MAX_CONSECUTIVE_CLAIM_ERRORS = 3;
/**
 * A pinned stream may refill its in-flight set eight times before it has to drain out and claim
 * unpinned again, so the quantum is `8 x drainConcurrency` messages: 32 at the shipped `n` of 4.
 *
 * The derivation, the measurements and the honest limits are in "Why a pinned stream has a quantum"
 * in the header. In one line: a drain-out costs one tail, `(E[max of n] - E[X]) / (k x E[X])` is the
 * fraction of a leaseholder that buys, k=8 measures 5.4 points against refill's ~27, and that is the
 * most of refill's win this is willing to spend on the fairness batch-at-a-time had for free.
 */
export const DEFAULT_STREAM_QUANTUM_REFILLS = 8;
/**
 * How far the quantum may stretch when reconsidering keeps finding nobody else to serve.
 *
 * A quiesce that rotates the holder onto a waiting org bought exactly what it cost. A quiesce whose
 * unpinned claim comes back with the ORG WE WERE ALREADY ON bought nothing: no other org qualified,
 * so the drain-out was pure loss. That case is not hypothetical, it is the 190-message single-org
 * burst this module is calibrated on, where the quantum costs 5.4 points of utilization (99.1% to
 * 93.7%, measured) for zero fairness because there is nothing to be fair to. So the quantum doubles
 * after a reconsideration that changed nothing and snaps back to its base the moment one rotates.
 *
 * FOUR, WHICH IS A BOUND AND NOT A GROWTH POLICY. The allocator's tiebreak is alphabetical once
 * `a_others` ties, so a reconsideration CAN re-pick our org while another org waits (see the
 * `order by` in the pin_org migration), and an unbounded backoff would let that one unlucky answer
 * stretch the stream indefinitely. At the cap the stream is bounded by 32 refills, and on the slow
 * mix that is already longer than `runBudgetMs`, so the run ends and releases before it matters.
 */
export const STREAM_QUANTUM_BACKOFF_CAP = 4;
/**
 * PostgREST's "no such function" code. This is the deploy-skew signature: the worker image can
 * reach a database whose migration has not been applied yet, and no amount of retrying fixes that,
 * so it ends the run immediately instead of spending `maxConsecutiveClaimErrors` isolates on it.
 * Recognizing it is an optimization, not a correctness requirement — if the code ever changes, the
 * consecutive-error cap still bounds the damage.
 */
const PGRST_UNDEFINED_FUNCTION = "PGRST202";
/**
 * SQLSTATE for a plpgsql `raise exception`. `claim_org_slot_and_read` uses it for an unseeded slot
 * pool on the requested queue and for arguments it refuses — all of them permanent. See the handling
 * in `claimOnce` for why matching the SQLSTATE beats matching the message text.
 */
const PG_RAISE_EXCEPTION = "P0001";

/**
 * WHEN THIS ISOLATE STARTED, captured once when the module is evaluated.
 *
 * Module state, deliberately, and it is the single most important line of the wall-clock budget.
 * The runtime kills on the ISOLATE's wall clock, and one isolate hosts a sequence of runs (see the
 * header), so a deadline anchored anywhere else is a deadline for a quantity nothing measures. Each
 * run inherits this same instant and therefore draws down the SAME budget: the fifth run of an
 * isolate gets whatever the first four left it, which is the behaviour the runtime imposes whether
 * or not this file models it.
 *
 * MODULE EVALUATION IS SLIGHTLY AFTER THE TRUE START — the runtime has already loaded the eszip and
 * evaluated this module's imports — so this anchor is a little LATE and the budget it produces is a
 * little LONG. That is the one direction that needs covering rather than ignoring, and
 * ORG_SLOT_RUN_BUDGET_MARGIN_SECONDS in asyncWorkerTuning.ts is what covers it.
 *
 * Not `performance.now()`: that is relative to its own origin and would need the same anchor
 * anyway, and `Date.now()` is the clock every other deadline in this module and in workerRun.ts
 * already uses.
 */
const ISOLATE_STARTED_AT = Date.now();

/**
 * The isolate anchor, exported so a caller can log how much of the isolate's life is gone — and so
 * a test can build two runs against ONE module instance and prove that the second inherits what the
 * first spent. A run-scoped deadline passes every test that injects a clock; it fails this one.
 */
export function isolateStartedAtMs(): number {
  return ISOLATE_STARTED_AT;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Thrown by `claim()` so the caller's existing catch/`onError` path handles an RPC failure. */
export class OrgClaimError extends Error {
  constructor(
    message: string,
    readonly queueName: string
  ) {
    super(message);
    this.name = "OrgClaimError";
  }
}

/**
 * Build a per-org leaseholder run.
 *
 * Synchronous, unlike `beginWorkerRun`, because there is genuinely nothing to do here: the claim is
 * fused with the first read, so this function performs no I/O. Making it `async` for symmetry would
 * imply a begin-time acquire that does not exist.
 *
 * It throws in exactly one case, and that case is a test harness rather than a deployment: an armed
 * `runBudgetMs` with an injected `now` and no `isolateStartedAt`. See that option — the two clocks
 * would not share an epoch, the budget would silently never fire, and the test would pass for the
 * one reason it exists to rule out. Same argument as `drainWithContinuousRefill`'s refusal to run
 * against a lease that cannot see the in-flight set: refuse the wiring mistake the types cannot.
 */
export function beginOrgLeaseRun(opts: BeginOrgLeaseRunOptions): OrgLeaseRun {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const ttlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
  const maxStall = opts.maxStallMs ?? DEFAULT_MAX_STALL_MS;
  const idleBudget = opts.idleBudgetMs ?? DEFAULT_IDLE_BUDGET_MS;
  const maxClaimErrors = opts.maxConsecutiveClaimErrors ?? DEFAULT_MAX_CONSECUTIVE_CLAIM_ERRORS;
  const inFlightCount = opts.inFlightCount ?? (() => 0);

  // THE WALL-CLOCK CLAIM DEADLINE, as an ABSOLUTE instant rather than a duration, which is what
  // makes it inherited rather than refreshed: every run built in this isolate from the same budget
  // resolves to the same instant, so the second run gets the remainder the first left and the fifth
  // may well get none. A duration held per run would silently reset on every poke.
  //
  // An unusable number leaves the run UNBOUNDED rather than instantly over — see `runBudgetMs`.
  const budgetMs = opts.runBudgetMs;
  const budgetArmed = typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0;
  if (budgetArmed && opts.now !== undefined && opts.isolateStartedAt === undefined) {
    throw new Error(
      "beginOrgLeaseRun: `runBudgetMs` is armed and `now` is injected, but `isolateStartedAt` is " +
        "not. The module-level isolate anchor is in Date.now()'s epoch, so a deadline built from " +
        "it and compared against an injected clock can never be reached: the budget would be inert " +
        "and any test of it would pass vacuously. Pass `isolateStartedAt` in the same clock as " +
        "`now` — or, to prove the budget is module state rather than run state, inject neither."
    );
  }
  const claimDeadline = budgetArmed ? (opts.isolateStartedAt ?? ISOLATE_STARTED_AT) + budgetMs : null;

  // THE STREAM QUANTUM, IN MESSAGES, or null for "this stream is unbounded". Expressed as a
  // multiple of `drainConcurrency` rather than as a message count of its own, because what the
  // number has to hold steady is the FRACTION of a leaseholder's time the quiesce costs, and that
  // fraction is one drain-out per quantum against `drainConcurrency` messages per refill. A flat
  // count would mean a different cost at every `n`. See the header for how the multiple was chosen.
  const quantumRefills = opts.streamQuantumRefills ?? DEFAULT_STREAM_QUANTUM_REFILLS;
  const streamQuantum =
    Number.isFinite(quantumRefills) && quantumRefills >= 1
      ? Math.max(1, Math.floor(quantumRefills * opts.drainConcurrency))
      : null;

  // The uuid is what makes this unique, and uniqueness is the only property the SQL needs: the
  // holder string is the row identity, so two isolates must never share one. The scope and name
  // prefixes are purely so a human reading the slot table can tell which deployment and which
  // worker a row belongs to. `workerLeaseScope` is reused rather than reimplemented so the two
  // lease systems label a deployment identically.
  const leaseScope = workerLeaseScope(opts.readEnv);
  const holder = `${leaseScope}:${opts.name}:${crypto.randomUUID()}`;

  /**
   * Queues this run may own a row in. A queue goes in BEFORE its claim is sent, because a claim
   * whose response was lost may still have committed a row we never learned about, and comes back
   * out as soon as the server tells us definitively that it claimed nothing there. Exit releases
   * whatever is left; there are at most `queueNames.length` entries (two today).
   */
  const touchedQueues = new Set<string>();
  /** Queues a claim has actually returned messages from. A subset of `touchedQueues`. */
  const claimedQueues = new Set<string>();

  opts.scope?.setTag("worker_run_mode", "org_leased");
  opts.scope?.setTag("worker_lease_scope", leaseScope);
  opts.scope?.setTag("org_slot_holder", holder);

  /**
   * The run is over — meaning nothing more will be CLAIMED. Set by a lost slot, a spent idle
   * budget, a spent wall-clock run budget, a stall, or a dead RPC. Messages already in flight are
   * unaffected by every one of those.
   */
  let finished = false;
  /** We believe the server has a slot row for us. Only ever set from a claim that returned rows. */
  let held = false;
  let heldOrgValue: string | null = null;
  /** Which pool the held slot is in, and therefore which queue renewal must target. */
  let heldQueueName: string | null = null;
  /**
   * Bumped whenever the IDENTITY of the held lease changes — a rotation onto another queue, or
   * giving the slot up. An in-flight renewal records this and refuses to act on a result that
   * arrived after its lease went away. Re-claiming the SAME queue deliberately does not bump it:
   * that is the same lease, so a renewal in flight for it is still meaningful, and bumping would
   * throw away a renewal on every iteration of a busy drain.
   */
  let leaseGeneration = 0;
  let lastRenewAt = now();
  /** Last time the LOOP called in. Distinct from `lastRenewAt`, which the timer also moves. */
  let lastProgressAt = now();
  /** Set on the first idle poll, cleared whenever work is found. */
  let idleDeadline: number | null = null;
  /** What the most recent claim attempt resolved to. Observability only; nothing branches on it. */
  let lastClaimOutcome: OrgClaimStatus | null = null;
  let consecutiveClaimErrors = 0;
  /**
   * Set when the claim RPC failed in a way retrying cannot fix: the function is missing (deploy
   * skew) or the server rejected the call outright (unseeded slot pool, bad argument). Doubles as
   * the Sentry tag value.
   */
  let fatalClaimError: "rpc_missing" | "claim_rejected" | null = null;
  /**
   * Latched when a pinned claim was refused because this database's `claim_org_slot_and_read`
   * predates the `pin_org` parameter. Not an error state: it disables continuous refill for this
   * run and nothing else. See the PGRST202 handling in `claimOnce`.
   */
  let pinUnsupported = false;
  /**
   * Messages claimed since the last claim this run issued with nothing in flight, which is the same
   * thing as "messages claimed under the current pin" plus the unpinned batch that opened it.
   *
   * Counted in MESSAGES rather than in claims because a top-up asks for the shortfall, so claims and
   * messages are different quantities and only the second one measures how long an org has had this
   * holder. Reset on every unpinned claim ATTEMPT, not only on a successful one: an attempt made
   * with nothing in flight is a reconsideration whatever it returns, and a run that keeps finding
   * nothing has no stream to bound.
   */
  let claimedUnderPin = 0;
  /**
   * What the base quantum is multiplied by, in `[1, STREAM_QUANTUM_BACKOFF_CAP]`. Doubles after a
   * quantum-driven reconsideration that re-picked the org it had just left, and returns to 1 as soon
   * as one rotates. See STREAM_QUANTUM_BACKOFF_CAP for why the loss it avoids is worth a variable.
   */
  let quantumFactor = 1;

  const markProgress = () => {
    lastProgressAt = now();
  };

  const renewEvery = Math.max(1, Math.floor(ttlMs / HEARTBEAT_DIVISOR));
  const setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms) as unknown as number);
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: number) => clearInterval(h));
  let renewTimer: number | undefined;
  const stopRenewTimer = () => {
    if (renewTimer !== undefined) {
      clearIntervalFn(renewTimer);
      renewTimer = undefined;
    }
  };

  /**
   * Drop this run's lease on ONE queue's pool.
   *
   * Safe to call at any time and from any path, including the stall path, which is the difference
   * from the Redis lease: `(queue_name, holder)` is the row key, so this cannot delete a slot that
   * now belongs to someone else, and it cannot reach into the other pool.
   *
   * A failure is deliberately NOT treated as success — the queue stays in `touchedQueues` so exit
   * retries it — but it is also not an emergency. Renewal is scoped to `heldQueueName`, so a lease
   * this fails to drop stops being renewed and lapses at its TTL on its own.
   */
  const releaseQueue = async (queueName: string, reason: string): Promise<boolean> => {
    try {
      const res = await opts.rpc.release({ queue_name: queueName, holder });
      if (res.error) {
        opts.scope?.setTag("org_slot_release", "failed");
        console.warn(
          `[orgLeaseRun] ${opts.name}: release (${reason}) of ${queueName} failed: ` +
            `${res.error.message ?? "unknown"}; the lease will lapse at its TTL instead`
        );
        return false;
      }
      touchedQueues.delete(queueName);
      claimedQueues.delete(queueName);
      return true;
    } catch (e) {
      opts.scope?.setTag("org_slot_release", "failed");
      Sentry.captureException(e, opts.scope);
      return false;
    }
  };

  /**
   * Give up every lease this run may hold, in every pool it has touched. The TTL frees whatever this
   * fails to free.
   */
  const releaseSlot = async (reason: string): Promise<void> => {
    held = false;
    heldOrgValue = null;
    heldQueueName = null;
    // Any renewal in flight was issued against the lease we are dropping, so its answer must not
    // land on whatever this run does next.
    leaseGeneration++;
    stopRenewTimer();
    for (const queueName of [...touchedQueues]) {
      await releaseQueue(queueName, reason);
    }
  };

  /**
   * Give the slot back — UNLESS this run is still working messages it claimed under it.
   *
   * Every release inside `claim()` goes through here. Each of those paths ("this org has no more
   * ready work", "the fleet is saturated", "the claim RPC is broken") is a statement about what is
   * left to CLAIM, and with continuous refill none of them is a statement about what is still
   * RUNNING. Releasing with `n-1` handlers still going would publish a lie: the slot table would say
   * this org has zero concurrency while this isolate spends its GitHub quota, and the allocator
   * would admit another leaseholder on top of it — the per-org cap this whole feature exists to hold.
   *
   * Deferring is safe in the direction that matters. The lease keeps being renewed while messages
   * are in flight (see `renew`), the driver drains before the caller's `finally`, and `release()`
   * then drops every pool in `touchedQueues`. The cost of deferring is that one org's headroom is
   * held for up to one message longer than strictly necessary; the cost of not deferring is a
   * breached invariant.
   *
   * The stall path deliberately does NOT go through here. A wedged holder's messages never settle,
   * so "wait until nothing is in flight" is exactly the condition that would never come true, and
   * the stall guard exists precisely to bound that case.
   */
  const releaseSlotUnlessDraining = async (reason: string): Promise<void> => {
    if (inFlightCount() > 0) {
      opts.scope?.setTag("org_slot_release_deferred", reason);
      return;
    }
    // CLEARED, not just set. This scope is the RUN scope, and the worker clones it per message, so
    // a tag left on from an earlier deferral is copied onto every event captured afterwards — the
    // same read-through that made `pgmq_archive_failed` stick to a whole batch (see
    // processOneQueueMessage). A deferral that has since been honored must not keep claiming the
    // slot is being held back.
    opts.scope?.setTag("org_slot_release_deferred", "no");
    await releaseSlot(reason);
  };

  /**
   * Renew the slot, or stop.
   *
   * Called both from the independent timer and from the loop methods. The stall check comes FIRST
   * and is the reason the timer is not itself evidence of liveness: a batch that legitimately runs
   * for minutes must keep its slot, and an isolate parked on a promise that never settles must not,
   * and from the timer's point of view those look identical. Only `lastProgressAt` tells them apart.
   */
  const renew = async (): Promise<void> => {
    if (!held || heldQueueName === null) return;
    // A FINISHED RUN THAT IS STILL DRAINING KEEPS RENEWING. `finished` used to be reachable only
    // between batches, so "the run is over" and "nothing of ours is running" were the same
    // statement. Under continuous refill they are not: `no_capacity` or a fatal claim error can end
    // a run that still has up to `n-1` messages going, and the worst single message measured
    // (94.8s) outlives the 60s default TTL. Stopping renewal there would let the lease lapse while
    // the handlers run, which is the same breach as releasing early — see
    // `releaseSlotUnlessDraining`. The driver's drain bounds how long this can go on, and the stall
    // guard below still bounds the pathological case where it does not end.
    if (finished && inFlightCount() === 0) return;

    if (now() - lastProgressAt > maxStall) {
      finished = true;
      opts.scope?.setTag("org_slot", "stalled");
      console.warn(
        `[orgLeaseRun] ${opts.name}: no loop progress for ${now() - lastProgressAt}ms (max ${maxStall}ms) ` +
          `holding org=${heldOrgValue}, giving the slot up`
      );
      // Unlike the Redis lease, releasing here is unambiguously safe and strictly better than
      // waiting out the TTL: the org gets its headroom back now rather than in up to `ttlSeconds`.
      await releaseSlot("stalled");
      return;
    }

    // WHICH LEASE THIS RENEWAL IS ABOUT, captured before the await.
    //
    // The renewal timer fires independently of the loop, so a renewal can be in flight while
    // `claim()` rotates this run onto the other queue. The renewal was issued for the OLD queue;
    // rotation then releases that row; the RPC finds nothing live and returns false — and without
    // this guard that false was applied to the state of the NEW lease, marking a slot we had just
    // claimed as lost, stopping its renewal timer, and letting it expire while its batch was still
    // running. Another leaseholder then enters the same org and the per-org cap is exceeded, which
    // is the one invariant this whole feature exists to hold.
    //
    // A generation counter rather than a lock around claim-and-renew: the lock would have to be
    // held across `claim()`, which awaits a network round trip and a whole batch, and blocking
    // renewal behind that is exactly what the independent timer exists to prevent — a long batch
    // would let the lease lapse. The counter is a single comparison and its rule is local and
    // total: A RESULT MAY ONLY MUTATE THE LEASE IT WAS ISSUED AGAINST.
    const issuedForQueue = heldQueueName;
    const issuedGeneration = leaseGeneration;

    try {
      // THE HELD QUEUE, never "all of them". If this run also has a lease in the other pool — a
      // rotation whose eager release did not land — that lease is meant to LAPSE, and renewing it
      // here would resurrect it on every heartbeat and pin an org nobody is draining.
      const res = await opts.rpc.renew({
        queue_name: issuedForQueue,
        holder,
        lease_ttl_seconds: ttlSeconds
      });
      if (issuedGeneration !== leaseGeneration) {
        // The lease moved while this was in flight. Whatever the server said describes a lease this
        // run no longer has, so it says nothing about the one it does. Drop it — including
        // `lastRenewAt`, which would otherwise claim the CURRENT lease was renewed just now and
        // suppress the next real renewal.
        return;
      }
      if (res.error) {
        // The lease and the queue are the same database. A renew that cannot reach it means the
        // claim and the archive cannot either, so this isolate has nothing useful left to do;
        // ending the run hands the work to a fresh one rather than draining without a renewable
        // slot, which is how two leaseholders would end up on one org.
        finished = true;
        held = false;
        heldOrgValue = null;
        heldQueueName = null;
        stopRenewTimer();
        opts.scope?.setTag("org_slot", "renew_failed");
        console.warn(`[orgLeaseRun] ${opts.name}: renew failed: ${res.error.message ?? "unknown"}`);
        return;
      }
      if (res.data !== true) {
        // The server says we no longer hold a slot: our TTL lapsed and the row was reaped, or an
        // operator cleared it. Do NOT re-claim in place — a holder id whose row has been reaped is
        // exactly the state a fresh isolate resets cleanly, and re-claiming under the same id is
        // how two runs would alternate ownership of one org.
        const lostOrg = heldOrgValue;
        finished = true;
        held = false;
        heldOrgValue = null;
        heldQueueName = null;
        stopRenewTimer();
        opts.scope?.setTag("org_slot", "lost");
        console.warn(`[orgLeaseRun] ${opts.name}: slot for org=${lostOrg} is no longer ours, stopping`);
        return;
      }
    } catch (e) {
      // Same staleness rule as the success path: a throw from a renewal for a lease we have since
      // left says nothing about the one we hold now.
      if (issuedGeneration !== leaseGeneration) return;
      finished = true;
      held = false;
      heldOrgValue = null;
      heldQueueName = null;
      stopRenewTimer();
      opts.scope?.setTag("org_slot", "renew_failed");
      Sentry.captureException(e, opts.scope);
      return;
    }
    lastRenewAt = now();
  };

  /**
   * Renew on an INDEPENDENT timer, not only between iterations, for the same reason workerRun.ts
   * does: a batch of `n` create_repos can outlive the TTL, and a heartbeat that only fires between
   * iterations would let the slot lapse mid-batch, another leaseholder claim the same org, and the
   * two duplicate work against the per-org rate limit this feature exists to respect.
   *
   * Armed only while a slot is actually held — renewing before the first claim would ask the server
   * about a row that does not exist and be told, correctly, that we hold nothing.
   */
  const armRenewTimer = () => {
    if (renewTimer !== undefined) return;
    renewTimer = setIntervalFn(() => {
      void renew();
    }, renewEvery);
  };

  /**
   * One claim against one queue, reduced to an outcome.
   *
   * CLAIMED ROWS ARE IDENTIFIED BY `msg_id`, NOT BY `status`. That is deliberate: it is correct
   * under the current contract (status rows carry NULLs everywhere but `status`) AND under the
   * previous one, where message rows had no `status` column at all. Keying off the status string
   * would mean that an image reaching a database whose migration had not been applied yet would see
   * `status === undefined` on real message rows, drop a batch whose visibility timeout had already
   * been bumped, and silently defer that work until the VT expired. Deploy skew must not be able to
   * lose messages.
   */
  const claimOnce = async (
    queueName: string,
    n: number,
    pinOrg?: string
  ): Promise<{ status: OrgClaimStatus; messages: OrgQueueMessage[] }> => {
    let res: RpcResult<OrgSlotRow[]>;
    // Recorded BEFORE the call, not after it succeeds: a claim whose response never arrives may
    // still have committed a row, and exit has to be able to clean that up.
    touchedQueues.add(queueName);
    try {
      res = await opts.rpc.claim({
        queue_name: queueName,
        sleep_seconds: opts.visibilityTimeoutSeconds,
        // The SHORTFALL, not necessarily the ceiling. `sleep_seconds` deliberately does NOT scale
        // down with it: `requiredVisibilityTimeoutSeconds(n) = n * 120` is a per-LEASEHOLDER model
        // owned by asyncWorkerTuning.ts, and a refill claim asking for 1 message still wants the
        // same visibility timeout every other claim in this run used. Sending a smaller VT here
        // would make redelivery depend on how a stream happened to be chopped up.
        n,
        holder,
        lease_ttl_seconds: ttlSeconds,
        max_per_org: opts.maxPerOrg,
        global_cap: opts.globalCap,
        // SPREAD, so the key is ABSENT rather than null on an unpinned claim. See `pin_org` on
        // OrgSlotRpc: PostgREST matches an overload on the set of argument names, so `pin_org: null`
        // would be a different function signature and would 404 against a database that has not had
        // the parameter added yet.
        ...(pinOrg === undefined ? {} : { pin_org: pinOrg })
      });
    } catch (e) {
      throw new OrgClaimError(e instanceof Error ? e.message : String(e), queueName);
    }
    if (res.error) {
      if (res.error.code === PGRST_UNDEFINED_FUNCTION && pinOrg !== undefined) {
        // THE PIN IS MISSING, NOT THE FUNCTION — and the two must not be confused. An UNPINNED
        // claim reaching a database with no `claim_org_slot_and_read` at all is the deploy-skew case
        // below, and it is fatal because nothing this isolate can do will make it work. A PINNED
        // claim answering PGRST202 says only that this database's version of the function predates
        // the `pin_org` parameter, which is the same deploy ordering (image ahead of migration)
        // arriving through a much narrower door: the unpinned claims that START a run still work.
        //
        // So this degrades rather than dies. Refilling without a pin is the exact hazard pinning
        // exists to close — the allocator would re-point this holder's slot at a needier org while
        // the previous org's messages are still running under it — so the answer is not "retry
        // unpinned", it is "stop topping up". `pinUnsupported` latches for the life of the run and
        // every later top-up skips the RPC entirely, so an un-migrated database gets batch-at-a-time
        // behavior at the cost of exactly one wasted round trip per run, with no lost messages, no
        // isolate churn, and no breached cap.
        pinUnsupported = true;
        console.warn(
          `[orgLeaseRun] ${opts.name}: claim_org_slot_and_read does not accept pin_org yet ` +
            `(${res.error.code}); this database predates the pinned-refill migration. Continuous ` +
            `refill is disabled for this run and it will drain batch-at-a-time instead. This is a ` +
            `deploy-ordering effect and clears on its own once the migration lands.`
        );
        // Reported as "nothing to top up", because that is what the caller must now do: let the
        // in-flight set drain and re-claim at rest. No row was written — PostgREST never reached the
        // function — but the queue stays in `touchedQueues` if an earlier claim took a slot there,
        // which is exactly what the shared tail below already gets right.
        return { status: "no_demand", messages: [] };
      }
      if (res.error.code === PGRST_UNDEFINED_FUNCTION) {
        fatalClaimError = "rpc_missing";
        console.error(
          `[orgLeaseRun] ${opts.name}: claim_org_slot_and_read is not present in this database ` +
            `(${res.error.code}). Per-org leasing is configured but its migration has not been applied; ` +
            `ending this run. Set GITHUB_ASYNC_WORKER_ORG_SLOT_GLOBAL_CAP=0 to fall back to the ` +
            `single-leaseholder drain until it is.`
        );
      } else if (res.error.code === PG_RAISE_EXCEPTION) {
        // EVERY `raise exception` inside claim_org_slot_and_read is a DEPLOYMENT or CALLER error,
        // never a runtime state: an unseeded slot pool for this queue, or an argument this module
        // should never have sent (empty holder, n < 1, negative sleep_seconds, lease_ttl < 1). None
        // of them can come right on a retry, and the unseeded-pool case is the one that matters
        // most — it is exactly the failure that used to arrive as zero rows forever while every
        // liveness signal stayed green. Grinding through the 3-strikes counter would turn a loud,
        // actionable error back into a slow idle.
        //
        // Matched on the SQLSTATE rather than on the message text. P0001 is not unique to the
        // unseeded-pool case, but it does not need to be: the set of things that raise out of this
        // function is closed and all of them are permanent. The server's own message is forwarded
        // verbatim because it names the queue and says what to do about it.
        fatalClaimError = "claim_rejected";
        console.error(
          `[orgLeaseRun] ${opts.name}: claim_org_slot_and_read rejected the call for queue=${queueName} ` +
            `(${res.error.code}): ${res.error.message ?? "no message"}. This is a deployment or ` +
            `configuration error, not a transient one, so this run is ending rather than retrying.`
        );
      }
      throw new OrgClaimError(res.error.message ?? `rpc error ${res.error.code ?? "unknown"}`, queueName);
    }

    const rows = res.data ?? [];
    const messages = rows.filter((r): r is OrgSlotRow & OrgQueueMessage => r.msg_id !== null && r.msg_id !== undefined);
    if (messages.length > 0) {
      claimedQueues.add(queueName);
      return { status: "claimed", messages };
    }

    // An unrecognised or absent status resolves to `no_demand`, which is what zero rows meant before
    // the status column existed. That is the conservative reading: it advances to the next queue
    // exactly as the old code did, where reading it as `no_capacity` would stop a worker draining
    // against a database that simply has not been migrated yet.
    const status: OrgClaimStatus = rows[0]?.status === "no_capacity" ? "no_capacity" : "no_demand";

    // ZERO MESSAGES DOES NOT MEAN ZERO SLOTS WERE WRITTEN, and only `no_demand` is safe to treat
    // that way.
    //
    // `no_demand` is: `demand` was empty for this queue (or for the pinned org), so `winner` was
    // empty, so `free_slot` was empty, so the `claimed` CTE never ran. Nothing was committed and
    // there is genuinely nothing to give back.
    //
    // `no_capacity` is NOT that. The SQL reaches it by TWO routes and only one of them is empty-
    // handed. `winner` can qualify, `free_slot` can take a row, and the data-modifying `claimed`
    // CTE then commits a live lease — and `picked` can still come back empty, because it re-reads
    // the queue under `FOR UPDATE OF q SKIP LOCKED` and every one of that org's ready rows may be
    // locked by a concurrent archive, delete or `pgmq_public.read`. `drained` is then empty and the
    // UNION ALL's status arm fires with `no_capacity`, because `demand` for the org is non-empty.
    // Reproduced against a local database: the call returns `no_capacity` with no rows while
    // `async_worker_slots` holds a live row for the caller.
    //
    // Dropping the queue here on that path is how the lease is LOST rather than released: `claim()`
    // sees `held === false` on a first claim, skips its release, ends the run, and `release()` then
    // walks an empty `touchedQueues` and issues no `release_org_slot`. The row stays live for a full
    // TTL under an isolate that has already returned, occupying one `global_cap` and one
    // `max_per_org` for an org nobody is draining — the exact leak shape this module keeps closing.
    //
    // Continuous refill makes it likelier in both directions: a top-up asks for the SHORTFALL, so a
    // single locked row is enough where a batch claim needed all `n`, and there are ~`n` times as
    // many claims per run. So the set is only narrowed on the answer that proves nothing was
    // written, and `no_capacity` keeps the queue for exit to clean up. A release against a queue we
    // hold nothing in is a no-op — `release_org_slot` is scoped to `(queue_name, holder)` — so the
    // cost of being wrong in this direction is one RPC, against a pinned org for a whole TTL.
    if (status === "no_demand" && !claimedQueues.has(queueName)) touchedQueues.delete(queueName);

    return { status, messages: [] };
  };

  return {
    mode: "org_leased",
    holder,
    drainConcurrency: opts.drainConcurrency,
    tracksInFlight: opts.inFlightCount !== undefined,
    heldOrg: () => heldOrgValue,
    heldQueue: () => heldQueueName,
    lastOutcome: () => lastClaimOutcome,
    shouldContinue: () => !finished,

    claim: async (maxMessages?: number) => {
      if (finished) return null;
      markProgress();

      // THE WALL-CLOCK BUDGET, CHECKED BEFORE ANYTHING ELSE IN THE CLAIM PATH.
      //
      // Here rather than in `shouldContinue()` because the thing being bounded is the CLAIM, and a
      // predicate the driver also consults between settles would be answering a different question
      // with the same word. Everything this run has already read is unaffected: the messages run
      // on, `renew` keeps the lease alive past `finished` while they do, and
      // `releaseSlotUnlessDraining` holds the slot until the last of them lands. Reading the clock
      // here and nowhere else also means the budget cannot cut a message off half way, which is the
      // failure it exists to prevent — inflicting it on purpose would be no better.
      //
      // ONE NO-OP CALL PER RUN AT MOST, not a poll: the driver breaks on `!shouldContinue()`
      // immediately after a null claim, and `onIdle` returns false without sleeping. The claim path
      // is also the only one the driver cannot skip for long — when the in-flight set is full it
      // waits on a completion, and a completion is exactly what produces the shortfall that brings
      // it back here.
      if (claimDeadline !== null && now() >= claimDeadline) {
        const overBy = now() - claimDeadline;
        opts.scope?.setTag("org_slot", "run_budget_spent");
        console.log(
          `[orgLeaseRun] ${opts.name}: wall-clock run budget spent ${overBy}ms ago ` +
            `(${budgetMs}ms from isolate start); not claiming again. ${inFlightCount()} message(s) ` +
            `still in flight will finish before the slot is released, and the next cron poke gets a ` +
            `fresh isolate with a fresh budget.`
        );
        // Same shape as `no_capacity`: give the slot back if nothing of ours is running under it,
        // and defer to the drain if something is. The run is over either way.
        if (held) await releaseSlotUnlessDraining("run_budget_spent");
        finished = true;
        return null;
      }

      // `drainConcurrency` REMAINS THE CEILING. A refill caller asks for the shortfall, and asking
      // for more than the ceiling — or for zero, which can only come back `no_demand` — is a caller
      // bug that should not reach the RPC. Clamping rather than throwing because this is a hot path
      // and the safe value is obvious.
      //
      // NaN IS NOT CLAMPED BY `Math.max`, which is what made this a real hole rather than a
      // theoretical one: `Math.max(1, NaN)` is NaN, so a non-finite `maxMessages` sailed through the
      // guard, was serialized by PostgREST as `n: null`, and came back as the P0001 that
      // `claim_org_slot_and_read` raises for `n < 1`. P0001 is fatal on the FIRST failure, so one
      // bad arithmetic result ends the run with a "deployment or configuration error" that is
      // neither. Resolve it to the ceiling, which is what "no opinion" means here.
      const requested = Math.floor(maxMessages ?? opts.drainConcurrency);
      const n = Number.isFinite(requested)
        ? Math.max(1, Math.min(opts.drainConcurrency, requested))
        : opts.drainConcurrency;

      // A TOP-UP MAY ONLY EXTEND WHAT THIS RUN IS ALREADY DOING: same org, same queue, or no claim
      // at all. A claim issued with nothing in flight is unchanged — every queue in priority order,
      // unpinned, free to rotate onto whichever org is neediest — because that is the moment when
      // rotating costs nothing.
      //
      // WHY THE PIN. `claim_org_slot_and_read` re-points THIS HOLDER'S slot row at whichever org it
      // picks, and an unpinned top-up picks the neediest org, not ours. Mid-stream that means the
      // slot table stops counting the `n-1` messages still running for the org we just left, so that
      // org can reach `max_per_org x n + (n-1)`, which at `maxPerOrg` 2 and `n` 4 is 11 against a
      // budgeted 8. The per-org cap is the invariant this entire feature exists to hold, so a top-up
      // names its org and the allocator either serves it or says no.
      //
      // WHY A TOP-UP NEVER PROBES ANOTHER QUEUE. Same argument one level up: landing on a different
      // queue mid-stream rotates the slot into the other pool and releases the one our in-flight
      // messages were claimed under, which loses exactly the same count. So a top-up probes the held
      // queue and stops there.
      //
      // WHICH WOULD COST UPWARD PREEMPTION, so it is bought back a different way: ONLY THE
      // HIGHEST-PRIORITY QUEUE IS STREAMED. On any lower-priority queue a run drains its batch and
      // lets the in-flight set empty before claiming again, which restores the full unpinned probe —
      // `async_calls` first — at exactly the cadence it happens today, one batch. Analytics work
      // pays batch-at-a-time's ~27%; urgent work does not, and a low-priority stream can no longer
      // outlive a main-queue backlog. The alternative (probe `async_calls` unpinned mid-stream)
      // reopens the rotation hazard in the name of preempting sooner, which is the trade that was
      // just rejected.
      const draining = inFlightCount() > 0;
      let pinOrg: string | undefined;
      let probeQueues: readonly string[] = opts.queueNames;
      // Whether THIS claim is the unpinned reconsideration a spent quantum arranged for, as opposed
      // to one the stream reached on its own by running out of work. Only the first kind has paid a
      // drain-out, so only the first kind may stretch the quantum when it comes back empty-handed.
      // Readable here because `claimedUnderPin` is not reset until a few lines below.
      let afterQuantum = false;
      // Set on EVERY claim rather than only on the two paths that opt out. The run scope is cloned
      // onto every message event, so a tag that is only ever written when something goes wrong
      // latches: one quiesced top-up early in a run marks every later event as quiesced, including
      // the ones from the stream that resumed. A tag that always states the current answer cannot.
      opts.scope?.setTag("org_slot_refill", draining ? "streaming" : "at_rest");
      if (draining) {
        // Work in flight but no lease to pin to: the stall guard released it, or the run is over.
        // There is nothing safe to top up with.
        //
        // The empty-string check is not paranoia about a value that cannot occur, it is about what
        // happens if it does. `claim_org_slot_and_read` RAISES on an empty `pin_org`, and a P0001 is
        // fatal on the FIRST failure by design — so an org that somehow arrived blank would not
        // degrade, it would end the run and log a deployment error. Quiescing instead costs one
        // drain and is self-correcting: the unpinned claim that follows re-reads the org.
        if (!held || heldQueueName === null || !heldOrgValue) return null;
        if (heldQueueName !== opts.queueNames[0]) {
          opts.scope?.setTag("org_slot_refill", "quiesced_for_priority");
          return null;
        }
        if (pinUnsupported) {
          opts.scope?.setTag("org_slot_refill", "pin_unsupported");
          return null;
        }
        // THE QUANTUM IS SPENT, so stop topping this stream up and let it drain out. Nothing else
        // happens here, and that is deliberate: the unpinned claim this is arranging for is issued
        // by the ordinary path a few settles from now, once `inFlightCount()` reaches zero and
        // `draining` is false. Reaching an unpinned claim by WAITING rather than by relaxing the pin
        // is what keeps the accounting exact, because the hazard the pin closes is specifically an
        // unpinned claim with this org's messages still running.
        //
        // The same shape as `quiesced_for_priority` above, on a timer instead of on a queue. That
        // path already pays one drain-out per batch so a low-priority stream cannot outlive a
        // main-queue backlog; this pays one per quantum so a main-queue stream cannot outlive
        // another org's wait. One is strictly cheaper than the other and neither is new machinery.
        if (streamQuantum !== null && claimedUnderPin >= streamQuantum * quantumFactor) {
          opts.scope?.setTag("org_slot_refill", "quiesced_for_fairness");
          return null;
        }
        probeQueues = [heldQueueName];
        pinOrg = heldOrgValue;
      } else {
        // This claim is the reconsideration, so the count it bounds starts again from here whatever
        // the claim turns out to return.
        afterQuantum = streamQuantum !== null && claimedUnderPin >= streamQuantum * quantumFactor;
        claimedUnderPin = 0;
      }

      // THE PROBE ORDER IS THE PRIORITY ORDER, ALWAYS. `async_calls_low_priority` is read only
      // after `async_calls` has come back empty in THIS pass, and nothing below may short-circuit
      // that — not even while a slot is held on the low-priority pool. A run that probed its held
      // queue first would keep draining low-priority work while the main queue had a backlog, and
      // with `globalCap: 1` there would be no other leaseholder to notice.
      //
      // Probing a queue we do not hold is free: the SQL writes a slot row only when an org
      // qualifies, so a probe that comes back empty claims nothing and there is nothing to undo.
      // That is why the rotation release below happens AFTER a claim succeeds rather than before
      // the probe. Releasing first would give up a live slot on every single iteration that merely
      // LOOKS at the higher-priority queue — the common case while draining low-priority work — and
      // hand the org to a competitor in the gap. The cost of releasing after is a few milliseconds
      // in which this run owns two rows, which over-counts `global_cap` rather than under-counting
      // it, and being briefly too conservative is the safe direction.
      for (const queueName of probeQueues) {
        let outcome: { status: OrgClaimStatus; messages: OrgQueueMessage[] };
        try {
          outcome = await claimOnce(queueName, n, pinOrg);
        } catch (e) {
          consecutiveClaimErrors++;
          if (fatalClaimError !== null || consecutiveClaimErrors >= maxClaimErrors) {
            finished = true;
            opts.scope?.setTag("org_slot", fatalClaimError ?? "claim_failed");
            // Whatever slot we may hold is useless to an isolate that is giving up — unless it is
            // still running the messages it claimed under that slot, in which case giving it back
            // now is how a second leaseholder joins them. Best effort either way; the TTL covers it.
            await releaseSlotUnlessDraining("claim_failed");
          }
          throw e;
        }

        lastClaimOutcome = outcome.status;

        // NO_CAPACITY IS NOT "NOTHING TO DO", AND MUST NOT FALL THROUGH. This queue has ready work;
        // the fleet is simply already draining it at the configured concurrency. Advancing to
        // `async_calls_low_priority` here would send this isolate off to do repo-analytics work with
        // GitHub capacity the backed-up queue needs — the precise inversion the status column was
        // added to make visible.
        if (outcome.status === "no_capacity") {
          // `no_capacity` does NOT say this org is out of work. It says work is waiting and the
          // caps are full, and the run is about to end (see below), so a slot this isolate will not
          // claim against again is headroom some other leaseholder could be using. Give it back,
          // rather than hold it to the TTL. The exception is messages claimed under it that are
          // still running: then the run ends but the slot, and its renewals, stay ours until the
          // driver has drained them.
          //
          // It does not prove the server wrote nothing either, which is why `claimOnce` keeps this
          // queue in `touchedQueues` on this answer. See the note there.
          if (held) await releaseSlotUnlessDraining("no_capacity");
          // AND END THE RUN, rather than sleeping and re-polling. Four reasons, and the last is the
          // one that makes this not a spin loop:
          //   * the fleet is at its configured maximum BY DEFINITION, so another isolate cannot add
          //     throughput, only occupancy — and occupancy is an admission slot, which is the
          //     resource workerRun.ts exists to protect;
          //   * what it would be waiting for is a whole batch finishing, which at n=4 and a 23.1s
          //     p50 is tens of seconds to minutes — longer than the idle budget, so a polling
          //     isolate would usually burn the whole budget and exit having done nothing anyway;
          //   * re-entry is cheap and automatic: pg_cron spawns 2 isolates a minute, so the retry
          //     costs at most ~30s, the same order as the batch it is waiting on;
          //   * and re-entry is RATE-LIMITED BY THE CRON, not by this code. Ending the run is
          //     terminal; nothing here loops. A sleep-and-retry is what could spin once several
          //     isolates a minute start hitting this, and at a saturated cap they will — this is
          //     the steady state, not an edge case.
          finished = true;
          opts.scope?.setTag("org_slot", "no_capacity");
          opts.scope?.setTag("org_slot_queue", queueName);
          return null;
        }

        if (outcome.status === "no_demand") continue;

        const rows = outcome.messages;
        const previousQueue = heldQueueName;
        const previousOrg = heldOrgValue;
        consecutiveClaimErrors = 0;
        idleDeadline = null;
        held = true;
        // EVERY SUCCESSFUL CLAIM INVALIDATES ANY RENEWAL IN FLIGHT, including one that re-takes the
        // queue we were already on.
        //
        // A claim that returns rows is the server stating, just now, that this holder owns a live
        // slot — `claim_org_slot_and_read` sets `expires_at = clock_timestamp() + ttl` on the row it
        // claims. That is strictly newer and more authoritative than the answer to a renewal issued
        // before it. Letting the older answer win is the bug: a renewal can evaluate to false
        // because the TTL lapsed a moment earlier, have its response delayed, and land after a
        // re-claim has already refreshed the same row — killing a lease the server considers live,
        // stopping its timer while the batch runs, and letting another worker into the org.
        //
        // An earlier version bumped only when the QUEUE NAME changed, on the theory that discarding
        // renewals during a busy same-queue drain would let the lease lapse under load. That was
        // wrong, and the asymmetry is worth stating because it is what makes aggressive discarding
        // free: applying a stale FAILURE kills a live lease and breaches the per-org cap, whereas
        // discarding a stale SUCCESS costs nothing at all. `renew_org_slot` has already committed
        // server-side by the time its response is in flight, so dropping the response cannot
        // un-extend the lease; the only client-side effect of a successful renewal is `lastRenewAt`,
        // which merely debounces `heartbeat()`. Leaving it stale makes the next heartbeat renew
        // MORE eagerly, not less, and the independent interval timer — which never consults it —
        // keeps renewing on its own cadence regardless. There is no path from a discarded success
        // to a lapsed lease.
        leaseGeneration++;
        heldQueueName = queueName;
        // RE-READ THE ORG EVERY TIME; do not assume a leaseholder keeps the org it started with.
        // A holder holds at most one slot, and a repeat claim prefers re-taking the slot it already
        // has, so calling this again ROTATES this holder onto whichever org is neediest now rather
        // than leaking a second slot. That is why `heldOrgValue` is reassigned per claim and why
        // nothing here caches an org across iterations.
        //
        // The contract says one claim returns ONE org's messages, so `rows[0]` is the right source
        // for the run-level tag; per-message code reads each row's own `org`, so a future SQL change
        // that returned a mixed batch would mis-tag the run but could not mis-attribute a message.
        //
        // AN ASSERTION THAT SHOULD NEVER FIRE, kept rather than deleted because it is the last line
        // of defense on the invariant this whole module exists for.
        //
        // Rotating onto another org is normal and desirable BETWEEN streams, and impossible DURING
        // one: every claim issued with work in flight carries `pin_org`, and the pinned contract
        // says the allocator considers that org alone and does not fall back to re-picking. So
        // reaching here with a different org and a non-empty in-flight set means the server ignored
        // the pin — a contract violation, not a race — and the consequence is silent: the slot table
        // stops counting this run's remaining messages for the org it was working, and that org can
        // exceed `max_per_org x n`. Silent cap breaches are exactly what cost two review rounds, so
        // this one is loud.
        //
        // It does not throw. The messages in `rows` have already had their visibility timeout bumped
        // server-side; abandoning them here would defer real work for a whole VT to make a point.
        if (heldOrgValue !== null && heldOrgValue !== rows[0].org && inFlightCount() > 0) {
          opts.scope?.setTag("org_slot_pin_violated", "true");
          console.error(
            `[orgLeaseRun] ${opts.name}: claim_org_slot_and_read returned org=${rows[0].org} for a ` +
              `claim pinned to org=${heldOrgValue} with ${inFlightCount()} message(s) still in flight. ` +
              `The per-org concurrency cap is no longer being counted correctly for org=${heldOrgValue}.`
          );
          const s = opts.scope?.clone();
          s?.setLevel("error");
          s?.setContext("org_slot_pin_violated", {
            pinned_org: heldOrgValue,
            returned_org: rows[0].org,
            queue_name: queueName,
            in_flight: inFlightCount()
          });
          Sentry.captureMessage("orgLeaseRun: claim_org_slot_and_read ignored pin_org", s);
        }
        heldOrgValue = rows[0].org;
        // What the quantum counts. The opening batch of a stream is included, because it is part of
        // the time this org has held this leaseholder and because leaving it out would make the
        // quantum mean something slightly different at every `n`.
        claimedUnderPin += rows.length;
        // AND WHAT THE RECONSIDERATION WAS WORTH. An unpinned claim that lands on a different org is
        // the quantum doing its job, so the next stream gets the base quantum again. One that comes
        // back with the org we just drained out of found nobody else to serve, and paid a drain-out
        // to find that out, so the next probe is further away. Only claims that followed a spent
        // quantum are judged: a stream that ended because its org ran out of work cost nothing, and
        // must not be able to stretch the bound it never tested.
        if (pinOrg === undefined) {
          quantumFactor =
            afterQuantum && previousOrg !== null && previousOrg === heldOrgValue
              ? Math.min(quantumFactor * 2, STREAM_QUANTUM_BACKOFF_CAP)
              : 1;
        }
        opts.scope?.setTag("github_org", heldOrgValue);
        opts.scope?.setTag("org_slot_queue", queueName);
        armRenewTimer();
        markProgress();

        // ROTATION, AND THIS IS AN OPTIMISATION, NOT A CORRECTNESS GUARD. Having just taken a slot
        // in a different pool, the run holds a lease in each for a moment. That state is legal: all
        // three RPCs are queue-scoped, `heldQueueName` is already the NEW queue, so the pool we left
        // stops being renewed and its lease lapses at its TTL — the same bound the design already
        // accepts for an isolate that dies without releasing.
        //
        // What the release buys is LATENCY: the org we left gets its headroom back now rather than
        // up to one TTL from now. So a failure here is not an error path worth escalating, it just
        // forfeits that. Do NOT rewrite this as a release BEFORE the probe: the higher-priority
        // queue is probed on every pass, so releasing first would give up a live slot on every
        // iteration that merely looks at it and hand the org to a competitor in the gap.
        //
        // THIS ONE IS NOT DEFERRED WHILE WORK IS IN FLIGHT, unlike every other release in `claim()`,
        // and it does not need to be. A claim that can land on a DIFFERENT queue is by construction
        // a claim issued with nothing in flight — a top-up probes only the held queue — so there are
        // no messages still running under the row being dropped, and none of the counting this
        // release would otherwise lose. That is why a rotation keeps its immediate release and the
        // latency that buys, while the paths that give up a slot WITHOUT acquiring a replacement
        // have to wait for the drain.
        if (previousQueue !== null && previousQueue !== queueName) {
          await releaseQueue(previousQueue, "rotated");
        }
        return { org: heldOrgValue, queueName, messages: rows };
      }

      // `no_demand` on every queue: there is genuinely no ready work anywhere. Note that the slot we
      // were already holding was NOT touched by any of those calls — the SQL only writes the slot row
      // when an org qualifies — so a holder that stops finding work keeps a live lease until its TTL
      // unless it says otherwise. Releasing here is what keeps "holds a slot" and "is draining" from
      // drifting apart, and it returns the org's headroom to the fleet now rather than one TTL later.
      //
      // Unlike `no_capacity` this does NOT end the run: nobody else is working this queue, so a
      // resident isolate is the lowest-latency way to pick up whatever arrives next, and the idle
      // budget bounds how long it waits.
      if (held) await releaseSlotUnlessDraining("no_work");
      // AND THE IDLE BUDGET ONLY STARTS WHEN THIS RUN IS ACTUALLY IDLE. A refill claim that comes
      // back empty while `n-1` messages are still running is not an idle poll, it is a full
      // leaseholder with nothing left to top up; the driver waits for a completion rather than
      // sleeping. Starting the budget here would arm a deadline during a busy stream and exit the
      // isolate the instant that stream ended, instead of giving the next arrival the budget it is
      // supposed to get. `finding work resets the idle budget` is the same property from the other
      // side, and this keeps it true for a stream as well as for a batch.
      if (inFlightCount() === 0) idleDeadline ??= now() + idleBudget;
      return null;
    },

    heartbeat: async () => {
      // Mark progress BEFORE renewing, or the renewal would judge this very call as the stall.
      markProgress();
      if (held && now() - lastRenewAt >= renewEvery) await renew();
    },

    onIdle: async () => {
      // A run that is already over must not spend the idle sleep first. `no_capacity` ends the run
      // from inside `claim()`, and the caller's loop reaches `onIdle` before it re-checks
      // `shouldContinue()`, so without this the isolate would hold an admission slot for another
      // `idleSleepMs` on the one path whose entire point is to stop holding one.
      if (finished) return false;
      await sleep(opts.idleSleepMs);
      markProgress();
      if (held) await renew();
      if (finished) return false;
      // Residency is earned by work, not by a lease. See the header: 2 isolates a minute all
      // claiming means idle ones must return, or they accumulate against `maxParallelism`.
      if (idleDeadline !== null && now() >= idleDeadline) {
        finished = true;
        opts.scope?.setTag("org_slot", "idle_budget_spent");
        return false;
      }
      return true;
    },

    onError: async () => {
      await sleep(opts.errorSleepMs);
      markProgress();
      if (held) await renew();
    },

    release: async () => {
      stopRenewTimer();
      // Every pool this run has ever sent a claim to, including ones we believe we hold nothing in:
      // a claim whose response was lost after the server committed it leaves a row we never learned
      // about, and a rotation release that failed leaves one we did. This is the only cheap way to
      // clean either up before the TTL, and it cannot touch another holder's row. A run that never
      // claimed has an empty set and makes no calls.
      await releaseSlot("exit");
    }
  };
}

/** Runs one claimed message to completion. Must own its own error handling; see `process` below. */
export type RefillProcessor<T = unknown> = (
  message: OrgQueueMessage<T>,
  context: { queueName: string; org: string }
) => Promise<void>;

export interface ContinuousRefillOptions<T = unknown> {
  run: OrgLeaseRun;
  /**
   * The set of running messages, SHARED with the run that was handed
   * `inFlightCount: () => inFlight.size`. Two objects rather than one because the lease is built
   * before the drain starts and has to be able to ask, at any moment, how much of its slot is in
   * use; passing the set explicitly keeps that wiring visible at the call site instead of hiding it
   * behind a setter that could be forgotten.
   */
  inFlight: Set<Promise<void>>;
  /**
   * Messages to keep in flight. MUST be the same number the run was built with as
   * `drainConcurrency`. `drainOrgLease` normalizes it to that and says so in the log if they differ,
   * and `drainWithContinuousRefill` then REFUSES anything else, so the requirement is enforced at
   * the exported boundary as well as at the one production uses.
   *
   * `claim()` caps ONE claim at `drainConcurrency`, which is not the same thing as capping the
   * in-flight SET at it, and an earlier comment here asserted that it was ("a larger in-flight
   * target than the claim ceiling could never be reached"). Refill reaches it by accumulation: at
   * `maxInFlight` 8 and `drainConcurrency` 4 the first claim takes 4, the next shortfall is 4, and
   * the run holds 8 handlers under ONE slot. The allocator's per-org budget is
   * `max_per_org * drainConcurrency`, so that org runs at twice its accounted concurrency against a
   * GitHub content limiter this feature exists to respect — with nothing in the slot table to show
   * it. Below the ceiling is just as wrong in the other direction: it strands part of the
   * leaseholder's allowance permanently.
   */
  maxInFlight: number;
  process: RefillProcessor<T>;
  /**
   * Reports a claim-RPC failure, or a `process` that rejected.
   *
   * Should not throw, and is no longer TRUSTED not to: every call site wraps it. See `start`.
   */
  onError?: (e: unknown) => void;
}

/**
 * Drain a per-org lease by keeping `maxInFlight` messages running, instead of draining a batch and
 * refilling.
 *
 * ## The loop, and why it is shaped like this
 *
 * Exactly one claim per WAKE-UP, and a wake-up is either the start of the run or a message
 * settling. That single rule is what gives the three properties this has to have:
 *
 *   * IT TOPS UP THE SHORTFALL RATHER THAN CLAIMING SINGLY. Every claim is an RPC that takes a
 *     GLOBAL `pg_advisory_xact_lock` (one key for all queues, see the migration), so claim traffic
 *     is a shared resource and not a private one. Refill raises it from one claim per BATCH to one
 *     per MESSAGE: ~4x at n=4, and the 190-message burst becomes ~190 claims over 29 minutes rather
 *     than 47. What that leaves in hand depends on the message mix and on how deep the queue is, and
 *     both move it by more than an order of magnitude, so read the numbers off
 *     DEFAULT_ORG_SLOT_CONTINUOUS_REFILL in asyncWorkerTuning.ts rather than assuming the
 *     create_repo burst is the worst case. Claiming one message at a time regardless of the
 *     shortfall would multiply the traffic again for no throughput at all. Messages that settle
 *     together coalesce for free: each one removes itself from `inFlight` as it settles, so by the
 *     time the race below resumes, the shortfall already counts every message that finished in the
 *     same tick.
 *   * IT CANNOT SPIN. With nothing in flight, an empty claim goes to `run.onIdle()`, which sleeps
 *     and spends the idle budget exactly as it always did. With work in flight, an empty claim waits
 *     for a COMPLETION — never a sleep, never an immediate re-claim — so claim attempts are bounded
 *     by message throughput even when the queue has been empty for minutes.
 *   * IT NEVER RETURNS WITH WORK RUNNING. The `finally` drains before the caller's `release()`, so
 *     the slot is given back after the handlers that were using it have finished, and the isolate is
 *     not returned to the runtime with archive calls still pending.
 *
 * ## What it deliberately does not do
 *
 * NO GRACEFUL DRAIN AHEAD OF ISOLATE RETIREMENT — RETRACTED 2026-09-15, AND THE RETRACTION IS THE
 * POINT. This paragraph used to argue that stopping claims before the horizon costs more than it
 * saves, and the budget in `beginOrgLeaseRun` now does precisely the thing it argued against. The
 * old argument is kept here because being wrong in a legible way is how the next person checks the
 * new one.
 *
 * WHAT IT SAID. Refill makes the ABSOLUTE orphan count worse (mean in-flight 5.2 -> 8) but not the
 * RATE: by Little's law the messages orphaned per retirement are `throughput x mean duration` and
 * those completed per isolate lifetime are `throughput x lifetime`, so the ratio is
 * `mean duration / lifetime` — 48.4/240 either way, throughput cancelling — against which stopping
 * one worst-case message (94.8s) early would idle the tail of every isolate for ~20% of capacity to
 * save ~10% of work.
 *
 * WHAT FALSIFIED IT. That ratio predicts UNDER 1% redelivery for the methods that actually dominate
 * traffic (`sync_repo_permissions` p50 1.4s, `sync_student_team` p50 1.0s, together ~78% of
 * messages). Measured on 2026-09-15: 35.4% for `sync_repo_permissions`, 14.5% whole-queue, with the
 * `read_ct = 2` / `archived_at - enqueued_at` 482-507s signature that says plainly what happened.
 * Two orders of magnitude is not a calibration error, it is a wrong model, and two of its
 * assumptions are visible in hindsight: it was calibrated on the create_repo burst, whose 48.4s mean
 * is not what the queue carries; and it assumed retirements fall on draining and idle isolates
 * alike, when an idle run RETURNS at its 50s idle budget and only a busy one stays resident to be
 * killed. The isolates that reach the wall clock are disproportionately the ones holding messages.
 * A corrected closed form is not offered here — the honest state is that the measurement stands and
 * the model does not.
 *
 * AND THE COST SIDE WAS OVERSTATED TOO. "Idles the tail of every isolate" assumed the isolate then
 * SITS there. It does not: the run stops claiming, drains, and RETURNS, freeing its admission slot
 * for the next of the two pokes a minute the cron delivers. What is actually forgone is the drain-out
 * tail of one leaseholder's org slot — a couple of seconds for the fast methods that dominate, tens
 * of seconds for create_repo — not the whole reserve.
 *
 * WHAT SURVIVES UNCHANGED. The cheap improvement is still not in this file: a visibility timeout
 * that reflects a per-MESSAGE claim would make an orphan wait ~120s instead of ~480s, which shrinks
 * every remaining case rather than the ones this budget catches. That file still has another owner
 * and this change deliberately does not touch it.
 *
 * WHAT THE BUDGET STILL COSTS, SAID PLAINLY. It is sized for the WORST message (see
 * ORG_SLOT_RUN_BUDGET_ENV), so it also declines claims that would have been perfectly safe: a
 * 1.4s `sync_repo_permissions` claimed 80s before the wall clock finishes with 78s to spare, and
 * this budget refuses it anyway, because nothing tells the claim which method it is about to get
 * until after it has got it. On a policy where one isolate keeps taking pokes after its budget is
 * spent, those pokes become no-ops until the runtime retires it. The trade is a wasted poke against
 * a 480s strand, and it is taken knowingly.
 */
export async function drainWithContinuousRefill<T = unknown>(opts: ContinuousRefillOptions<T>): Promise<void> {
  const { run, inFlight, process } = opts;
  // THE LEASE MUST BE ABLE TO SEE THIS SET, and if it cannot, refill is not safe to run.
  //
  // `inFlightCount` is an OPTIONAL option on `beginOrgLeaseRun` that defaults to `() => 0`, and the
  // default is exactly the pre-refill world — correct for `drainBatchAtATime`, silently wrong here.
  // A caller that passes `inFlight` but forgets `inFlightCount` type-checks and runs, and then
  // every single refill safety property is off at once: top-ups go out UNPINNED (the mid-stream
  // rotation the migration exists to close), releases stop being deferred, renewal stops at
  // `finished`, and the idle budget arms mid-stream. The loud backstop that would report it —
  // `captureMessage("orgLeaseRun: claim_org_slot_and_read ignored pin_org")` — is itself gated on
  // `inFlightCount() > 0`, so it cannot fire either. The whole failure is silent, and it presents as
  // a per-org cap that quietly does not hold.
  //
  // So it is refused here rather than defaulted. This is the one wiring mistake the type system
  // cannot catch, because the two halves are separate options on separate calls.
  if (!run.tracksInFlight) {
    throw new Error(
      "drainWithContinuousRefill: the run was built without `inFlightCount`, so it cannot see the " +
        "in-flight set and every refill safety property (pinned top-ups, deferred release, renewal " +
        "past `finished`, the withheld idle budget) would be silently off. Pass " +
        "`inFlightCount: () => inFlight.size` to beginOrgLeaseRun with the SAME Set."
    );
  }
  // AND IT MUST BE THE RUN'S OWN `n`, WHICH THIS ENTRY POINT NOW ENFORCES FOR ITSELF.
  //
  // `drainOrgLease` normalizes this and warns, so production cannot reach the line below. That made
  // the fix look complete and it was not: `drainWithContinuousRefill` is exported, the loop computes
  // its shortfall from `maxInFlight` while `claim()` clamps only each INDIVIDUAL claim to
  // `drainConcurrency`, and the gap between those two is reachable by accumulation. A caller asking
  // for 8 against a run built for 4 gets 4, then 4 more: eight handlers under a slot the allocator
  // budgeted four for, spent against the per-org GitHub limiter this feature exists to respect, with
  // nothing in the slot table to show it. Four against a run built for 8 strands half the allowance
  // instead. Neither is a number anybody chose.
  //
  // THROWN RATHER THAN COERCED, which is the same answer `tracksInFlight` gets ten lines up and for
  // the same reason. Both are wiring mistakes between two options on two separate calls that the
  // types cannot relate, and coercing one of them would mean this function quietly did something
  // other than what its caller asked while `drainOrgLease` -- the caller that actually ships --
  // announces the identical correction in the log. A contract that is enforced in one place and
  // silently rewritten in another is not a contract. Production is unaffected either way: the
  // normalization in `drainOrgLease` runs first and cannot produce a value this rejects.
  //
  // A non-finite value is refused by the same test, so the old NaN note keeps its point: `Math.max(
  // 1, NaN)` is NaN, and a NaN in flight target becomes a NaN `n` on the wire, which PostgREST
  // serializes as `null`, which `claim_org_slot_and_read` answers with a P0001 -- fatal on the FIRST
  // failure by design. That is a deployment error raised for something that is not one.
  if (!Number.isFinite(opts.maxInFlight) || Math.floor(opts.maxInFlight) !== run.drainConcurrency) {
    throw new Error(
      `drainWithContinuousRefill: maxInFlight=${opts.maxInFlight} is not the run's own ` +
        `drainConcurrency=${run.drainConcurrency}. The allocator budgets an org at ` +
        `max_per_org x drainConcurrency handlers, and refill reaches a larger target by ` +
        `accumulation even though one claim is capped, so a mismatch is either unaccounted ` +
        `concurrency or a stranded allowance. Pass the same number to both calls, or use ` +
        `drainOrgLease, which normalizes it.`
    );
  }
  const maxInFlight = Math.floor(opts.maxInFlight);

  /** Never let a reporter's own failure become the thing that takes the isolate down. */
  const report = (e: unknown) => {
    try {
      opts.onError?.(e);
    } catch {
      // Deliberately swallowed. `onError` is Sentry reporting; if reporting is broken there is
      // nowhere left to report that to, and the alternative is strictly worse — see `start`.
    }
  };

  const start = (message: OrgQueueMessage<T>, context: { queueName: string; org: string }) => {
    // THE TRACKED PROMISE MUST NEVER REJECT. It is handed to `Promise.race` and to
    // `Promise.allSettled`, and a rejection that nothing is awaiting at the moment it happens is an
    // unhandled rejection that takes the isolate down with it. `process` is expected to do its own
    // per-message error handling (the worker's `processEnvelope` requeues, DLQs and archives);
    // catching here is the backstop for the case where it does not.
    //
    // The backstop used to call `opts.onError` DIRECTLY from the catch, which left the invariant
    // resting on a callback this module does not own: a throw from the reporter re-rejects the very
    // promise the catch exists to make non-rejecting, and between `start` and the next `settleOne`
    // nothing is attached to it. `report` closes that.
    const tracked: Promise<void> = (async () => {
      try {
        await process(message, context);
      } catch (e) {
        report(e);
      }
    })().finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
  };

  // Resolves when the FIRST in-flight message settles. Every entry has already been made
  // non-rejecting by `start`, and each deletes itself from the set before the promise the race is
  // watching resolves, so the shortfall computed after this is already up to date.
  const settleOne = () => Promise.race([...inFlight]);

  try {
    while (run.shouldContinue()) {
      await run.heartbeat();
      if (!run.shouldContinue()) break;

      const shortfall = maxInFlight - inFlight.size;
      if (shortfall <= 0) {
        await settleOne();
        continue;
      }

      let claimed: OrgClaim | null;
      try {
        claimed = await run.claim(shortfall);
      } catch (e) {
        // The run has already decided whether this failure is fatal; `onError` just backs off.
        report(e);
        await run.onError();
        continue;
      }

      if (claimed) {
        for (const message of claimed.messages) {
          // `org` PER MESSAGE, not per claim. The contract says one claim returns one org's
          // messages, so these agree today — but a future SQL change that returned a mixed batch
          // would mis-tag the run rather than mis-attribute a message, and that is the direction to
          // fail in.
          start(message as OrgQueueMessage<T>, {
            queueName: claimed.queueName,
            org: message.org ?? claimed.org
          });
        }
        continue;
      }

      // Nothing was claimed, and there are three distinct reasons, in the order they matter.
      // `no_capacity` and a fatal claim error both end the run from inside `claim()`; stop claiming
      // now and let the `finally` drain what is already running, rather than spending a completion
      // or an idle sleep first.
      if (!run.shouldContinue()) break;
      // Still draining: this was a top-up that found nothing, not an idle poll. Wait for a slot to
      // free before asking again — this is the anti-spin rule.
      if (inFlight.size > 0) {
        await settleOne();
        continue;
      }
      // Genuinely idle: the existing budget decides whether this isolate stays resident.
      if (!(await run.onIdle())) break;
    }
  } finally {
    // Before `release()`, before the isolate returns. A message whose handler is still running has
    // not been archived yet, and the slot it is running under must still be ours while it does.
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * The ORIGINAL org-leased loop: claim `n`, run all `n`, do not claim again until all `n` settle.
 *
 * Kept as shipped code rather than deleted, because `GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL`
 * is a kill switch and a kill switch whose other branch is a memory is not a kill switch. Until this
 * existed the only way to undo continuous refill was `orgSlotGlobalCap: 0`, which also throws away
 * per-org leaseholders — a feature that is already running in production and is not what anyone
 * would be rolling back.
 *
 * THE ROLLBACK IS TOTAL, not just a different loop, and the mechanism is worth stating because it is
 * what makes the switch trustworthy: this loop never puts anything in `inFlight`, so `inFlightCount()`
 * is identically 0 for the whole run. Every behavior continuous refill added to the lease is keyed
 * on that count being positive — the deferred releases, the renewal that outlives `finished`, the
 * withheld idle budget, the pinned and truncated probe set, and the stream quantum that bounds the
 * pin — so all of them go inert together and
 * what is left is the pre-refill state machine exactly as it was. There is no third configuration in
 * between for someone to land on.
 *
 * `inFlight` is accepted and ignored so both shapes take the same options and the caller does not
 * have to know which one it is asking for. `maxInFlight` is NOT ignored: it is a statement about how
 * much of its slot this leaseholder may use, and a kill switch that also silently changed that
 * number would not be a rollback of the drain SHAPE, it would be a rollback of the shape AND a
 * config change nobody asked for. `claim()` clamps it to `drainConcurrency` anyway, so passing it
 * here is exactly the pre-refill behavior whenever the two agree — which `drainOrgLease` now
 * guarantees they do.
 */
async function drainBatchAtATime<T = unknown>(opts: ContinuousRefillOptions<T>): Promise<void> {
  const { run, process } = opts;
  const perBatch = Number.isFinite(opts.maxInFlight) ? Math.max(1, Math.floor(opts.maxInFlight)) : undefined;
  while (run.shouldContinue()) {
    await run.heartbeat();
    if (!run.shouldContinue()) break;
    try {
      const claimed = await run.claim(perBatch);
      if (!claimed) {
        if (!(await run.onIdle())) break;
        continue;
      }
      await Promise.allSettled(
        claimed.messages.map((message) =>
          // The `.catch` is the one thing here that is not a transcription of the pre-refill loop.
          // It cannot change control flow — `allSettled` already tolerated a rejection — it only
          // routes one to `onError` instead of dropping it, which is what the refill path does and
          // what makes a handler that rejects outright visible on either shape.
          process(message as OrgQueueMessage<T>, {
            queueName: claimed.queueName,
            org: message.org ?? claimed.org
          }).catch((e) => opts.onError?.(e))
        )
      );
    } catch (e) {
      opts.onError?.(e);
      await run.onError();
    }
  }
}

export interface OrgLeaseDrainOptions<T = unknown> extends ContinuousRefillOptions<T> {
  /**
   * `tuning.orgSlots.continuousRefill`, resolved from
   * `GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL` by asyncWorkerTuning.ts. A BOOLEAN that has
   * already been parsed, never the raw env var: that file reads it as a bounded INTEGER (0 or 1)
   * precisely so it cannot fail open the way a string would, since `Boolean("false")` is `true` and
   * the moment a kill switch matters is the moment nobody wants to discover that.
   */
  continuousRefill: boolean;
}

/**
 * Drain a per-org lease in whichever shape the configuration selected.
 *
 * One entry point rather than two exported drivers and a branch at the call site, so that the choice
 * is made in the module that owns both loops and can be tested against both of them — and so there
 * is one place to hold the invariant BOTH shapes depend on and neither can check alone.
 */
export async function drainOrgLease<T = unknown>(opts: OrgLeaseDrainOptions<T>): Promise<void> {
  // THE IN-FLIGHT TARGET AND THE ALLOCATOR'S `n` ARE ONE NUMBER, and until here nothing enforced it.
  // `maxInFlight` is passed to the driver while `drainConcurrency` is passed to `beginOrgLeaseRun`,
  // two arguments on two calls, and the allocator budgets an org at `max_per_org * drainConcurrency`
  // handlers. A larger `maxInFlight` is reachable by ACCUMULATION even though one claim is capped —
  // four, then four more — and the surplus is concurrency the slot table does not know about, spent
  // against the per-org GitHub limiter this whole feature exists to respect. A smaller one strands
  // part of the allowance. Neither is a number anybody chose; both are a wiring slip, so clamp and
  // say so rather than trusting the two call sites to stay in step.
  const n = opts.run.drainConcurrency;
  let maxInFlight = opts.maxInFlight;
  if (!Number.isFinite(maxInFlight) || Math.floor(maxInFlight) !== n) {
    console.warn(
      `[orgLeaseRun] maxInFlight=${opts.maxInFlight} does not match the run's drainConcurrency=${n}; ` +
        `using ${n}. The allocator budgets max_per_org x drainConcurrency handlers per org, so ` +
        `these must be the same number.`
    );
    maxInFlight = n;
  }
  const coherent: OrgLeaseDrainOptions<T> = { ...opts, maxInFlight };
  return coherent.continuousRefill ? await drainWithContinuousRefill(coherent) : await drainBatchAtATime(coherent);
}
