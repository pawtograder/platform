import * as Sentry from "npm:@sentry/deno";
import { createRedis, type RedisClient } from "./Redis.ts";
import { type EnvReader } from "./SentryContext.ts";

/**
 * Lifecycle for the pg_cron-poked background workers.
 *
 * ## The problem this exists to solve
 *
 * Each worker used a module-level `let started = false` to stop a second poll loop being parked on
 * the same isolate. That guard only works if the isolate is REUSED between requests, which is what
 * `edgeFunctions.policy: per_worker` does. Every deployed values file
 * (values-prod, values-prod-noeso, values-staging) sets `policy: per_request` instead, chosen
 * deliberately so a burst cannot pile concurrent requests onto one shared V8 heap.
 *
 * Under `per_request` every poke gets a FRESH isolate, so `started` is always `false` on arrival
 * and the guard can never fire. Each poke therefore parked another infinite loop under
 * `waitUntil`, and an infinite loop holds its isolate — and one of the `maxParallelism` admission
 * slots — until the runtime retires it at `worker.timeoutMs` (400s, with beforeUnload at 50% of
 * that). At one poke per 30s that is ~7 concurrent loops per worker steady-state, ~13 at the hard
 * limit, across four workers, against `maxParallelism: 8`. The edge tier ran out of slots as a
 * function of uptime rather than load.
 *
 * ## What actually needed protecting
 *
 * Not correctness. `pgmq_public.read` sets `vt = now() + sleep_seconds` on every message it
 * returns, so two concurrent workers cannot be handed the same message — the queue is already the
 * mutual exclusion. The guard was only ever protecting RESOURCES. That is why this module offers
 * these shapes and all of them are safe:
 *
 *   - **leased** (Redis configured): one long-lived drainer per deployment, holding a Redis lease
 *     it renews for as long as its loop keeps going round. Lowest latency, because the loop stays
 *     resident and polls on its own idle interval. Costs one admission slot per worker for the
 *     isolate's life.
 *
 *   - **idle** (Redis configured, someone else holds the lease): does nothing and returns. Safe
 *     because a holder that stops making progress gives the lease up — see `maxStallMs` — so "hold
 *     the lease" and "is draining" cannot drift apart for long.
 *
 *   - **bounded** (no Redis): the poke drains until the queue is idle or a wall-clock budget
 *     expires, then RETURNS, releasing the isolate and its slot. Cannot accumulate loops no matter
 *     how the isolates are scheduled, because there is no loop left running to accumulate. Costs
 *     idle latency: new work waits for the next cron poke rather than the loop's 10–15s poll.
 *
 * ## The trade-off, stated plainly
 *
 * Leased mode is better for latency and worse for slot occupancy; bounded mode is the reverse.
 * Bounded is the fallback rather than the default only because the deployed configuration does
 * have Redis, and losing sub-minute email/gradebook latency across the board would be a real
 * regression. Bounded mode is not a degraded mode in the safety sense — it is strictly the safer
 * of the two, and it is what runs whenever `REDIS_URL` / `UPSTASH_*` are absent, when Redis is
 * unreachable, or when acquiring the lease errors. Failing toward bounded is deliberate: the
 * failure mode of guessing wrong is "slower", never "another unbounded loop".
 *
 * A third option was rejected: reverting `policy` to `per_worker` would make the old guard correct
 * with no code change, but it reintroduces exactly the shared-heap pile-up under bursts that
 * `per_request` was chosen to avoid (see the `policy` comment in charts/pawtograder/values.yaml).
 *
 * ## The lease is scoped to a deployment, not to a worker name
 *
 * A lease that bounds loops "across the whole fleet" is only meaningful if the fleet is one
 * deployment, and this Redis is emphatically not one deployment. Previews, staging and production
 * all set `redis.provider: shared`, and CI's e2e job gets the same `UPSTASH_*` secrets in its
 * `.env.local`. That sharing is deliberate and must stay: those deployments also share one set of
 * GitHub App credentials, so they share one GitHub API quota, and the Bottleneck limiters in
 * `Redis.ts` can only honour that quota if every deployment coordinates through the same keys.
 *
 * So the rule is per-key, not per-instance. State about a shared EXTERNAL resource (rate limits)
 * belongs in a shared key. State about one deployment's own edge tier — which is all this lease is —
 * must be scoped, or a preview starves staging. See `workerLeaseScope`.
 */

/** Default lease lifetime. Comfortably longer than the heartbeat interval, short enough that an
 * isolate killed mid-loop frees the lease within about one cron period. */
const DEFAULT_LEASE_TTL_MS = 60_000;
/** Renew at a third of the TTL, so two consecutive renewal failures still leave time to recover. */
const HEARTBEAT_DIVISOR = 3;
/**
 * Wall-clock budget for a bounded run. Well inside the ~200s at which `beforeUnload.wallClockRatio`
 * retires the isolate, so a bounded run ends on its own terms rather than being cut off mid-batch.
 */
const DEFAULT_BOUNDED_BUDGET_MS = 50_000;
/**
 * How long the loop may go without calling into this run before the holder gives up its lease.
 *
 * Generous by default, because a batch that legitimately takes minutes is normal for the GitHub and
 * Discord workers (`sync_repo_to_handout` is the documented case). Workers whose batches are
 * milliseconds should set this far lower; the value is the ceiling on how long a stalled holder can
 * keep the queue to itself.
 */
const DEFAULT_MAX_STALL_MS = 15 * 60_000;
/** `DEPLOY_KIND` for the CI e2e job. The only deployment kind with no k8s rollout behind it. */
const E2E_LOCAL_KIND = "e2e-local";

/**
 * Renew ONLY if the key still holds our token, atomically.
 *
 * `SET key token PX ttl XX` is not sufficient and was the original bug: XX asserts only that the
 * key EXISTS, never that its value is ours. Once our lease had expired and another isolate had
 * taken the key, our renewal happily overwrote their token and left us believing we still held it
 * -- so both loops continued, each stomping the other, which is precisely the accumulation the
 * lease exists to prevent.
 *
 * `eval(script, keys[], args[])` is portable here: the ioredis compat proxy in Redis.ts translates
 * that array form into ioredis's positional form, and the Upstash client takes it natively.
 */
const RENEW_IF_OWNED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

/** Release only if the key still holds our token, atomically. */
const RELEASE_IF_OWNED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

export type WorkerRunMode = "leased" | "bounded" | "idle";

export interface WorkerRun {
  readonly mode: WorkerRunMode;
  /**
   * False once the lease is lost (leased), the budget is spent (bounded), or immediately (idle) —
   * so a caller's `while (run.shouldContinue())` is the one place that has to know the difference.
   */
  shouldContinue(): boolean;
  /** Call once per loop iteration. Renews the lease when due; marks the run finished if it is lost. */
  heartbeat(): Promise<void>;
  /** Called when a batch found no work. Returns whether to keep looping. */
  onIdle(): Promise<boolean>;
  /** Called after a batch threw, to back off. */
  onError(): Promise<void>;
  /** Best-effort lease release. TTL expiry is the real safety net. */
  release(): Promise<void>;
}

export interface BeginWorkerRunOptions {
  /** Stable worker identity; becomes part of the Redis key. */
  name: string;
  scope?: Sentry.Scope;
  /** Reads deployment identity for the lease key. Injectable so tests need no process env. */
  readEnv?: EnvReader;
  /** How long to sleep when a batch found no work (leased mode only). */
  idleSleepMs: number;
  /** How long to sleep after a batch threw. */
  errorSleepMs: number;
  leaseTtlMs?: number;
  /** How long the loop may go silent before the holder stops renewing. See DEFAULT_MAX_STALL_MS. */
  maxStallMs?: number;
  /**
   * Skip the lease entirely and always drain-and-exit.
   *
   * For a worker whose batches are milliseconds, this is simply the better mode. The lease exists to
   * stop long-lived resident loops accumulating; a run that drains in milliseconds and returns has
   * nothing to accumulate, holds no admission slot between pokes, and cannot be starved by another
   * poke's lease. It also restores the property the direct pokes were written for -- a gradebook
   * mutation pokes the worker and the work starts now, rather than whenever the holder next looks.
   * Measured on the gradebook specs: 1.2 minutes bounded against 7.2 minutes leased, because a
   * resident loop under `waitUntil` is not reliably scheduled between requests.
   */
  preferBounded?: boolean;
  boundedBudgetMs?: number;
  /** Test seams. */
  redis?: RedisClient | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Timer seams, so tests drive renewal deterministically instead of on the wall clock. */
  setIntervalFn?: (cb: () => void, ms: number) => number;
  clearIntervalFn?: (handle: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const denoEnv: EnvReader = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    // --allow-env not granted. A missing scope is not fatal; it only makes the key less specific.
    return undefined;
  }
};

/** FNV-1a, base36. Not security; just enough to keep a lossy rewrite from merging two scopes. */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Redis keys are opaque bytes, but a key you cannot paste into redis-cli is a key you cannot debug.
 *
 * Collapsing every run of invalid characters to `-` is lossy, and lossy is exactly the wrong
 * property here: `feat/foo` and `feat-foo` would land on one key, which is the cross-deployment
 * collision this module is fixing, reintroduced by the sanitizer. So when the rewrite changed
 * anything, a hash of the ORIGINAL is appended and the mapping stays injective. Values that were
 * already key-safe -- which is every value in practice, since the scope is built from a
 * chart-validated environment name and some integers -- are untouched, so the common key stays
 * readable.
 */
function sanitizeKeySegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return safe === value ? safe : `${safe}~${shortHash(value)}`;
}

/**
 * Which deployment this lease belongs to.
 *
 * The lease bounds resident drainer loops **within one edge tier**, and nothing more. The key was a
 * bare worker name, so every deployment on the shared Redis shared one lease. One CI run's worker
 * could hold `pawtograder:worker-lease:gradebook_column_recalculate` while a *different* run's
 * worker, against a different database, was turned away by it -- and two concurrent e2e jobs is the
 * normal case on the `pawtograder-e2e` runner pool. The starved job's gradebook queue simply stopped
 * draining: 2,285 "another handler holds the lease" lines and not one completed run, so the
 * recalculated scores the gradebook specs wait on never landed and they failed on the 90s poll. A PR
 * preview could do the same thing to staging.
 *
 * Resolution order:
 *   - `WORKER_LEASE_SCOPE`, for anything that needs to say so explicitly;
 *   - otherwise `ENVIRONMENT`/`DEPLOY_KIND` (the identity `SentryContext.ts` already established),
 *     narrowed by `DEPLOY_PR` so two preview namespaces do not collide on "preview".
 *
 * The scope has to be stable for the LIFE OF A DEPLOYMENT, not per deploy. `DEPLOY_RUN_ID` is
 * tempting -- it is the only thing that separates two CI e2e runs, which have no other identity --
 * but `preview.yml` passes `global.deploy.runId` on every helm upgrade, so keying on it would give
 * each preview redeploy a fresh set of keys. During the chart's rolling update (`maxSurge: 1`,
 * `maxUnavailable: 0`, up to 410s of graceful drain) the outgoing and incoming pods would then hold
 * resident leases under different keys, and the within-deployment bound would be off for the whole
 * rollout. So run identity is added only for `e2e-local`, the one kind with no k8s rollout behind
 * it, where each run genuinely is its own throwaway deployment with its own database.
 *
 * Production stays a single `production` scope, and a preview stays `preview:pr-<n>` across
 * redeploys, which is the whole point: within one deployment the fleet SHOULD share one lease.
 */
export function workerLeaseScope(readEnv: EnvReader = denoEnv): string {
  const value = (key: string): string | undefined => {
    const trimmed = readEnv(key)?.trim();
    return trimmed ? trimmed : undefined;
  };

  const explicit = value("WORKER_LEASE_SCOPE");
  if (explicit) return sanitizeKeySegment(explicit);

  const kind = value("ENVIRONMENT") ?? value("DEPLOY_KIND") ?? "development";
  const parts = [kind];

  const pr = value("DEPLOY_PR");
  if (pr) parts.push(`pr-${pr}`);

  if (kind === E2E_LOCAL_KIND) {
    const runId = value("DEPLOY_RUN_ID");
    if (runId) {
      const attempt = value("DEPLOY_RUN_ATTEMPT");
      parts.push(attempt ? `run-${runId}-${attempt}` : `run-${runId}`);
    }
  }

  return parts.map(sanitizeKeySegment).join(":");
}

function leaseKey(name: string, scope: string): string {
  return `pawtograder:worker-lease:${scope}:${name}`;
}

/**
 * Decide how this poke should run the worker loop. Never throws, and always returns a run: any Redis
 * problem, and a lease already held elsewhere, both degrade to a bounded run.
 *
 * Losing the race for the lease used to mean returning `null` — "the holder is draining, so do
 * nothing". That is only true while the holder is actually draining, and the lease cannot tell.
 * `renew` fires on its own interval precisely so a slow batch keeps the lease, which means liveness
 * of the KEY is independent of progress of the LOOP: an isolate that the runtime suspends, or one
 * parked on an await that never settles, keeps its lease renewed while doing nothing, and every
 * other poke is turned away for as long as that lasts. Measured locally: a 106-second window with
 * the key held, 425 pokes refused, and not one batch processed — longer than the 60s TTL, so it was
 * not even a matter of waiting for expiry.
 *
 * The fix belongs on the holder, not on the losers. Two shapes were tried on the loser side first
 * and both were wrong: letting every loser drain re-creates the admission-slot exhaustion from the
 * other direction, and rationing them through a small pool of TTL keys cannot work either, because
 * one key cannot be both a semaphore for live helpers (wants a long TTL, or a batch outliving it
 * lets a second helper in, repeatedly, for the length of the batch) and a self-healing lock for
 * dead ones (wants a short TTL). So a loser does nothing, as it always did — and instead the HOLDER
 * gives the lease up when it stops making progress.
 *
 * `heartbeat`, `onIdle` and `onError` are all called by the loop, so any of them is proof the loop
 * is alive. If none is called for `maxStallMs`, renewal stops and the lease lapses at the TTL, and
 * the next poke becomes the holder. That covers every way a holder goes quiet: a killed isolate
 * stops its timer, a suspended one stops its timer, and one parked on a promise that never settles
 * keeps its timer but stops calling us, which the stall check catches. A batch that is merely SLOW
 * keeps the lease as long as `maxStallMs` allows for it, which is why the default is generous and
 * the fast workers narrow it.
 */
export async function beginWorkerRun(opts: BeginWorkerRunOptions): Promise<WorkerRun> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const budget = opts.boundedBudgetMs ?? DEFAULT_BOUNDED_BUDGET_MS;
  const leaseScope = workerLeaseScope(opts.readEnv);
  const key = leaseKey(opts.name, leaseScope);
  opts.scope?.setTag("worker_lease_scope", leaseScope);

  // `undefined` means "not injected, go and build one"; an explicit `null` means "no Redis", which
  // is what the tests and the no-Redis deployments both exercise. Skipped entirely when the caller
  // has opted out of the lease: ioredis connects on construction, and a per-request isolate that
  // will never look at Redis should not open a connection to it.
  let redis: RedisClient | null = null;
  if (opts.redis !== undefined) {
    redis = opts.redis;
  } else if (!opts.preferBounded) {
    try {
      redis = createRedis();
    } catch (e) {
      // Constructing the client should not be able to throw, but a bad REDIS_URL can. Bounded mode
      // is safe, so this must not take the worker down.
      redis = null;
      opts.scope?.setTag("worker_lease", "redis_unavailable");
      Sentry.captureException(e, opts.scope);
    }
  }

  const boundedRun = (reason: string): WorkerRun => {
    const deadline = now() + budget;
    opts.scope?.setTag("worker_run_mode", "bounded");
    opts.scope?.setTag("worker_bounded_reason", reason);
    return {
      mode: "bounded",
      shouldContinue: () => now() < deadline,
      heartbeat: () => Promise.resolve(),
      // Exit as soon as the queue is idle. Holding the isolate to sleep would be the very thing
      // bounded mode exists to avoid; the next cron poke picks up whatever arrives meanwhile.
      onIdle: () => Promise.resolve(false),
      onError: async () => {
        if (now() < deadline) await sleep(opts.errorSleepMs);
      },
      release: () => Promise.resolve()
    };
  };

  /** A poke with nothing to do: the lease is held and the helper pool is full. */
  const idleRun = (reason: string): WorkerRun => {
    opts.scope?.setTag("worker_run_mode", "idle");
    opts.scope?.setTag("worker_idle_reason", reason);
    return {
      mode: "idle",
      shouldContinue: () => false,
      heartbeat: () => Promise.resolve(),
      onIdle: () => Promise.resolve(false),
      onError: () => Promise.resolve(),
      release: () => Promise.resolve()
    };
  };

  if (opts.preferBounded) {
    return boundedRun("prefer_bounded");
  }

  if (!redis) {
    return boundedRun("no_redis_configured");
  }

  // Unique per run, so a renewal or release can tell "still mine" from "someone else's".
  const token = crypto.randomUUID();
  let acquired = false;
  try {
    const result = await redis.set(key, token, { px: ttl, nx: true });
    // ioredis returns "OK" or null; the Upstash REST client returns "OK" or null too.
    acquired = result !== null && result !== undefined && result !== 0;
  } catch (e) {
    opts.scope?.setTag("worker_lease", "acquire_failed");
    Sentry.captureException(e, opts.scope);
    return boundedRun("lease_acquire_failed");
  }

  if (!acquired) {
    // Someone else is draining, so do nothing -- and rely on the stall check below to make that
    // statement true, rather than assuming it.
    return idleRun("lease_held_elsewhere");
  }

  opts.scope?.setTag("worker_run_mode", "leased");
  let lost = false;
  let lastHeartbeat = now();
  /** Last time the LOOP called in. Distinct from `lastHeartbeat`, which the timer also moves. */
  let lastProgressAt = now();
  const maxStall = opts.maxStallMs ?? DEFAULT_MAX_STALL_MS;
  const markProgress = () => {
    lastProgressAt = now();
  };
  const heartbeatEvery = Math.max(1, Math.floor(ttl / HEARTBEAT_DIVISOR));
  const setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms) as unknown as number);
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: number) => clearInterval(h));
  let renewTimer: number | undefined;
  const stopRenewTimer = () => {
    if (renewTimer !== undefined) {
      clearIntervalFn(renewTimer);
      renewTimer = undefined;
    }
  };

  const renew = async (): Promise<void> => {
    if (lost) return;
    // Renewal is a claim that this worker is still draining. Only the loop can support that claim,
    // and the timer fires whether or not it is true -- which is how a holder parked on a promise
    // that never settles kept the lease renewed while processing nothing, and turned every other
    // poke away for as long as it lasted. Stop renewing and let the key lapse; the next poke takes
    // over. Do NOT delete it here: it may already belong to that next holder.
    if (now() - lastProgressAt > maxStall) {
      lost = true;
      stopRenewTimer();
      opts.scope?.setTag("worker_lease", "stalled");
      console.warn(
        `[workerRun] ${opts.name}: no loop progress for ${now() - lastProgressAt}ms (max ${maxStall}ms), giving up the lease`
      );
      return;
    }
    try {
      // Compare-and-PEXPIRE, not `SET ... XX` -- see RENEW_IF_OWNED. A 0 means the key is no
      // longer ours (expired and retaken, or deleted), which must stop this loop rather than
      // reclaim it: reclaiming is how two loops end up alternating ownership indefinitely.
      const result = await redis.eval(RENEW_IF_OWNED, [key], [token, String(ttl)]);
      if (Number(result) !== 1) {
        lost = true;
        stopRenewTimer();
        opts.scope?.setTag("worker_lease", "lost");
        console.warn(`[workerRun] ${opts.name}: lease is no longer ours, stopping this loop`);
      }
    } catch (e) {
      // Treat an unreachable Redis as a lost lease. Continuing without a renewable lease is how a
      // second loop would appear elsewhere in the fleet, which is the thing being prevented.
      lost = true;
      stopRenewTimer();
      opts.scope?.setTag("worker_lease", "renew_failed");
      Sentry.captureException(e, opts.scope);
    }
    lastHeartbeat = now();
  };

  // Renew on an INDEPENDENT timer, not only between batches.
  //
  // The loop awaits `processBatch`, and some batches are genuinely long -- github-async-worker's
  // `sync_repo_to_handout` can run for minutes against a 60s TTL. A heartbeat that only fires
  // between iterations therefore lets the lease expire mid-batch, another poke acquires it, and the
  // admission-slot exhaustion this lease was added to prevent comes back for any workload with slow
  // batches. The timer keeps renewing while the batch is in flight; `heartbeat()` remains as a
  // cheap belt-and-braces check for callers that drive time themselves (the tests do).
  //
  // What the timer must NOT do is renew forever on behalf of a loop that has stopped going round,
  // which is why `renew` consults `lastProgressAt` first.
  renewTimer = setIntervalFn(() => {
    void renew();
  }, heartbeatEvery);

  return {
    mode: "leased",
    shouldContinue: () => !lost,
    // All three are called by the loop, so each is proof it is still going round. Mark progress
    // BEFORE renewing, or the renewal would judge this very call as the stall.
    heartbeat: async () => {
      markProgress();
      if (now() - lastHeartbeat >= heartbeatEvery) await renew();
    },
    onIdle: async () => {
      await sleep(opts.idleSleepMs);
      markProgress();
      await renew();
      return !lost;
    },
    onError: async () => {
      await sleep(opts.errorSleepMs);
      markProgress();
      await renew();
    },
    release: async () => {
      stopRenewTimer();
      if (lost) return;
      try {
        // Atomic compare-and-delete, so a lease that expired and was retaken by another isolate is
        // never deleted out from under its new owner. TTL expiry remains the backstop if this
        // isolate dies without running finally.
        await redis.eval(RELEASE_IF_OWNED, [key], [token]);
      } catch (e) {
        // The lease expires on its own; a failed release is not worth failing the run over.
        opts.scope?.setTag("worker_lease", "release_failed");
        Sentry.captureException(e, opts.scope);
      }
    }
  };
}
