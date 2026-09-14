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
 *     optimisation on top of that, not the thing that makes it correct.
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
 * against 8 configured, and the loss factorises exactly:
 *
 *     configured (orgSlotMaxPerOrg 2 x drainConcurrency 4)   8.00
 *   x leaseholder residency (~1.8 of 2 slots resident)       7.20
 *   x within-batch utilisation                               5.26   <- measured 5.20
 *
 * Reconstructed from `pgmq.a_async_calls` (`vt - 480s` is the read time, `archived_at` the finish):
 * 47 batches of exactly 4, mean message duration 48.4s, mean batch duration 68.4s. 48.4/68.4 = 0.71,
 * so roughly 27% of every slot-second was a claimed slot waiting on its batch-mates. Sampling
 * in-flight count every 30s showed the sawtooth this predicts: 8, then 1-2, then 8 again.
 *
 * `drainWithContinuousRefill` below keeps `n` messages in flight instead: as each message settles,
 * the SHORTFALL is claimed rather than the whole batch re-read. The sawtooth flattens, and the
 * 0.73 term goes to ~1.
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
 *      left, and those stop being counted: that org reaches `max_per_org x n + (n-1)` = 11 against
 *      a configured 8. Landing on a different QUEUE loses the same count a level up, by releasing
 *      the pool the in-flight messages were claimed under. So a top-up carries `pin_org` and probes
 *      only the held queue; a claim issued with nothing in flight is unpinned and probes everything
 *      in priority order, because that is the moment when rotating is free. Preemption is bought
 *      back by streaming ONLY the highest-priority queue — see `claim()`.
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
     * `claimOnce` degrades the top-ups to batch-and-wait. `pin_org` has a server-side DEFAULT, so
     * the other skew direction (new database, old image) needs nothing.
     *
     * Case does not matter: the allocator's org expression is already `lower(...)` and the server
     * normalises this the same way, so any `org` a previous claim returned can be passed back
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
  /** The org whose slot is currently held, or null when this run holds none. */
  heldOrg(): string | null;
  /** Which queue's pool the held slot is in, or null when this run holds none. */
  heldQueue(): string | null;
  /** False once the slot is lost, the idle budget is spent, or the run gave up on the RPC. */
  shouldContinue(): boolean;
  /**
   * Claim a slot and read that org's messages.
   *
   * `null` means nothing was claimed, and the two reasons are NOT equivalent any more — check
   * `shouldContinue()` afterwards. `no_demand` on every queue leaves the run alive and idling;
   * `no_capacity` ENDS it, because the fleet is already at its configured concurrency and this
   * isolate cannot add throughput, only occupancy. Throws when the RPC itself failed.
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
 * PostgREST's "no such function" code. This is the deploy-skew signature: the worker image can
 * reach a database whose migration has not been applied yet, and no amount of retrying fixes that,
 * so it ends the run immediately instead of spending `maxConsecutiveClaimErrors` isolates on it.
 * Recognising it is an optimisation, not a correctness requirement — if the code ever changes, the
 * consecutive-error cap still bounds the damage.
 */
const PGRST_UNDEFINED_FUNCTION = "PGRST202";
/**
 * SQLSTATE for a plpgsql `raise exception`. `claim_org_slot_and_read` uses it for an unseeded slot
 * pool on the requested queue and for arguments it refuses — all of them permanent. See the handling
 * in `claimOnce` for why matching the SQLSTATE beats matching the message text.
 */
const PG_RAISE_EXCEPTION = "P0001";

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
 * fused with the first read, so this function performs no I/O and cannot fail. Making it `async`
 * for symmetry would imply a begin-time acquire that does not exist.
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

  /** The run is over. Set by a lost slot, a spent idle budget, a stall, or a dead RPC. */
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
        // every later top-up skips the RPC entirely, so an un-migrated database gets batch-and-wait
        // behaviour at the cost of exactly one wasted round trip per run, with no lost messages, no
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

    // Nothing was claimed here, and the server has told us so definitively — so unlike the
    // lost-response case, we KNOW no row was committed for us on this call. Drop the queue from the
    // release-on-exit set, but only if an EARLIER claim did not already take a slot here: that row
    // is untouched by a claim that finds nothing, and it is still ours to give back.
    if (!claimedQueues.has(queueName)) touchedQueues.delete(queueName);

    // An unrecognised or absent status resolves to `no_demand`, which is what zero rows meant before
    // the status column existed. That is the conservative reading: it advances to the next queue
    // exactly as the old code did, where reading it as `no_capacity` would stop a worker draining
    // against a database that simply has not been migrated yet.
    return { status: rows[0]?.status === "no_capacity" ? "no_capacity" : "no_demand", messages: [] };
  };

  return {
    mode: "org_leased",
    holder,
    heldOrg: () => heldOrgValue,
    heldQueue: () => heldQueueName,
    lastOutcome: () => lastClaimOutcome,
    shouldContinue: () => !finished,

    claim: async (maxMessages?: number) => {
      if (finished) return null;
      markProgress();

      // `drainConcurrency` REMAINS THE CEILING. A refill caller asks for the shortfall, and asking
      // for more than the ceiling — or for zero, which can only come back `no_demand` — is a caller
      // bug that should not reach the RPC. Clamping rather than throwing because this is a hot path
      // and the safe value is obvious.
      const n = Math.max(1, Math.min(opts.drainConcurrency, Math.floor(maxMessages ?? opts.drainConcurrency)));

      // A TOP-UP MAY ONLY EXTEND WHAT THIS RUN IS ALREADY DOING: same org, same queue, or no claim
      // at all. A claim issued with nothing in flight is unchanged — every queue in priority order,
      // unpinned, free to rotate onto whichever org is neediest — because that is the moment when
      // rotating costs nothing.
      //
      // WHY THE PIN. `claim_org_slot_and_read` re-points THIS HOLDER'S slot row at whichever org it
      // picks, and an unpinned top-up picks the neediest org, not ours. Mid-stream that means the
      // slot table stops counting the `n-1` messages still running for the org we just left, so that
      // org can reach `max_per_org x n + (n-1)` = 11 against a configured 8. The per-org cap is the
      // invariant this entire feature exists to hold, so a top-up names its org and the allocator
      // either serves it or says no.
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
      // pays batch-and-wait's ~27%; urgent work does not, and a low-priority stream can no longer
      // outlive a main-queue backlog. The alternative (probe `async_calls` unpinned mid-stream)
      // reopens the rotation hazard in the name of preempting sooner, which is the trade that was
      // just rejected.
      const draining = inFlightCount() > 0;
      let pinOrg: string | undefined;
      let probeQueues: readonly string[] = opts.queueNames;
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
        probeQueues = [heldQueueName];
        pinOrg = heldOrgValue;
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
          // Whatever slot we held is one this pass did not renew our claim on, and the org we were
          // draining evidently has no more ready work; give it back rather than pin it — unless
          // messages claimed under it are still running, in which case the run ends but the slot,
          // and its renewals, stay ours until the driver has drained them.
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
        // of defence on the invariant this whole module exists for.
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
  /** Messages to keep in flight. Normally the run's `drainConcurrency`, which caps claims anyway. */
  maxInFlight: number;
  process: RefillProcessor<T>;
  /** Reports a claim-RPC failure, or a `process` that rejected. Must not throw. */
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
 *     GLOBAL `pg_advisory_xact_lock` — one key for all queues, see the migration — so claim traffic
 *     is a shared resource and not a private one. Refill raises it from one claim per BATCH to one
 *     per MESSAGE (~4x at n=4: the 190-message burst becomes ~190 claims over 29 minutes rather
 *     than 47, i.e. ~0.66/s fleet-wide at `globalCap: 8` against a measured ceiling around 288/s).
 *     Claiming one message at a time regardless of the shortfall would multiply that again for no
 *     throughput at all. Messages that settle together coalesce for free: each one removes itself
 *     from `inFlight` as it settles, so by the time the race below resumes, the shortfall already
 *     counts every message that finished in the same tick.
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
 * NO GRACEFUL DRAIN AHEAD OF ISOLATE RETIREMENT. `beforeUnload.wallClockRatio: 50` retires the
 * isolate at about half `EDGE_WORKER_TIMEOUT_MS`, and under refill that lands mid-stream with `n`
 * messages in flight, which are redelivered when their visibility timeout expires. Refill does make
 * the ABSOLUTE number worse — mean in-flight goes from the measured 5.2 to 8 — but it does not make
 * the RATE worse, and the rate is what costs anything. By Little's law the messages orphaned per
 * retirement are `throughput x mean duration` and the messages COMPLETED per isolate lifetime are
 * `throughput x lifetime`, so their ratio is `mean duration / lifetime` — 48.4/240 either way, with
 * throughput cancelling. Draining ahead of retirement would fix the absolute number and cost more
 * than it saves: stopping claims one worst-case message (94.8s) before the horizon idles the tail of
 * every isolate and gives back about 20% of capacity, against roughly 10% of work wasted by letting
 * the orphans be redelivered (`n x` half a mean duration out of `n x` the lifetime). The cheap
 * improvement is not here at all — it is a visibility timeout that reflects a per-message claim, so
 * an orphan waits ~120s rather than ~480s to be re-served. That file has another owner.
 */
export async function drainWithContinuousRefill<T = unknown>(opts: ContinuousRefillOptions<T>): Promise<void> {
  const { run, inFlight, process } = opts;
  const maxInFlight = Math.max(1, Math.floor(opts.maxInFlight));

  const start = (message: OrgQueueMessage<T>, context: { queueName: string; org: string }) => {
    // THE TRACKED PROMISE MUST NEVER REJECT. It is handed to `Promise.race` and to
    // `Promise.allSettled`, and a rejection that nothing is awaiting at the moment it happens is an
    // unhandled rejection that takes the isolate down with it. `process` is expected to do its own
    // per-message error handling (the worker's `processEnvelope` requeues, DLQs and archives);
    // catching here is the backstop for the case where it does not.
    const tracked: Promise<void> = (async () => {
      try {
        await process(message, context);
      } catch (e) {
        opts.onError?.(e);
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
        opts.onError?.(e);
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
 * is identically 0 for the whole run. Every behaviour continuous refill added to the lease is keyed
 * on that count being positive — the deferred releases, the renewal that outlives `finished`, the
 * withheld idle budget, the pinned and truncated probe set — so all of them go inert together and
 * what is left is the pre-refill state machine exactly as it was. There is no third configuration in
 * between for someone to land on.
 *
 * `inFlight` is accepted and ignored so both shapes take the same options and the caller does not
 * have to know which one it is asking for.
 */
async function drainBatchAtATime<T = unknown>(opts: ContinuousRefillOptions<T>): Promise<void> {
  const { run, process } = opts;
  while (run.shouldContinue()) {
    await run.heartbeat();
    if (!run.shouldContinue()) break;
    try {
      const claimed = await run.claim();
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
 * is made in the module that owns both loops and can be tested against both of them.
 */
export async function drainOrgLease<T = unknown>(opts: OrgLeaseDrainOptions<T>): Promise<void> {
  return opts.continuousRefill ? await drainWithContinuousRefill(opts) : await drainBatchAtATime(opts);
}
