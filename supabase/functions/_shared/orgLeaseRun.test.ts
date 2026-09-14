/**
 * The per-org lease state machine.
 *
 * These are the properties that stop a per-org leaseholder from being worse than the single
 * leaseholder it replaces: a slot is given back the moment it stops being used, a wedged holder
 * cannot keep an org to itself, and a broken RPC ends the run instead of parking an isolate on an
 * admission slot forever. The RPC is injected, so none of this needs a database — the SQL side is
 * pinned by contract and verified separately.
 */

import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1";
import { beginOrgLeaseRun, OrgClaimError, type OrgSlotRow, type OrgSlotRpc, type RpcResult } from "./orgLeaseRun.ts";

type ClaimArgs = Parameters<OrgSlotRpc["claim"]>[0];

/** A claimed message row, as `claim_org_slot_and_read` returns it. */
function row(msgId: number, org: string): OrgSlotRow {
  return {
    status: "claimed",
    org,
    msg_id: msgId,
    read_ct: 1,
    enqueued_at: "2026-09-13T00:00:00Z",
    vt: "2026-09-13T00:05:00Z",
    message: { method: "create_repo" }
  };
}

/** The single NULL-filled row the SQL returns when it claimed nothing. */
function statusRow(status: "no_demand" | "no_capacity"): OrgSlotRow[] {
  return [{ status, org: null, msg_id: null, read_ct: null, enqueued_at: null, vt: null, message: null }];
}

/**
 * A promise a test can settle by hand, for interleaving an in-flight RPC with the loop. `resolve!`
 * rather than a nullable, so the call sites type-check under `deno check`.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Programmable stand-in for the three pinned RPCs.
 *
 * `claim` is handed the call index so a test can say "rows on the first call, nothing after", which
 * is the shape almost every interesting case takes. Returning an `Error` from a hook makes the RPC
 * REJECT; returning an `RpcResult` with `error` set makes it fail the PostgREST way. Both paths
 * matter and the module treats them differently in exactly one place (a rejection has no `code`, so
 * it can never be recognised as the missing-function case).
 */
function fakeRpc(
  init: {
    claim?: (args: ClaimArgs, callIndex: number) => RpcResult<OrgSlotRow[]> | Error;
    renew?: (callIndex: number) => RpcResult<boolean> | Error;
  } = {}
) {
  const claimArgs: ClaimArgs[] = [];
  const releaseArgs: { queue_name: string; holder: string }[] = [];
  const renewArgs: { queue_name: string; holder: string }[] = [];

  const rpc: OrgSlotRpc = {
    claim: (args) => {
      claimArgs.push(args);
      const result = init.claim ? init.claim(args, claimArgs.length) : { data: [], error: null };
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    renew: (args) => {
      renewArgs.push({ queue_name: args.queue_name, holder: args.holder });
      const result = init.renew ? init.renew(renewArgs.length) : { data: true, error: null };
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    release: (args) => {
      releaseArgs.push(args);
      return Promise.resolve({ data: null, error: null });
    }
  };

  return {
    rpc,
    claimArgs,
    renewArgs,
    releaseArgs,
    get releaseQueues() {
      return releaseArgs.map((a) => a.queue_name);
    },
    get renewCalls() {
      return renewArgs.length;
    },
    get releaseCalls() {
      return releaseArgs.length;
    }
  };
}

type SlotRow = { queue: string; holder: string; expiresAt: number; renewals: number };

/**
 * A stand-in that models the SLOT TABLE, not just the calls made against it.
 *
 * `fakeRpc` records calls, which is enough for most of this file. It is not enough for the rotation
 * cases, because there every individual call is correct and the fault is in the set of ROWS they
 * leave behind. This reproduces the three behaviours of the migration that produce that fault:
 *
 *   - `claim` is scoped to one queue's pool and reuses a row only when the SAME holder already has
 *     one IN THAT POOL, so a holder claiming in a second pool takes a SECOND row;
 *   - `renew` matches `where holder = ...` across EVERY pool;
 *   - `release` matches `where holder = ...` across EVERY pool.
 *
 * A claim that finds no work claims nothing and leaves any existing row untouched, which is what
 * makes probing a queue you do not hold free.
 */
function fakeSlotTable(init: {
  work: (queueName: string) => OrgSlotRow[];
  now?: () => number;
  releaseFails?: () => boolean;
}) {
  const rows: SlotRow[] = [];
  const renewedQueues: string[] = [];
  const now = init.now ?? (() => 0);

  const rpc: OrgSlotRpc = {
    claim: (args) => {
      const out = init.work(args.queue_name);
      // A status row means no org qualified, so the SQL writes no slot row and leaves any existing
      // one alone. That is what makes probing a queue you do not hold free.
      if (!out.some((r) => r.msg_id !== null)) return Promise.resolve({ data: out, error: null });
      const expiresAt = now() + args.lease_ttl_seconds * 1000;
      const existing = rows.find((r) => r.queue === args.queue_name && r.holder === args.holder);
      if (existing) existing.expiresAt = expiresAt;
      else rows.push({ queue: args.queue_name, holder: args.holder, expiresAt, renewals: 0 });
      return Promise.resolve({ data: out, error: null });
    },
    // Scoped by (queue_name, holder) AND liveness, exactly as the migration is: a lapsed holder
    // cannot resurrect a lease, and renewing one pool never touches the other.
    renew: (args) => {
      renewedQueues.push(args.queue_name);
      const matched = rows.filter(
        (r) => r.queue === args.queue_name && r.holder === args.holder && r.expiresAt > now()
      );
      for (const r of matched) {
        r.expiresAt = now() + args.lease_ttl_seconds * 1000;
        r.renewals += 1;
      }
      return Promise.resolve({ data: matched.length > 0, error: null });
    },
    release: (args) => {
      if (init.releaseFails?.()) {
        return Promise.resolve({ data: null, error: { message: "could not release", code: "XX000" } });
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].queue === args.queue_name && rows[i].holder === args.holder) rows.splice(i, 1);
      }
      return Promise.resolve({ data: null, error: null });
    }
  };

  /** Rows whose lease has not yet expired — what actually counts against global_cap / max_per_org. */
  const liveRows = () => rows.filter((r) => r.expiresAt > now());

  return { rpc, rows, liveRows, renewQueues: () => renewedQueues };
}

/** Captures interval registrations so tests fire renewals by hand, as workerRun.test.ts does. */
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

/** Let queued microtasks and the timer's `void renew()` chain settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const base = {
  name: "test-worker",
  queueNames: ["async_calls", "async_calls_low_priority"],
  drainConcurrency: 4,
  visibilityTimeoutSeconds: 300,
  maxPerOrg: 1,
  globalCap: 4,
  idleSleepMs: 10,
  errorSleepMs: 5,
  sleep: () => Promise.resolve(),
  // Empty env, so the holder carries the "development" scope rather than whatever the machine
  // running the tests happens to export.
  readEnv: () => undefined,
  // Inert timers by default; tests that care drive renewal explicitly.
  setIntervalFn: () => 1,
  clearIntervalFn: () => {}
};

// ── Claiming ───────────────────────────────────────────────────────────────────

Deno.test("a claim returns the org and its messages, and the run holds that org", async () => {
  const f = fakeRpc({ claim: (_a, i) => ({ data: i === 1 ? [row(1, "acme"), row(2, "acme")] : [], error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  const claimed = await run.claim();
  assertEquals(claimed?.org, "acme");
  assertEquals(claimed?.queueName, "async_calls");
  assertEquals(claimed?.messages.length, 2);
  assertEquals(run.heldOrg(), "acme");
  assertEquals(run.shouldContinue(), true);
});

// The knobs are the whole reason asyncWorkerTuning.ts exists; a leaseholder that quietly sent its
// own numbers would make every bound in that file a fiction.
Deno.test("the claim passes the configured tuning through verbatim", async () => {
  const f = fakeRpc();
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    drainConcurrency: 4,
    visibilityTimeoutSeconds: 480,
    maxPerOrg: 2,
    globalCap: 6,
    leaseTtlMs: 90_000
  });
  await run.claim();

  assertEquals(f.claimArgs[0], {
    queue_name: "async_calls",
    sleep_seconds: 480,
    n: 4,
    holder: run.holder,
    lease_ttl_seconds: 90,
    max_per_org: 2,
    global_cap: 6
  });
});

Deno.test("an empty main queue falls through to the low-priority queue", async () => {
  const f = fakeRpc({
    claim: (args) => ({ data: args.queue_name === "async_calls_low_priority" ? [row(7, "acme")] : [], error: null })
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  const claimed = await run.claim();
  assertEquals(claimed?.queueName, "async_calls_low_priority");
  assertEquals(
    f.claimArgs.map((a) => a.queue_name),
    ["async_calls", "async_calls_low_priority"]
  );
});

// The holder string is the row identity in the slot table. Two isolates sharing one would each
// believe they held the other's slot, and `release_org_slot` would revoke a live lease.
Deno.test("each run gets its own holder, prefixed with the lease scope and worker name", () => {
  const first = beginOrgLeaseRun({ ...base, rpc: fakeRpc().rpc });
  const second = beginOrgLeaseRun({ ...base, rpc: fakeRpc().rpc });

  assertNotEquals(first.holder, second.holder);
  assertStringIncludes(first.holder, "development:test-worker:");
});

// A leaseholder does not own an org for life: a repeat claim rotates it onto whichever org is
// neediest now, so nothing may cache the org across iterations.
Deno.test("a later claim rotates the run onto a different org", async () => {
  const f = fakeRpc({ claim: (_a, i) => ({ data: [row(i, i === 1 ? "acme" : "globex")], error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals((await run.claim())?.org, "acme");
  assertEquals((await run.claim())?.org, "globex");
  assertEquals(run.heldOrg(), "globex");
});

// ── Giving the slot back ───────────────────────────────────────────────────────

// The SQL only writes the slot row when an org qualifies, so a claim that finds nothing leaves the
// previous lease LIVE. Not releasing here would pin an org's headroom for a whole TTL while this
// leaseholder does nothing with it.
Deno.test("a claim that finds no work releases the slot it was holding", async () => {
  const f = fakeRpc({ claim: (_a, i) => ({ data: i === 1 ? [row(1, "acme")] : [], error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  await run.claim();
  assertEquals(f.releaseCalls, 0);

  assertEquals(await run.claim(), null);
  // Only the pool a claim actually took a slot in. The low-priority pool was probed on the way past
  // and answered "claimed nothing" definitively, which proves no row was committed there -- so it is
  // not in the release set and costs no RPC.
  assertEquals(f.releaseCalls, 1);
  assertEquals(f.releaseQueues, ["async_calls"]);
  assertEquals(f.releaseArgs[0].holder, run.holder);
  assertEquals(run.heldOrg(), null);
  assertEquals(run.heldQueue(), null);
});

// A claim whose response never arrived may still have committed a row on the server. That is the
// one case where the run cannot know, so the queue stays in the release set and exit cleans it up.
Deno.test("exiting releases a queue whose claim response never arrived", async () => {
  const f = fakeRpc({ claim: () => new Error("socket hang up") });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 99 });

  await assertRejects(() => run.claim(), OrgClaimError);
  await run.release();
  assertEquals(f.releaseQueues, ["async_calls"], "the queue we could not get an answer from");
});

// The converse: a definite "claimed nothing" answer is proof, so it must NOT leave a queue behind
// to be released at exit. Getting this wrong costs a wasted RPC per pool on every idle isolate.
Deno.test("a definite empty answer leaves nothing to release at exit", async () => {
  const f = fakeRpc();
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  await run.release();
  assertEquals(f.releaseCalls, 0);
});

Deno.test("a run that never claimed does not call release", async () => {
  const f = fakeRpc();
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });
  await run.release();
  assertEquals(f.releaseCalls, 0);
});

// ── Losing the slot ────────────────────────────────────────────────────────────

// `renew_org_slot` returns false when the holder holds no CURRENTLY LIVE slot, i.e. our lease
// lapsed and the row was reaped. Re-claiming under the same holder is how two runs would alternate
// ownership of one org, so the run must end and let a fresh isolate start clean.
Deno.test("a renewal the server refuses ends the run", async () => {
  const f = fakeRpc({
    claim: () => ({ data: [row(1, "acme")], error: null }),
    renew: () => ({ data: false, error: null })
  });
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => t });

  await run.claim();
  t += 10_001; // past ttl/3, so the heartbeat is due
  await run.heartbeat();

  assertEquals(run.shouldContinue(), false);
  assertEquals(run.heldOrg(), null);
});

Deno.test("a renewal the RPC rejects ends the run", async () => {
  const f = fakeRpc({
    claim: () => ({ data: [row(1, "acme")], error: null }),
    renew: () => new Error("postgrest unreachable")
  });
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => t });

  await run.claim();
  t += 10_001;
  await run.heartbeat();
  assertEquals(run.shouldContinue(), false);
});

Deno.test("a PostgREST error on renewal ends the run", async () => {
  const f = fakeRpc({
    claim: () => ({ data: [row(1, "acme")], error: null }),
    renew: () => ({ data: null, error: { message: "boom", code: "PGRST301" } })
  });
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => t });

  await run.claim();
  t += 10_001;
  await run.heartbeat();
  assertEquals(run.shouldContinue(), false);
});

Deno.test("a heartbeat before the renewal interval elapses does not hit the RPC", async () => {
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => t });

  await run.claim();
  t += 100; // well inside ttl/3
  await run.heartbeat();
  assertEquals(f.renewCalls, 0);
});

// ── Stall detection ────────────────────────────────────────────────────────────
// The regression this exists for is workerRun.ts's: the renewal timer kept a lease alive on behalf
// of a loop that had stopped going round. Renewal is not evidence of progress; only the loop is.

Deno.test("a holder that stops calling in gives its slot up", async () => {
  const timers = fakeTimers();
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    leaseTtlMs: 30_000,
    maxStallMs: 60_000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  assertEquals(timers.active, 1, "a renewal timer must be armed once a slot is held");

  // Going round: the timer fires, progress is recent, the slot is kept.
  t += 10_001;
  await run.heartbeat();
  timers.fireAll();
  await flush();
  assertEquals(run.shouldContinue(), true);

  // Now wedged inside the batch. The timer still fires; the slot must not survive it.
  t += 60_001;
  timers.fireAll();
  await flush();

  assertEquals(run.shouldContinue(), false, "a stalled holder must give up its slot");
  assertEquals(timers.active, 0, "and stop renewing it");
  // Unlike the Redis lease, this one CAN safely delete its own row rather than waiting out the TTL.
  assertEquals(f.releaseCalls, 1, "the org gets its headroom back now, not in one TTL");
  assertEquals(f.releaseArgs[0], { queue_name: "async_calls", holder: run.holder });
});

// A batch that is merely SLOW is not a stall, or a leaseholder would drop its slot on every large
// org — the case the whole feature exists to serve.
Deno.test("a slow batch inside maxStallMs keeps the slot", async () => {
  const timers = fakeTimers();
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    leaseTtlMs: 30_000,
    maxStallMs: 10 * 60_000,
    now: () => t,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  for (let i = 0; i < 20; i++) {
    t += 20_000; // minutes of batch, with no loop iteration in between
    timers.fireAll();
    await flush();
  }

  assertEquals(run.shouldContinue(), true, "minutes-long batches are normal for a large org");
  assertEquals(f.releaseCalls, 0);
});

// onIdle and onError are loop calls too, so they must count as progress: an idle leaseholder is
// healthy, not wedged.
Deno.test("idling counts as progress", async () => {
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    leaseTtlMs: 30_000,
    maxStallMs: 20_000,
    idleBudgetMs: 10 * 60_000,
    now: () => t
  });

  await run.claim();
  for (let i = 0; i < 5; i++) {
    t += 15_000;
    assertEquals(await run.onIdle(), true);
  }
  assertEquals(run.shouldContinue(), true);
});

// ── Residency is earned by work ────────────────────────────────────────────────
// The cron spawns 2 isolates a minute and all of them claim. If the ones that find nothing stayed
// resident they would accumulate against maxParallelism — the admission-slot exhaustion
// workerRun.ts exists to prevent, arriving from the other direction.

Deno.test("a run that finds nothing returns once its idle budget is spent", async () => {
  const f = fakeRpc();
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, idleBudgetMs: 1_000, now: () => t });

  assertEquals(await run.claim(), null);
  t += 500;
  assertEquals(await run.onIdle(), true, "still inside the budget");
  t += 501;
  assertEquals(await run.onIdle(), false, "budget spent: return the isolate");
  assertEquals(run.shouldContinue(), false);
});

Deno.test("finding work resets the idle budget", async () => {
  // Nothing, then work, then nothing again: the budget must start over at the second gap or a
  // leaseholder that goes quiet for a moment mid-drain would exit part way through an org.
  let hasWork = false;
  const f = fakeRpc({ claim: () => ({ data: hasWork ? [row(1, "acme")] : [], error: null }) });
  let t = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, idleBudgetMs: 1_000, now: () => t });

  assertEquals(await run.claim(), null);
  t += 900;
  assertEquals(await run.onIdle(), true);

  hasWork = true;
  assertNotEquals(await run.claim(), null, "work found");

  hasWork = false;
  t += 900;
  assertEquals(await run.claim(), null);
  t += 900; // 2700ms into the run, but only 900ms since the budget restarted
  assertEquals(await run.onIdle(), true, "the budget restarts when work is found");
});

// ── RPC failure ────────────────────────────────────────────────────────────────

Deno.test("a claim failure throws so the caller backs off, and the run survives under the cap", async () => {
  const f = fakeRpc({ claim: () => ({ data: null, error: { message: "deadlock detected", code: "40P01" } }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 3 });

  const err = await assertRejects(() => run.claim(), OrgClaimError);
  assertStringIncludes(err.message, "deadlock detected");
  assertEquals(run.shouldContinue(), true, "one failure is a blip, not a reason to churn the isolate");

  await run.onError();
  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), true);
});

// Retrying in place only holds an admission slot: this isolate cannot do ANY work if it cannot
// claim. Ending the run costs one cron period and hands the retry to a fresh isolate.
Deno.test("consecutive claim failures end the run and give the slot back", async () => {
  const f = fakeRpc({ claim: () => new Error("socket hang up") });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 2 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), true);
  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), false);
  assertEquals(f.releaseCalls, 1);
});

Deno.test("a successful claim resets the failure count", async () => {
  const f = fakeRpc({
    claim: (_a, i) => (i === 2 ? { data: [row(1, "acme")], error: null } : new Error("socket hang up"))
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 2 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertNotEquals(await run.claim(), null);
  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), true, "the count is CONSECUTIVE failures, not total");
});

// The deploy-skew case, and the reason it is special-cased: the image can reach a database whose
// migration has not been applied. No number of retries fixes that, so it must not burn the cap.
Deno.test("a missing claim RPC ends the run on the first failure", async () => {
  const f = fakeRpc({
    claim: () => ({
      data: null,
      error: { message: "Could not find the function pgmq_public.claim_org_slot_and_read", code: "PGRST202" }
    })
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 5 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), false, "retrying a function that does not exist cannot help");
});

Deno.test("a finished run claims nothing more", async () => {
  const f = fakeRpc({ claim: () => new Error("socket hang up") });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 1 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), false);

  const callsBefore = f.claimArgs.length;
  assertEquals(await run.claim(), null);
  assertEquals(f.claimArgs.length, callsBefore, "a finished run must not keep hitting the RPC");
});

// ── Exit ───────────────────────────────────────────────────────────────────────

Deno.test("releasing stops the renewal timer", async () => {
  const timers = fakeTimers();
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  assertEquals(timers.active, 1);
  await run.release();
  assertEquals(timers.active, 0, "a leaked interval would hold the isolate alive");
});

// A failing release must not take the run down: the TTL frees the slot regardless, and this is the
// last thing that runs in the caller's `finally`.
Deno.test("a release that errors is swallowed", async () => {
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  const failing: OrgSlotRpc = { ...f.rpc, release: () => Promise.reject(new Error("gone")) };
  const run = beginOrgLeaseRun({ ...base, rpc: failing });

  await run.claim();
  await run.release();
});

// ── Rotating between queues ────────────────────────────────────────────────────
// A run does not stay on one queue. `async_calls_low_priority` is drained whenever the main queue
// is empty, so rotation is the NORMAL path, not an edge case. The slot pools are per queue and all
// three RPCs are queue-scoped, so a run may legitimately hold a lease in each pool for a while —
// what must never happen is the abandoned one being kept alive by the renewals of the live one.

Deno.test("rotating to the other queue releases the pool the run left", async () => {
  let mainHasWork = true;
  const t = fakeSlotTable({
    work: (q) => (q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : []) : [row(2, "globex")])
  });
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc });

  assertEquals((await run.claim())?.queueName, "async_calls");
  assertEquals(t.rows.length, 1);

  // The main queue drains; the next pass falls through to low priority and rotates.
  mainHasWork = false;
  assertEquals((await run.claim())?.queueName, "async_calls_low_priority");

  // The eager release is a LATENCY optimisation, not what makes this correct — but when it lands,
  // the org that was left gets its headroom back immediately instead of one TTL later.
  assertEquals(t.rows.length, 1);
  assertEquals(t.rows[0].queue, "async_calls_low_priority");
  assertEquals(run.heldQueue(), "async_calls_low_priority");
});

Deno.test("rotating back and forth never accumulates slots", async () => {
  let mainHasWork = true;
  const t = fakeSlotTable({
    work: (q) => (q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : []) : [row(2, "globex")])
  });
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc });

  for (let i = 0; i < 6; i++) {
    mainHasWork = i % 2 === 0;
    await run.claim();
    assertEquals(t.rows.length, 1, `iteration ${i} must own exactly one slot`);
  }
  assertEquals(t.rows[0].queue, "async_calls_low_priority");
});

// THE PROPERTY THAT ACTUALLY MAKES ROTATION SAFE, with the optimisation switched off. A run that
// rotates without releasing holds one lease per pool, which is legal; renewal is scoped to the pool
// it is draining, so the one it walked away from decays on its own TTL. Renewing across pools is
// what would turn a forgotten lease from a one-TTL cost into a permanent one.
Deno.test("an unreleased lease in the pool the run left lapses on its own TTL", async () => {
  let clock = 0;
  let mainHasWork = true;
  let releaseFails = true;
  const t = fakeSlotTable({
    work: (q) => (q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : []) : [row(2, "globex")]),
    now: () => clock,
    releaseFails: () => releaseFails
  });
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc, leaseTtlMs: 30_000, now: () => clock });

  await run.claim();
  mainHasWork = false;
  await run.claim();

  // One lease per pool. Legal now, and the run must not be confused about which one it holds.
  assertEquals(t.rows.length, 2, "a holder may hold one slot per pool");
  assertEquals(t.liveRows().length, 2);
  assertEquals(run.heldQueue(), "async_calls_low_priority");
  assertEquals(run.shouldContinue(), true, "a failed release must not make the run think it is done");

  const abandoned = t.rows.find((r) => r.queue === "async_calls")!;
  const live = t.rows.find((r) => r.queue === "async_calls_low_priority")!;
  const abandonedExpiry = abandoned.expiresAt;

  // Two heartbeats' worth of renewals, each past the ttl/3 interval.
  clock += 10_001;
  await run.heartbeat();
  clock += 10_001;
  await run.heartbeat();

  assertEquals(t.renewQueues(), ["async_calls_low_priority", "async_calls_low_priority"]);
  assertEquals(live.renewals, 2, "the held pool is kept alive");
  assertEquals(abandoned.renewals, 0, "the pool the run left is never renewed");
  assertEquals(abandoned.expiresAt, abandonedExpiry, "and its expiry is never pushed out");

  // Past the abandoned lease's TTL: it stops counting, and the live one is unaffected.
  const liveExpiry = live.expiresAt;
  clock = abandonedExpiry + 1;
  assertEquals(t.liveRows().length, 1, "the abandoned lease has lapsed");
  assertEquals(t.liveRows()[0].queue, "async_calls_low_priority");
  assertEquals(live.expiresAt, liveExpiry, "the surviving lease's expiry is untouched by the lapse");

  // And exit still retries the release it could not complete.
  releaseFails = false;
  await run.release();
  assertEquals(t.rows.length, 0);
});

// The constraint on the fix: releasing before PROBING the higher-priority queue would give up a
// live slot on every iteration that merely looks at it -- which is every iteration while the main
// queue is empty and low-priority work is draining -- and hand the org to a competitor in the gap.
Deno.test("probing the higher-priority queue while holding the other one does not churn slots", async () => {
  const t = fakeSlotTable({ work: (q) => (q === "async_calls" ? [] : [row(1, "globex")]) });
  const counted = { releases: 0 };
  const counting: OrgSlotRpc = {
    ...t.rpc,
    release: (args) => {
      counted.releases += 1;
      return t.rpc.release(args);
    }
  };
  const run = beginOrgLeaseRun({ ...base, rpc: counting });

  for (let i = 0; i < 5; i++) {
    assertEquals((await run.claim())?.queueName, "async_calls_low_priority");
    assertEquals(t.rows.length, 1);
  }

  assertEquals(counted.releases, 0, "a probe that claims nothing needs no release");
  assertEquals(t.rows[0].queue, "async_calls_low_priority");
});

// Priority has to survive the fix: the main queue is probed first on every pass, including while a
// low-priority slot is held, or a lone leaseholder would sit on low-priority work while the main
// queue backed up.
Deno.test("the main queue is probed first even while a low-priority slot is held", async () => {
  let mainHasWork = false;
  const probed: string[] = [];
  const t = fakeSlotTable({
    work: (q) => {
      probed.push(q);
      return q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : []) : [row(2, "globex")];
    }
  });
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc });

  await run.claim();
  assertEquals(run.heldQueue(), "async_calls_low_priority");

  probed.length = 0;
  mainHasWork = true;
  const claimed = await run.claim();

  assertEquals(probed[0], "async_calls", "priority order is not skipped for the held queue");
  assertEquals(claimed?.queueName, "async_calls", "main-queue work preempts the low-priority drain");
  assertEquals(t.rows.length, 1);
  assertEquals(t.rows[0].queue, "async_calls");
});

// ── Fatal claim failures ───────────────────────────────────────────────────────

// A queue with no seeded slot pool can never be claimed. That used to arrive as zero rows forever,
// which is indistinguishable from an empty queue, so the SQL now raises instead. Grinding through
// the 3-strikes counter would put the silence back.
Deno.test("an unseeded slot pool ends the run on the first failure", async () => {
  const f = fakeRpc({
    claim: () => ({
      data: null,
      error: {
        message:
          "claim_org_slot_and_read: no slot pool seeded for queue async_calls_low_priority, so this " +
          "queue can never drain. Seed public.async_worker_slots in a migration.",
        code: "P0001"
      }
    })
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 5 });

  const err = await assertRejects(() => run.claim(), OrgClaimError);
  assertStringIncludes(err.message, "no slot pool seeded");
  assertEquals(run.shouldContinue(), false, "a deployment error must not be retried into silence");
  assertEquals(f.claimArgs.length, 1, "and must not go on to probe the next queue");
});

// Every raise inside claim_org_slot_and_read is permanent — an unseeded pool, or an argument this
// module should never have sent — so the SQLSTATE is matched rather than the message text.
Deno.test("any claim the server refuses outright is fatal, whatever it says", async () => {
  const f = fakeRpc({
    claim: () => ({
      data: null,
      error: { message: "claim_org_slot_and_read: n must be >= 1 (got 0)", code: "P0001" }
    })
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 5 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), false);
});

// A transient database error is NOT one of those, and must still get its three attempts.
Deno.test("a transient error is still retried rather than treated as fatal", async () => {
  const f = fakeRpc({ claim: () => ({ data: null, error: { message: "deadlock detected", code: "40P01" } }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, maxConsecutiveClaimErrors: 3 });

  await assertRejects(() => run.claim(), OrgClaimError);
  assertEquals(run.shouldContinue(), true);
});

// ── Renewal racing rotation ────────────────────────────────────────────────────
// The renewal timer fires independently of the loop, so a renewal can be in flight while `claim()`
// rotates the run onto the other queue. The renewal was issued for the OLD queue; rotation releases
// that row; the RPC then correctly answers "you hold nothing there". Applying that answer to the
// NEW lease marks a slot the run had just claimed as lost and stops renewing it, so it expires
// mid-batch and a second leaseholder enters the same org -- breaking the per-org cap this feature
// exists to hold. A happy-path test cannot see any of this; the interleaving is the test.

Deno.test("a renewal that lands after a rotation cannot kill the new lease", async () => {
  let mainHasWork = true;
  let parkNextRenew = true;
  let parked = false;
  const gate = deferred();

  const t = fakeSlotTable({
    work: (q) => (q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : statusRow("no_demand")) : [row(2, "globex")])
  });
  const gated: OrgSlotRpc = {
    ...t.rpc,
    renew: async (args) => {
      if (parkNextRenew) {
        parkNextRenew = false;
        parked = true;
        await gate.promise;
      }
      return await t.rpc.renew(args);
    }
  };

  const timers = fakeTimers();
  const run = beginOrgLeaseRun({
    ...base,
    rpc: gated,
    leaseTtlMs: 30_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  assertEquals(run.heldQueue(), "async_calls");

  // A renewal for async_calls is now in flight and parked mid-call.
  timers.fireAll();
  await flush();
  assertEquals(parked, true, "the renewal must actually be in flight, or this test proves nothing");

  // The loop rotates underneath it, releasing the async_calls row. The parked renewal is now about
  // to be told -- correctly -- that it holds nothing there.
  mainHasWork = false;
  await run.claim();
  assertEquals(run.heldQueue(), "async_calls_low_priority");
  assertEquals(t.rows.length, 1);

  gate.resolve();
  await flush();

  assertEquals(run.shouldContinue(), true, "a stale renewal must not end the run");
  assertEquals(run.heldQueue(), "async_calls_low_priority", "nor drop the lease it just took");
  assertEquals(timers.active, 1, "nor stop the renewal timer keeping that lease alive");
  assertEquals(t.rows.length, 1, "and the live slot is still there to be renewed");
});

// The guard must discriminate, not just suppress: a renewal that is still current and comes back
// false has to end the run exactly as before, or losing a lease would go unnoticed.
Deno.test("a renewal for the lease still held is acted on normally", async () => {
  const f = fakeRpc({
    claim: () => ({ data: [row(1, "acme")], error: null }),
    renew: () => ({ data: false, error: null })
  });
  let clock = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => clock });

  await run.claim();
  clock += 10_001;
  await run.heartbeat();
  assertEquals(run.shouldContinue(), false, "a current renewal answering false still ends the run");
});

// The guard discards on OVERLAP, not on claim count. A renewal whose in-flight window does not
// straddle a claim is applied exactly as it always was, however many claims came before it --
// otherwise bumping on every claim would blind the run to a genuinely lost lease.
Deno.test("a renewal issued after the last claim is applied normally", async () => {
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let clock = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, leaseTtlMs: 30_000, now: () => clock });

  await run.claim();
  await run.claim();
  await run.claim();

  clock += 10_001;
  await run.heartbeat();
  assertEquals(f.renewCalls, 1);
  assertEquals(run.shouldContinue(), true, "the renewal was applied, not discarded");
});

// WHY DISCARDING AGGRESSIVELY IS FREE, which is the asymmetry the whole guard rests on. The renewal
// RPC still runs and still commits server-side; only the client's handling of the ANSWER is
// dropped. So a discarded success cannot un-extend anything -- it leaves `lastRenewAt` stale, which
// makes the next heartbeat renew more eagerly rather than less, while the interval timer (which
// never reads it) carries on regardless. An earlier version of this module bumped the generation
// only on a queue change precisely because this was assumed to be false.
Deno.test("a discarded successful renewal still extended the lease server-side", async () => {
  let clock = 0;
  let parkNextRenew = true;
  let parked = false;
  const gate = deferred();

  const t = fakeSlotTable({ work: () => [row(1, "acme")], now: () => clock });
  const gated: OrgSlotRpc = {
    ...t.rpc,
    renew: async (args) => {
      if (parkNextRenew) {
        parkNextRenew = false;
        parked = true;
        await gate.promise;
      }
      return await t.rpc.renew(args);
    }
  };

  const timers = fakeTimers();
  const run = beginOrgLeaseRun({
    ...base,
    rpc: gated,
    leaseTtlMs: 30_000,
    now: () => clock,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  const slot = t.rows[0];
  assertEquals(slot.expiresAt, 30_000);

  clock += 10_000;
  timers.fireAll();
  await flush();
  assertEquals(parked, true);

  // A same-queue re-claim lands while that renewal is in flight, so its result will be discarded.
  await run.claim();

  clock += 5_000;
  gate.resolve();
  await flush();

  assertEquals(slot.renewals, 1, "the renewal reached the server even though the answer was dropped");
  assertEquals(slot.expiresAt, 45_000, "and pushed the expiry out");
  assertEquals(run.shouldContinue(), true);
  assertEquals(timers.active, 1, "the lease is still being kept alive");
});

// ── Saturation: no_capacity vs no_demand ───────────────────────────────────────
// Zero rows used to mean both "nothing ready" and "ready work, no slot free", and the worker read
// both as "move on to the fallback queue" -- sending isolates to do repo analytics with GitHub
// capacity the backed-up main queue needed.

Deno.test("no_capacity on the main queue does not fall through to low priority", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_capacity"), error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  assertEquals(run.lastOutcome(), "no_capacity");
  assertEquals(
    f.claimArgs.map((a) => a.queue_name),
    ["async_calls"],
    "the fallback queue must not be probed while the main queue is backed up"
  );
});

// Ending the run rather than polling: the fleet is at its configured concurrency by definition, so
// another isolate adds occupancy and no throughput. Re-entry stays rate-limited by the cron.
Deno.test("no_capacity ends the run instead of holding an admission slot", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_capacity"), error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  await run.claim();
  assertEquals(run.shouldContinue(), false);
});

// And it must not spend the idle sleep on the way out -- that is an admission slot held for
// `idleSleepMs` on the one path whose entire point is to stop holding one.
Deno.test("no_capacity returns from onIdle without sleeping", async () => {
  let slept = 0;
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_capacity"), error: null }) });
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    sleep: () => {
      slept += 1;
      return Promise.resolve();
    }
  });

  await run.claim();
  assertEquals(await run.onIdle(), false);
  assertEquals(slept, 0, "a run that is already over must not sleep first");
});

// A leaseholder that holds a slot and then hits no_capacity has an org with no more ready work.
// Pinning it would count against global_cap and max_per_org for nothing.
Deno.test("no_capacity gives back a slot the run was holding", async () => {
  let saturated = false;
  const f = fakeRpc({
    claim: () => (saturated ? { data: statusRow("no_capacity"), error: null } : { data: [row(1, "acme")], error: null })
  });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  await run.claim();
  saturated = true;
  await run.claim();

  assertEquals(run.heldOrg(), null);
  assertEquals(f.releaseQueues, ["async_calls"]);
});

// no_demand is the opposite call: nobody else is working this queue, so a resident isolate is the
// lowest-latency way to pick up what arrives next, bounded by the idle budget.
Deno.test("no_demand still falls through and still idles", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_demand"), error: null }) });
  let clock = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, idleBudgetMs: 1_000, now: () => clock });

  assertEquals(await run.claim(), null);
  assertEquals(run.lastOutcome(), "no_demand");
  assertEquals(
    f.claimArgs.map((a) => a.queue_name),
    ["async_calls", "async_calls_low_priority"],
    "an empty main queue is exactly when the fallback queue should be drained"
  );
  assertEquals(run.shouldContinue(), true);
  clock += 500;
  assertEquals(await run.onIdle(), true);
});

// Deploy skew in the other direction: an image that reaches a database still running the previous
// function sees message rows with no `status` column at all. Claimed rows are therefore identified
// by `msg_id`, never by the status string -- reading the status would drop a batch whose visibility
// timeout had already been bumped and silently defer that work until the VT expired.
Deno.test("messages are still claimed when the rows carry no status column", async () => {
  const legacy = { ...row(1, "acme") } as Record<string, unknown>;
  delete legacy.status;
  const f = fakeRpc({ claim: () => ({ data: [legacy as unknown as OrgSlotRow], error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  const claimed = await run.claim();
  assertEquals(claimed?.org, "acme");
  assertEquals(claimed?.messages.length, 1);
  assertEquals(run.lastOutcome(), "claimed");
});

// And a genuinely empty result -- the pre-status contract's way of saying "nothing here" -- has to
// read as no_demand, not as no_capacity, or the worker would stop draining against a database that
// simply has not been migrated yet.
Deno.test("an empty result reads as no_demand rather than no_capacity", async () => {
  const f = fakeRpc();
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  assertEquals(run.lastOutcome(), "no_demand");
  assertEquals(run.shouldContinue(), true);
});

// The same class of bug as the rotation race, in the case the first guard deliberately excluded.
// A renewal can evaluate to false server-side (the TTL lapsed a moment earlier) and have its
// response delayed; meanwhile `claim()` re-takes the SAME queue and the SQL refreshes `expires_at`.
// A guard keyed only on the queue NAME sees no change, applies the stale false to the refreshed
// lease, and stops its timer while the newly claimed batch runs -- so the lease lapses and another
// worker enters the org. A successful claim is newer and more authoritative evidence of ownership
// than an older renewal's answer, so it has to invalidate that answer.
Deno.test("a renewal that resolves false after a same-queue re-claim cannot kill the refreshed lease", async () => {
  let parkNextRenew = true;
  let parked = false;
  const gate = deferred();

  const t = fakeSlotTable({ work: () => [row(1, "acme")] });
  const gated: OrgSlotRpc = {
    ...t.rpc,
    renew: async (args) => {
      if (parkNextRenew) {
        parkNextRenew = false;
        parked = true;
        await gate.promise;
        // Evaluated BEFORE the re-claim, delivered after: the lease really had lapsed at the moment
        // the server looked, and the answer is only now arriving.
        return { data: false, error: null };
      }
      return await t.rpc.renew(args);
    }
  };

  const timers = fakeTimers();
  const run = beginOrgLeaseRun({
    ...base,
    rpc: gated,
    leaseTtlMs: 30_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  assertEquals(run.heldQueue(), "async_calls");

  // A renewal is in flight and parked; it is going to come back false.
  timers.fireAll();
  await flush();
  assertEquals(parked, true, "the renewal must actually be in flight, or this test proves nothing");

  // The loop re-claims the SAME queue underneath it. The SQL refreshes this holder's row, so the
  // run demonstrably owns a live slot -- newer information than the parked renewal carries.
  assertNotEquals(await run.claim(), null);
  assertEquals(run.heldQueue(), "async_calls");
  assertEquals(t.rows.length, 1);

  gate.resolve();
  await flush();

  assertEquals(run.shouldContinue(), true, "a renewal older than the re-claim must not end the run");
  assertEquals(run.heldQueue(), "async_calls", "nor drop the lease the re-claim established");
  assertEquals(timers.active, 1, "nor stop the timer keeping that refreshed lease alive");
});
