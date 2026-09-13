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
import {
  beginOrgLeaseRun,
  OrgClaimError,
  type OrgQueueMessage,
  type OrgSlotRpc,
  type RpcResult
} from "./orgLeaseRun.ts";

type ClaimArgs = Parameters<OrgSlotRpc["claim"]>[0];

function row(msgId: number, org: string): OrgQueueMessage {
  return {
    org,
    msg_id: msgId,
    read_ct: 1,
    enqueued_at: "2026-09-13T00:00:00Z",
    vt: "2026-09-13T00:05:00Z",
    message: { method: "create_repo" }
  };
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
    claim?: (args: ClaimArgs, callIndex: number) => RpcResult<OrgQueueMessage[]> | Error;
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
  work: (queueName: string) => OrgQueueMessage[];
  now?: () => number;
  releaseFails?: () => boolean;
}) {
  const rows: SlotRow[] = [];
  const renewedQueues: string[] = [];
  const now = init.now ?? (() => 0);

  const rpc: OrgSlotRpc = {
    claim: (args) => {
      const out = init.work(args.queue_name);
      // No work means no org qualified, so the SQL writes no slot row and leaves any existing one
      // alone. That is what makes probing a queue you do not hold free.
      if (out.length === 0) return Promise.resolve({ data: [], error: null });
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
  // One per pool this run has sent a claim to: the slot it actually held, plus the low-priority pool
  // it probed on the way past. The second is a no-op RPC, and it is kept deliberately -- a claim
  // whose response was lost may have committed a row there, and one wasted call per idle transition
  // is a better trade than tracking which responses arrived.
  assertEquals(f.releaseCalls, 2);
  assertEquals(f.releaseQueues, ["async_calls", "async_calls_low_priority"]);
  assertEquals(f.releaseArgs[0].holder, run.holder);
  assertEquals(run.heldOrg(), null);
  assertEquals(run.heldQueue(), null);
});

// Insurance against a claim whose response was lost after the server committed it: we would hold a
// row we never learned about, and only an unconditional release cleans that up before the TTL.
// Safe because the holder string is the row key, so this cannot touch anyone else's slot.
Deno.test("exiting releases even when the run believes it holds nothing", async () => {
  const f = fakeRpc();
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  await run.release();
  assertEquals(f.releaseCalls, 2, "one per pool probed: either response could have been the lost one");
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
