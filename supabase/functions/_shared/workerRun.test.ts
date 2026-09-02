import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { beginWorkerRun, workerLeaseScope } from "./workerRun.ts";

/** Minimal stand-in for the subset of the Redis surface a lease uses. */
function fakeRedis(opts: { failAcquire?: boolean; failRenew?: boolean } = {}) {
  const store = new Map<string, string>();
  let setCalls = 0;
  return {
    store,
    get setCalls() {
      return setCalls;
    },
    // deno-lint-ignore no-explicit-any
    set(key: string, value: string, o?: any) {
      setCalls++;
      if (o?.nx) {
        if (opts.failAcquire) throw new Error("redis down");
        if (store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve("OK");
      }
      if (o?.xx) {
        if (opts.failRenew) throw new Error("redis down");
        if (!store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve("OK");
      }
      store.set(key, value);
      return Promise.resolve("OK");
    },
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    },
    del(key: string) {
      store.delete(key);
      return Promise.resolve(1);
    },
    // Mirrors the two Lua scripts: act only when the stored value is still the caller's token.
    // deno-lint-ignore no-explicit-any
    eval(script: string, keys: any[], args: any[]) {
      if (opts.failRenew && script.includes("PEXPIRE")) throw new Error("redis down");
      const [key] = keys;
      const [token] = args;
      if (store.get(key) !== token) return Promise.resolve(0);
      if (script.includes("DEL")) store.delete(key);
      return Promise.resolve(1);
    }
  };
}

/** Captures interval registrations so tests can fire them by hand. */
function fakeTimers() {
  const cbs = new Map<number, () => void>();
  let next = 1;
  return {
    setIntervalFn: (cb: () => void) => {
      const h = next++;
      cbs.set(h, cb);
      return h;
    },
    clearIntervalFn: (h: number) => {
      cbs.delete(h);
    },
    get active() {
      return cbs.size;
    },
    fireAll() {
      for (const cb of cbs.values()) cb();
    }
  };
}

const noSleep = () => Promise.resolve();

const base = {
  name: "test-worker",
  idleSleepMs: 10,
  errorSleepMs: 5,
  sleep: noSleep,
  // Empty env, so the lease scope is the "development" default rather than whatever the machine
  // running the tests happens to export.
  readEnv: () => undefined,
  // Default to inert timers so tests drive renewal explicitly rather than on the wall clock.
  setIntervalFn: () => 1,
  clearIntervalFn: () => {}
};

/** The key `base` produces: the "development" scope segment, then the worker name. */
const LEASE_KEY = "pawtograder:worker-lease:development:test-worker";

/** An EnvReader over a plain object, for the lease-scope tests. */
const envOf =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

Deno.test("no Redis configured -> bounded run, never null", async () => {
  const run = await beginWorkerRun({ ...base, redis: null });
  assertEquals(run?.mode, "bounded");
});

// The whole point of bounded mode: the loop must not stay resident polling, because a resident
// loop is what occupies an admission slot under per_request.
Deno.test("bounded run exits on idle rather than sleeping", async () => {
  const run = await beginWorkerRun({ ...base, redis: null });
  assertEquals(await run!.onIdle(), false);
});

Deno.test("bounded run stops once the budget is spent", async () => {
  let t = 1000;
  const run = await beginWorkerRun({ ...base, redis: null, boundedBudgetMs: 500, now: () => t });
  assertEquals(run!.shouldContinue(), true);
  t += 501;
  assertEquals(run!.shouldContinue(), false);
});

Deno.test("Redis configured -> leased run, and the lease is actually written", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis });
  assertEquals(run?.mode, "leased");
  assertEquals(redis.store.has(LEASE_KEY), true);
});

// A loser does nothing -- and the holder giving up a lease it is stalled on is what makes that
// safe. See the stall tests below.
Deno.test("a second run while the lease is held is idle", async () => {
  const redis = fakeRedis();
  const first = await beginWorkerRun({ ...base, redis });
  assertEquals(first.mode, "leased");
  const second = await beginWorkerRun({ ...base, redis });
  assertEquals(second.mode, "idle");
});

// The lease still has to mean something: exactly one holder gets the resident loop.
Deno.test("only one run is leased at a time", async () => {
  const redis = fakeRedis();
  const runs = [
    await beginWorkerRun({ ...base, redis }),
    await beginWorkerRun({ ...base, redis }),
    await beginWorkerRun({ ...base, redis })
  ];
  assertEquals(runs.filter((r) => r.mode === "leased").length, 1);
});

// An idle run must be inert in the caller's loop: `while (run.shouldContinue())` runs zero times.
Deno.test("an idle run does no work at all", async () => {
  const redis = fakeRedis();
  await beginWorkerRun({ ...base, redis });
  const idle = await beginWorkerRun({ ...base, redis });
  assertEquals(idle.mode, "idle");
  assertEquals(idle.shouldContinue(), false);
  assertEquals(await idle.onIdle(), false);
  await idle.release();
});

// ── Stall detection ────────────────────────────────────────────────────────────
// The regression this exists for: the renewal timer kept a lease alive on behalf of a loop that
// had stopped going round, and every other poke was turned away for as long as it lasted.

Deno.test("a holder that stops calling in stops renewing", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  let t = 0;
  const run = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    maxStallMs: 1000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  assertEquals(run.mode, "leased");

  // The loop is going round: the timer fires, but progress is recent, so the lease is kept.
  t += 200;
  await run.heartbeat();
  timers.fireAll();
  await Promise.resolve();
  assertEquals(run.shouldContinue(), true);

  // Now the loop is wedged inside processBatch. The timer still fires; the lease must not survive.
  t += 1001;
  timers.fireAll();
  await Promise.resolve();
  assertEquals(run.shouldContinue(), false, "a stalled holder must give up the lease");
  assertEquals(timers.active, 0, "and stop renewing it");
});

// It must let the key LAPSE rather than delete it: by the time a stall is noticed the key may
// already have expired and been taken by the next holder.
Deno.test("giving up a stalled lease does not delete another holder's key", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  let t = 0;
  const run = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    maxStallMs: 1000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  t += 1001;
  timers.fireAll();
  await Promise.resolve();
  assertEquals(run.shouldContinue(), false);

  redis.store.set(LEASE_KEY, "next-holders-token");
  await run.release();
  assertEquals(redis.store.get(LEASE_KEY), "next-holders-token");
});

// Once the stalled holder's key lapses, the next poke becomes the holder -- which is the whole
// point of noticing the stall.
Deno.test("the next poke takes over once a stalled lease lapses", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  let t = 0;
  const stalled = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    maxStallMs: 1000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  t += 1001;
  timers.fireAll();
  await Promise.resolve();
  assertEquals(stalled.shouldContinue(), false);

  redis.store.delete(LEASE_KEY); // what the TTL does for real
  const next = await beginWorkerRun({ ...base, redis });
  assertEquals(next.mode, "leased");
});

// A batch that is merely SLOW is not a stall, or the GitHub worker would drop its lease on every
// sync_repo_to_handout.
Deno.test("a slow batch inside maxStallMs keeps the lease", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  let t = 0;
  const run = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    maxStallMs: 10 * 60_000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  for (let i = 0; i < 20; i++) {
    t += 20_000; // a batch running for minutes, with no loop iteration in between
    timers.fireAll();
    await Promise.resolve();
  }
  assertEquals(run.shouldContinue(), true, "minutes-long batches are normal for some workers");
});

// onIdle and onError are loop calls too, so they must count as progress -- otherwise a worker that
// sat idle longer than maxStallMs would drop its lease for being healthy.
Deno.test("idling counts as progress", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  let t = 0;
  const run = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    maxStallMs: 1000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  for (let i = 0; i < 5; i++) {
    t += 900;
    assertEquals(await run.onIdle(), true);
  }
  assertEquals(run.shouldContinue(), true);
});

Deno.test("releasing the lease lets the next run acquire it", async () => {
  const redis = fakeRedis();
  const first = await beginWorkerRun({ ...base, redis });
  await first!.release();
  const second = await beginWorkerRun({ ...base, redis });
  assertEquals(second?.mode, "leased");
});

// Failing toward bounded is the deliberate choice: never toward a second unbounded loop.
Deno.test("a Redis failure during acquire degrades to bounded, not to null", async () => {
  const run = await beginWorkerRun({ ...base, redis: fakeRedis({ failAcquire: true }) });
  assertEquals(run?.mode, "bounded");
});

Deno.test("losing the lease stops the loop", async () => {
  const redis = fakeRedis();
  let t = 0;
  const run = await beginWorkerRun({ ...base, redis, leaseTtlMs: 300, now: () => t });
  assertEquals(run!.shouldContinue(), true);
  // Another isolate takes over: the key no longer holds our token, so an XX renew finds nothing.
  redis.store.delete(LEASE_KEY);
  t += 200; // past ttl/3, so the heartbeat is due
  await run!.heartbeat();
  assertEquals(run!.shouldContinue(), false);
});

Deno.test("an unreachable Redis during renew is treated as a lost lease", async () => {
  const redis = fakeRedis({ failRenew: true });
  let t = 0;
  const run = await beginWorkerRun({ ...base, redis, leaseTtlMs: 300, now: () => t });
  t += 200;
  await run!.heartbeat();
  assertEquals(run!.shouldContinue(), false);
});

Deno.test("heartbeat is a no-op before the interval elapses", async () => {
  const redis = fakeRedis();
  let t = 0;
  const run = await beginWorkerRun({ ...base, redis, leaseTtlMs: 300, now: () => t });
  const afterAcquire = redis.setCalls;
  t += 10; // well inside ttl/3
  await run!.heartbeat();
  assertEquals(redis.setCalls, afterAcquire);
});

// A release must not delete a lease that now belongs to someone else.
Deno.test("release does not delete another holder's lease", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis });
  redis.store.set(LEASE_KEY, "someone-elses-token");
  await run!.release();
  assertEquals(redis.store.get(LEASE_KEY), "someone-elses-token");
});

Deno.test("leased idle sleeps and keeps looping", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis });
  assertEquals(await run!.onIdle(), true);
});

// The defect this replaced: `SET ... XX` asserts only that the key EXISTS, so a worker whose lease
// had expired and been retaken would overwrite the new owner's token and carry on believing it held
// the lease -- two loops, each stomping the other.
Deno.test("a renewal does not steal a lease another isolate now owns", async () => {
  const redis = fakeRedis();
  let t = 0;
  const run = await beginWorkerRun({ ...base, redis, leaseTtlMs: 300, now: () => t });
  redis.store.set(LEASE_KEY, "another-isolates-token");
  t += 200;
  await run!.heartbeat();
  assertEquals(run!.shouldContinue(), false, "must stop rather than reclaim");
  assertEquals(redis.store.get(LEASE_KEY), "another-isolates-token", "the new owner's token must survive");
});

// The other defect: renewal only happened between batches, so a batch longer than the TTL let the
// lease lapse mid-flight and a later poke started a second worker.
Deno.test("the renewal timer keeps the lease alive without the loop calling heartbeat", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  const run = await beginWorkerRun({
    ...base,
    redis,
    leaseTtlMs: 300,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  assertEquals(timers.active, 1, "a renewal timer must be armed on acquire");
  timers.fireAll(); // stands in for a renewal landing mid-batch
  await Promise.resolve();
  assertEquals(run!.shouldContinue(), true);
});

Deno.test("releasing stops the renewal timer", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  const run = await beginWorkerRun({
    ...base,
    redis,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  assertEquals(timers.active, 1);
  await run!.release();
  assertEquals(timers.active, 0, "a leaked interval would hold the isolate alive");
});

Deno.test("release deletes only our own lease", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis });
  await run!.release();
  assertEquals(redis.store.has(LEASE_KEY), false);
});

// ── Lease scope ────────────────────────────────────────────────────────────────
// Everything below is about one bug: the key was the worker name alone, so every deployment sharing
// the Upstash credentials shared one lease.

Deno.test("lease scope falls back to development when nothing identifies the deploy", () => {
  assertEquals(workerLeaseScope(envOf({})), "development");
});

Deno.test("lease scope prefers ENVIRONMENT, then DEPLOY_KIND", () => {
  assertEquals(workerLeaseScope(envOf({ ENVIRONMENT: "production", DEPLOY_KIND: "preview" })), "production");
  assertEquals(workerLeaseScope(envOf({ DEPLOY_KIND: "staging" })), "staging");
});

// The production fleet SHOULD share one lease -- that is what bounds resident loops across pods.
Deno.test("production is a single scope across the fleet", () => {
  assertEquals(
    workerLeaseScope(envOf({ ENVIRONMENT: "production" })),
    workerLeaseScope(envOf({ ENVIRONMENT: "production" }))
  );
});

Deno.test("two preview deployments do not collide on 'preview'", () => {
  const a = workerLeaseScope(envOf({ ENVIRONMENT: "preview", DEPLOY_PR: "901" }));
  const b = workerLeaseScope(envOf({ ENVIRONMENT: "preview", DEPLOY_PR: "902" }));
  assertNotEquals(a, b);
});

// The regression: two e2e jobs on the pawtograder-e2e pool, same Redis, same key. One drained and
// the other was turned away for its whole run.
Deno.test("two CI runs do not collide on 'e2e-local'", () => {
  const env = (runId: string) => envOf({ DEPLOY_KIND: "e2e-local", DEPLOY_RUN_ID: runId, DEPLOY_RUN_ATTEMPT: "1" });
  assertEquals(workerLeaseScope(env("31550106308")), "e2e-local:run-31550106308-1");
  assertNotEquals(workerLeaseScope(env("31550106308")), workerLeaseScope(env("31550905986")));
});

// A retried job re-runs the whole suite against a fresh database; it is not the same deployment.
Deno.test("a re-run attempt is its own scope", () => {
  const attempt = (n: string) => envOf({ DEPLOY_KIND: "e2e-local", DEPLOY_RUN_ID: "1", DEPLOY_RUN_ATTEMPT: n });
  assertNotEquals(workerLeaseScope(attempt("1")), workerLeaseScope(attempt("2")));
});

// `preview.yml` passes global.deploy.runId on EVERY helm upgrade. Keying on it would re-key each
// redeploy, and the chart's rolling update (maxSurge 1, maxUnavailable 0, ~410s drain) would then
// have the outgoing and incoming pods holding resident leases under different keys.
Deno.test("a preview keeps one scope across redeploys", () => {
  const deploy = (runId: string) =>
    envOf({ ENVIRONMENT: "preview", DEPLOY_PR: "927", DEPLOY_RUN_ID: runId, DEPLOY_RUN_ATTEMPT: "1" });
  assertEquals(workerLeaseScope(deploy("1")), "preview:pr-927");
  assertEquals(workerLeaseScope(deploy("1")), workerLeaseScope(deploy("2")));
});

Deno.test("staging and production ignore run identity too", () => {
  const deploy = (environment: string, runId: string) => envOf({ ENVIRONMENT: environment, DEPLOY_RUN_ID: runId });
  assertEquals(workerLeaseScope(deploy("staging", "1")), "staging");
  assertEquals(workerLeaseScope(deploy("production", "1")), workerLeaseScope(deploy("production", "2")));
});

Deno.test("WORKER_LEASE_SCOPE overrides everything", () => {
  assertEquals(workerLeaseScope(envOf({ WORKER_LEASE_SCOPE: "manual", ENVIRONMENT: "production" })), "manual");
});

// A key you cannot paste into redis-cli is a key you cannot debug.
Deno.test("scope segments are sanitized", () => {
  const scope = workerLeaseScope(envOf({ ENVIRONMENT: "feat/some thing" }));
  assertEquals(/^feat-some-thing~[a-z0-9]+$/.test(scope), true, scope);
});

// Sanitizing must not merge two scopes -- that is the collision this module exists to prevent,
// reintroduced by the thing meant to make keys readable.
Deno.test("sanitizing distinct values keeps them distinct", () => {
  const scopeOf = (environment: string) => workerLeaseScope(envOf({ ENVIRONMENT: environment }));
  assertNotEquals(scopeOf("feat/foo"), scopeOf("feat-foo"));
  assertNotEquals(scopeOf("a/b"), scopeOf("a b"));
  assertNotEquals(scopeOf("a//b"), scopeOf("a/b"));
});

// The values that actually occur are already key-safe, and those must stay readable.
Deno.test("already-safe values are left alone", () => {
  for (const environment of ["dev", "preview", "staging", "production", "e2e-local"]) {
    assertEquals(workerLeaseScope(envOf({ ENVIRONMENT: environment })), environment);
  }
});

Deno.test("blank env values are ignored rather than making an empty segment", () => {
  assertEquals(workerLeaseScope(envOf({ ENVIRONMENT: "   ", DEPLOY_KIND: "staging", DEPLOY_PR: "" })), "staging");
});

Deno.test("the scope is part of the Redis key, so scopes cannot block each other", async () => {
  const redis = fakeRedis();
  const runA = await beginWorkerRun({
    ...base,
    redis,
    readEnv: envOf({ DEPLOY_KIND: "e2e-local", DEPLOY_RUN_ID: "1", DEPLOY_RUN_ATTEMPT: "1" })
  });
  const runB = await beginWorkerRun({
    ...base,
    redis,
    readEnv: envOf({ DEPLOY_KIND: "e2e-local", DEPLOY_RUN_ID: "2", DEPLOY_RUN_ATTEMPT: "1" })
  });
  assertEquals(runA?.mode, "leased");
  assertEquals(runB?.mode, "leased", "a concurrent CI run must not be starved by another run's lease");
  assertEquals(redis.store.size, 2);
});

// A worker whose batches are milliseconds is better off draining and exiting: nothing accumulates,
// no admission slot is held between pokes, and no other poke's lease can starve it.
Deno.test("preferBounded skips the lease even when Redis is available", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis, preferBounded: true });
  assertEquals(run.mode, "bounded");
  assertEquals(redis.store.size, 0, "no lease key should be written at all");
  assertEquals(await run.onIdle(), false);
});

// ...and it must not be starved by a lease someone else holds, which is the whole point.
Deno.test("preferBounded is unaffected by a held lease", async () => {
  const redis = fakeRedis();
  const holder = await beginWorkerRun({ ...base, redis });
  assertEquals(holder.mode, "leased");
  const run = await beginWorkerRun({ ...base, redis, preferBounded: true });
  assertEquals(run.mode, "bounded");
});
