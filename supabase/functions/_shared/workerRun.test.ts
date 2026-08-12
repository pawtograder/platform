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
    /** px used for each key, so tests can assert a helper slot outlives less than a lease. */
    ttls: new Map<string, number>(),
    // deno-lint-ignore no-explicit-any
    set(key: string, value: string, o?: any) {
      setCalls++;
      if (typeof o?.px === "number") this.ttls.set(key, o.px);
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

// Only one resident loop, but the loser still helps: a bounded run drains and exits, so a holder
// that has stopped making progress cannot stall the queue behind its own lease.
Deno.test("a second run while the lease is held is bounded, not a no-op", async () => {
  const redis = fakeRedis();
  const first = await beginWorkerRun({ ...base, redis });
  assertEquals(first.mode, "leased");
  const second = await beginWorkerRun({ ...base, redis });
  assertEquals(second.mode, "bounded");
  assertEquals(await second.onIdle(), false, "the helper must exit rather than stay resident");
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

// "Every loser drains" is its own slot-exhaustion bug: these workers get several pokes per cron
// tick, so a backlogged queue would mint a drainer on each one.
Deno.test("the helper pool is bounded; pokes past it idle instead of draining", async () => {
  const redis = fakeRedis();
  const leased = await beginWorkerRun({ ...base, redis });
  assertEquals(leased.mode, "leased");

  const helpers: string[] = [];
  for (let i = 0; i < 5; i++) {
    helpers.push((await beginWorkerRun({ ...base, redis })).mode);
  }
  assertEquals(
    helpers.filter((m) => m === "bounded").length,
    1,
    "at most MAX_BOUNDED_HELPERS pokes may drain alongside the holder"
  );
  assertEquals(helpers.filter((m) => m === "idle").length, 4);
});

// An idle run must be inert in the caller's loop: `while (run.shouldContinue())` runs zero times.
Deno.test("an idle run does no work at all", async () => {
  const redis = fakeRedis();
  await beginWorkerRun({ ...base, redis });
  await beginWorkerRun({ ...base, redis }); // takes the one helper slot
  const idle = await beginWorkerRun({ ...base, redis });
  assertEquals(idle.mode, "idle");
  assertEquals(idle.shouldContinue(), false);
  await idle.release();
});

// The slot has to come back, or one backlog would wedge the pool until TTL.
Deno.test("a helper hands its slot back on release", async () => {
  const redis = fakeRedis();
  await beginWorkerRun({ ...base, redis });
  const helper = await beginWorkerRun({ ...base, redis });
  assertEquals(helper.mode, "bounded");
  assertEquals(redis.store.has(`${LEASE_KEY}:helper-1`), true);
  await helper.release();
  assertEquals(redis.store.has(`${LEASE_KEY}:helper-1`), false);
  assertEquals((await beginWorkerRun({ ...base, redis })).mode, "bounded", "the freed slot is reusable");
});

// A helper that dies without releasing holds the only slot until its key expires, so that expiry
// has to be quick. At the lease TTL, one dead helper plus a stalled holder meant nothing drained
// for a minute -- the ~94s worst-case gap seen in CI.
Deno.test("a helper slot expires much sooner than a lease", async () => {
  const redis = fakeRedis();
  await beginWorkerRun({ ...base, redis, leaseTtlMs: 60_000 });
  const helper = await beginWorkerRun({ ...base, redis, leaseTtlMs: 60_000 });
  assertEquals(helper.mode, "bounded");
  const leaseTtl = redis.ttls.get(LEASE_KEY)!;
  const helperTtl = redis.ttls.get(`${LEASE_KEY}:helper-1`)!;
  assertEquals(leaseTtl, 60_000);
  assertEquals(helperTtl < leaseTtl / 2, true, `helper slot ttl ${helperTtl} should be well under ${leaseTtl}`);
});

// Helper slots are never renewed, so a hung helper frees its slot at TTL rather than for the life
// of the isolate. Guarding the property that makes that true: no renewal timer is registered.
Deno.test("a helper registers no renewal timer", async () => {
  const redis = fakeRedis();
  const timers = fakeTimers();
  await beginWorkerRun({ ...base, redis });
  const before = timers.active;
  const helper = await beginWorkerRun({
    ...base,
    redis,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  assertEquals(helper.mode, "bounded");
  assertEquals(timers.active, before);
});

// Redis refusing to answer must not become "drain anyway" -- that is the crowd the pool prevents.
Deno.test("a Redis failure while claiming a helper slot idles rather than drains", async () => {
  const redis = fakeRedis();
  await beginWorkerRun({ ...base, redis });
  let calls = 0;
  const flaky = {
    ...redis,
    // deno-lint-ignore no-explicit-any
    set(key: string, value: string, o?: any) {
      calls++;
      if (calls > 1) throw new Error("redis down");
      return redis.set(key, value, o);
    }
  };
  const run = await beginWorkerRun({ ...base, redis: flaky });
  assertEquals(run.mode, "idle");
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
