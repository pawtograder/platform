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
  }): Promise<RpcResult<OrgQueueMessage[]>>;
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
   * Claim a slot and read that org's messages. `null` means "nothing to do right now" — either the
   * queues are empty or there is no slot headroom; the two are indistinguishable from here by
   * design, and both are handled the same way. Throws when the RPC itself failed.
   */
  claim(): Promise<OrgClaim | null>;
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

  // The uuid is what makes this unique, and uniqueness is the only property the SQL needs: the
  // holder string is the row identity, so two isolates must never share one. The scope and name
  // prefixes are purely so a human reading the slot table can tell which deployment and which
  // worker a row belongs to. `workerLeaseScope` is reused rather than reimplemented so the two
  // lease systems label a deployment identically.
  const leaseScope = workerLeaseScope(opts.readEnv);
  const holder = `${leaseScope}:${opts.name}:${crypto.randomUUID()}`;

  /**
   * Every queue this run has SENT a claim to — recorded before the call, not after it succeeds,
   * because a claim whose response was lost may still have committed a row we never learned about.
   * Exit releases every one of them; there are at most `queueNames.length` (two today).
   */
  const touchedQueues = new Set<string>();

  opts.scope?.setTag("worker_run_mode", "org_leased");
  opts.scope?.setTag("worker_lease_scope", leaseScope);
  opts.scope?.setTag("org_slot_holder", holder);

  /** The run is over. Set by a lost slot, a spent idle budget, a stall, or a dead RPC. */
  let finished = false;
  /** We believe the server has a slot row for us. Only ever set from a claim that returned rows. */
  let held = false;
  let heldOrgValue: string | null = null;
  /** Which pool the held slot is in, and therefore which holder id renewal must target. */
  let heldQueueName: string | null = null;
  let lastRenewAt = now();
  /** Last time the LOOP called in. Distinct from `lastRenewAt`, which the timer also moves. */
  let lastProgressAt = now();
  /** Set on the first idle poll, cleared whenever work is found. */
  let idleDeadline: number | null = null;
  let consecutiveClaimErrors = 0;
  /**
   * Set when the claim RPC failed in a way retrying cannot fix: the function is missing (deploy
   * skew) or the server rejected the call outright (unseeded slot pool, bad argument). Doubles as
   * the Sentry tag value.
   */
  let fatalClaimError: "rpc_missing" | "claim_rejected" | null = null;

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
    stopRenewTimer();
    for (const queueName of [...touchedQueues]) {
      await releaseQueue(queueName, reason);
    }
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
    if (finished || !held || heldQueueName === null) return;

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

    try {
      // THE HELD QUEUE, never "all of them". If this run also has a lease in the other pool — a
      // rotation whose eager release did not land — that lease is meant to LAPSE, and renewing it
      // here would resurrect it on every heartbeat and pin an org nobody is draining.
      const res = await opts.rpc.renew({
        queue_name: heldQueueName,
        holder,
        lease_ttl_seconds: ttlSeconds
      });
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

  const claimOnce = async (queueName: string): Promise<OrgQueueMessage[]> => {
    let res: RpcResult<OrgQueueMessage[]>;
    // Recorded BEFORE the call, not after it succeeds: a claim whose response never arrives may
    // still have committed a row, and exit has to be able to clean that up.
    touchedQueues.add(queueName);
    try {
      res = await opts.rpc.claim({
        queue_name: queueName,
        sleep_seconds: opts.visibilityTimeoutSeconds,
        n: opts.drainConcurrency,
        holder,
        lease_ttl_seconds: ttlSeconds,
        max_per_org: opts.maxPerOrg,
        global_cap: opts.globalCap
      });
    } catch (e) {
      throw new OrgClaimError(e instanceof Error ? e.message : String(e), queueName);
    }
    if (res.error) {
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
    return res.data ?? [];
  };

  return {
    mode: "org_leased",
    holder,
    heldOrg: () => heldOrgValue,
    heldQueue: () => heldQueueName,
    shouldContinue: () => !finished,

    claim: async () => {
      if (finished) return null;
      markProgress();

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
      for (const queueName of opts.queueNames) {
        let rows: OrgQueueMessage[];
        try {
          rows = await claimOnce(queueName);
        } catch (e) {
          consecutiveClaimErrors++;
          if (fatalClaimError !== null || consecutiveClaimErrors >= maxClaimErrors) {
            finished = true;
            opts.scope?.setTag("org_slot", fatalClaimError ?? "claim_failed");
            // Whatever slot we may hold is useless to an isolate that is giving up. Best effort;
            // the TTL covers it if this fails too.
            await releaseSlot("claim_failed");
          }
          throw e;
        }

        if (rows.length === 0) continue;

        const previousQueue = heldQueueName;
        consecutiveClaimErrors = 0;
        idleDeadline = null;
        held = true;
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
        if (previousQueue !== null && previousQueue !== queueName) {
          await releaseQueue(previousQueue, "rotated");
        }
        return { org: heldOrgValue, queueName, messages: rows };
      }

      // Zero rows everywhere means no slot was claimed — and, importantly, that the slot we were
      // already holding was NOT touched either: the SQL only writes the slot row when an org
      // qualifies, so a holder that stops finding work keeps a live lease until its TTL unless it
      // says otherwise. Releasing here is what keeps "holds a slot" and "is draining" from drifting
      // apart, and it returns the org's headroom to the fleet now rather than in up to one TTL.
      if (held) await releaseSlot("no_work");
      idleDeadline ??= now() + idleBudget;
      return null;
    },

    heartbeat: async () => {
      // Mark progress BEFORE renewing, or the renewal would judge this very call as the stall.
      markProgress();
      if (held && now() - lastRenewAt >= renewEvery) await renew();
    },

    onIdle: async () => {
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
