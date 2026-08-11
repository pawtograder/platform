import { assertEquals } from "jsr:@std/assert@^1";
import { beginWorkerRun } from "./workerRun.ts";

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
    }
  };
}

const noSleep = () => Promise.resolve();

const base = { name: "test-worker", idleSleepMs: 10, errorSleepMs: 5, sleep: noSleep };

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
  assertEquals(redis.store.has("pawtograder:worker-lease:test-worker"), true);
});

// The accumulation fix: a second poke while the first holds the lease must do nothing at all.
Deno.test("a second run while the lease is held returns null", async () => {
  const redis = fakeRedis();
  const first = await beginWorkerRun({ ...base, redis });
  assertEquals(first?.mode, "leased");
  const second = await beginWorkerRun({ ...base, redis });
  assertEquals(second, null);
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
  redis.store.delete("pawtograder:worker-lease:test-worker");
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
  redis.store.set("pawtograder:worker-lease:test-worker", "someone-elses-token");
  await run!.release();
  assertEquals(redis.store.get("pawtograder:worker-lease:test-worker"), "someone-elses-token");
});

Deno.test("leased idle sleeps and keeps looping", async () => {
  const redis = fakeRedis();
  const run = await beginWorkerRun({ ...base, redis });
  assertEquals(await run!.onIdle(), true);
});
