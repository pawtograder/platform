import * as Sentry from "npm:@sentry/deno";
import { createRedis, type RedisClient } from "./Redis.ts";

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
 * two shapes and both are safe:
 *
 *   - **leased** (Redis configured): one long-lived drainer across the whole fleet, holding a
 *     Redis lease it renews while it runs. Lowest latency, because the loop stays resident and
 *     polls on its own idle interval. Costs one admission slot per worker for the isolate's life.
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

export type WorkerRunMode = "leased" | "bounded";

export interface WorkerRun {
  readonly mode: WorkerRunMode;
  /** False once the lease is lost (leased) or the budget is spent (bounded). */
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
  /** Stable worker identity; becomes the Redis key. */
  name: string;
  scope?: Sentry.Scope;
  /** How long to sleep when a batch found no work (leased mode only). */
  idleSleepMs: number;
  /** How long to sleep after a batch threw. */
  errorSleepMs: number;
  leaseTtlMs?: number;
  boundedBudgetMs?: number;
  /** Test seams. */
  redis?: RedisClient | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function leaseKey(name: string): string {
  return `pawtograder:worker-lease:${name}`;
}

/**
 * Decide how (or whether) this poke should run the worker loop.
 *
 * Returns `null` when another holder has the lease — the correct response is to return immediately
 * and let the holder keep draining. Never throws: any Redis problem degrades to a bounded run.
 */
export async function beginWorkerRun(opts: BeginWorkerRunOptions): Promise<WorkerRun | null> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const budget = opts.boundedBudgetMs ?? DEFAULT_BOUNDED_BUDGET_MS;
  const key = leaseKey(opts.name);

  // `undefined` means "not injected, go and build one"; an explicit `null` means "no Redis", which
  // is what the tests and the no-Redis deployments both exercise.
  let redis: RedisClient | null = null;
  if (opts.redis !== undefined) {
    redis = opts.redis;
  } else {
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
    opts.scope?.setTag("worker_run_mode", "skipped_lease_held");
    return null;
  }

  opts.scope?.setTag("worker_run_mode", "leased");
  let lost = false;
  let lastHeartbeat = now();
  const heartbeatEvery = Math.max(1, Math.floor(ttl / HEARTBEAT_DIVISOR));

  const renew = async (): Promise<void> => {
    if (lost) return;
    try {
      // XX, so a lease that already expired and was taken by another isolate is NOT stolen back.
      const result = await redis.set(key, token, { px: ttl, xx: true });
      if (result === null || result === undefined || result === 0) {
        lost = true;
        opts.scope?.setTag("worker_lease", "lost");
        console.warn(`[workerRun] ${opts.name}: lease lost, stopping this loop`);
      }
    } catch (e) {
      // Treat an unreachable Redis as a lost lease. Continuing without a renewable lease is how a
      // second loop would appear elsewhere in the fleet, which is the thing being prevented.
      lost = true;
      opts.scope?.setTag("worker_lease", "renew_failed");
      Sentry.captureException(e, opts.scope);
    }
    lastHeartbeat = now();
  };

  return {
    mode: "leased",
    shouldContinue: () => !lost,
    heartbeat: async () => {
      if (now() - lastHeartbeat >= heartbeatEvery) await renew();
    },
    onIdle: async () => {
      await sleep(opts.idleSleepMs);
      await renew();
      return !lost;
    },
    onError: async () => {
      await sleep(opts.errorSleepMs);
      await renew();
    },
    release: async () => {
      if (lost) return;
      try {
        // Compare-then-delete. The gap between GET and DEL is a race in principle, but reaching it
        // requires our lease to have expired AND another isolate to have taken it in that window --
        // in which case renew() would already have marked us lost. TTL expiry is the real safety
        // net; this only shortens the handover after a clean exit.
        const current = await redis.get(key);
        if (current === token) await redis.del(key);
      } catch (e) {
        // The lease expires on its own; a failed release is not worth failing the run over.
        opts.scope?.setTag("worker_lease", "release_failed");
        Sentry.captureException(e, opts.scope);
      }
    }
  };
}
