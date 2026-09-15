/**
 * The per-org lease state machine.
 *
 * These are the properties that stop a per-org leaseholder from being worse than the single
 * leaseholder it replaces: a slot is given back the moment it stops being used, a wedged holder
 * cannot keep an org to itself, and a broken RPC ends the run instead of parking an isolate on an
 * admission slot forever. The RPC is injected, so none of this needs a database — the SQL side is
 * pinned by contract and verified separately.
 */

import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@^1";
import { PER_MESSAGE_VT_BUDGET_SECONDS, resolveAsyncWorkerTuning } from "./asyncWorkerTuning.ts";
import {
  beginOrgLeaseRun,
  drainOrgLease,
  drainWithContinuousRefill,
  isolateStartedAtMs,
  OrgClaimError,
  type OrgQueueMessage,
  type OrgSlotRow,
  type OrgSlotRpc,
  type RpcResult
} from "./orgLeaseRun.ts";

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
 * it can never be recognized as the missing-function case).
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

/**
 * A stand-in for the ALLOCATOR'S ORG CHOICE, which is the one thing `fakeSlotTable` does not model.
 *
 * `fakeSlotTable` reproduces the slot ROWS; this reproduces the `winner` CTE's decision, because
 * that decision is what pinning changes. It implements the pinned contract exactly as agreed with
 * the SQL side:
 *
 *   - `pin_org` absent  -> the neediest org with ready work wins, which is what lets a run at rest
 *                          rotate onto whichever class is backed up;
 *   - `pin_org` present -> that org ALONE is considered, with no fallback to re-picking. Ready work
 *                          means `claimed`, no ready work means `no_demand`.
 *
 * The no-fallback half is the part worth modelling: a fake that quietly served the neediest org when
 * the pinned one was empty would make the pin look like it worked while the cap kept breaking.
 */
function fakeOrgAllocator(init: { ready: Record<string, number>; queueName?: string }) {
  const ready: Record<string, number> = { ...init.ready };
  const onQueue = init.queueName ?? "async_calls";
  const pins: (string | undefined)[] = [];
  let nextMsgId = 1;

  const rpc: OrgSlotRpc = {
    claim: (args) => {
      pins.push(args.pin_org);
      if (args.queue_name !== onQueue) return Promise.resolve({ data: statusRow("no_demand"), error: null });
      const candidates =
        args.pin_org === undefined
          ? Object.keys(ready)
              .filter((o) => ready[o] > 0)
              .sort((a, b) => ready[b] - ready[a] || a.localeCompare(b))
          : [args.pin_org].filter((o) => (ready[o] ?? 0) > 0);
      const org = candidates[0];
      if (org === undefined) return Promise.resolve({ data: statusRow("no_demand"), error: null });
      const take = Math.min(args.n, ready[org]);
      ready[org] -= take;
      const rows: OrgSlotRow[] = [];
      for (let i = 0; i < take; i++) rows.push(row(nextMsgId++, org));
      return Promise.resolve({ data: rows, error: null });
    },
    renew: () => Promise.resolve({ data: true, error: null }),
    release: () => Promise.resolve({ data: null, error: null })
  };

  return {
    rpc,
    pins,
    setReady(org: string, count: number) {
      ready[org] = count;
    }
  };
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

  // The eager release is a LATENCY optimization, not what makes this correct — but when it lands,
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

// THE PROPERTY THAT ACTUALLY MAKES ROTATION SAFE, with the optimization switched off. A run that
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

// ── Continuous refill ──────────────────────────────────────────────────────────
// The property these pin is THROUGHPUT, so "the messages all got processed" proves nothing: the
// batch loop this replaces processed every message too, at 73% of the concurrency it was claiming.
// What follows is a deterministic simulation — a fake claim RPC, virtual time, and a duration
// distribution fitted to production — that measures effective concurrency the same way the incident
// was measured, and it is written to FAIL against batch-at-a-time.

/**
 * The 2026-09-14 `Khoury-CS3650` burst, as a distribution.
 *
 * Reconstructed from `pgmq.a_async_calls` (`vt - 480s` is the read time, `archived_at` the finish):
 * 190 messages, mean duration 48.4s, mean slowest-of-four 68.4s, worst single message 94.8s. That
 * shape is bimodal rather than lognormal — most `create_repo` calls land near 38s and roughly one in
 * five stalls behind the per-org content limiter around 80s — and it is the GAP between those two
 * modes that batch-at-a-time pays for, so a unimodal fixture would quietly understate the thing being
 * measured. Fitted to hit all three moments; `durationFixtureStats` asserts it still does.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATION_SEED = 20260914;

function productionDurationsSeconds(count: number): number[] {
  const rand = mulberry32(DURATION_SEED);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // Sum of three uniforms as a cheap, deterministic, bounded normal.
    const g = (rand() + rand() + rand() - 1.5) * 2;
    const slow = rand() < 0.2;
    const v = slow ? 80 + g * 8 : 38 + g * 6;
    out.push(Math.max(6, Math.min(95, Math.round(v * 10) / 10)));
  }
  return out;
}

function durationFixtureStats(durations: number[], groupSize: number) {
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  let slowestSum = 0;
  let groups = 0;
  for (let i = 0; i + groupSize <= durations.length; i += groupSize) {
    slowestSum += Math.max(...durations.slice(i, i + groupSize));
    groups++;
  }
  return { mean, slowestOfGroup: slowestSum / groups, max: Math.max(...durations) };
}

/**
 * Virtual time. Message durations are tens of seconds and a run is half an hour, so the simulation
 * cannot use real timers; and the numbers it reports have to be exact rather than flaky, so it
 * cannot use approximate ones either. `advance()` drains the microtask queue, jumps the clock to the
 * next scheduled wake-up, and fires everything due — meaning the clock only ever moves when the
 * system under test is genuinely parked, which is what makes the measurement deterministic.
 */
function virtualClock() {
  let nowMs = 0;
  let pending: { at: number; wake: () => void }[] = [];
  return {
    now: () => nowMs,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: nowMs + Math.max(0, ms), wake: resolve });
      }),
    async advance(): Promise<boolean> {
      await flush();
      if (pending.length === 0) return false;
      nowMs = pending.reduce((lowest, p) => (p.at < lowest ? p.at : lowest), Number.POSITIVE_INFINITY);
      const due = pending.filter((p) => p.at <= nowMs);
      pending = pending.filter((p) => p.at > nowMs);
      for (const d of due) d.wake();
      await flush();
      return true;
    }
  };
}

type VirtualClock = ReturnType<typeof virtualClock>;

async function runOnVirtualTime(clock: VirtualClock, work: Promise<void>) {
  let settled = false;
  const watched = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  let guard = 0;
  while (!settled) {
    if (!(await clock.advance())) break;
    if (++guard > 50_000) throw new Error("the virtual clock never went idle");
  }
  await watched;
  await work;
}

/** One PostgREST round trip. Small next to a message, but it is the only thing refill can idle on. */
const CLAIM_LATENCY_MS = 20;

/** A single org with a burst of ready messages on `async_calls`, and nothing anywhere else. */
function burstRpc(clock: VirtualClock, msgIds: number[], org: string) {
  const ready = [...msgIds];
  const askedFor: number[] = [];
  const pins: (string | undefined)[] = [];
  const rpc: OrgSlotRpc = {
    claim: async (args) => {
      askedFor.push(args.n);
      pins.push(args.pin_org);
      await clock.sleep(CLAIM_LATENCY_MS);
      if (args.queue_name !== "async_calls") return { data: statusRow("no_demand"), error: null };
      // Honours the pin, so the simulation measures refill WITH the safety property it ships with
      // rather than without it. One org, so a pin can only ever name that org — but a pin naming
      // anything else must come back empty, not be quietly ignored.
      if (args.pin_org !== undefined && args.pin_org !== org) {
        return { data: statusRow("no_demand"), error: null };
      }
      const take = ready.splice(0, args.n);
      if (take.length === 0) return { data: statusRow("no_demand"), error: null };
      return { data: take.map((id) => row(id, org)), error: null };
    },
    renew: () => Promise.resolve({ data: true, error: null }),
    release: () => Promise.resolve({ data: null, error: null })
  };
  return { rpc, askedFor, pins };
}

/**
 * Effective concurrency by Little's law, which is how the 5.20 was measured on production: total
 * busy message-seconds over the wall clock they were spread across. Utilization is that against the
 * concurrency the leaseholder was configured for and was continuously claiming slot-time to hold.
 */
function concurrencyMeter() {
  const spans: { start: number; end: number }[] = [];
  let live = 0;
  let peak = 0;
  return {
    enter() {
      live++;
      if (live > peak) peak = live;
    },
    exit(start: number, end: number) {
      live--;
      spans.push({ start, end });
    },
    get peakInFlight() {
      return peak;
    },
    get count() {
      return spans.length;
    },
    report(configuredConcurrency: number) {
      const busy = spans.reduce((a, s) => a + (s.end - s.start), 0);
      const first = Math.min(...spans.map((s) => s.start));
      const last = Math.max(...spans.map((s) => s.end));
      const effectiveConcurrency = busy / (last - first);
      return {
        effectiveConcurrency,
        utilization: effectiveConcurrency / configuredConcurrency,
        wallClockSeconds: (last - first) / 1000
      };
    }
  };
}

const SIM_CONCURRENCY = 4;
const SIM_MESSAGES = 190;

function simBase(clock: VirtualClock) {
  return {
    ...base,
    drainConcurrency: SIM_CONCURRENCY,
    visibilityTimeoutSeconds: 480,
    maxPerOrg: 2,
    globalCap: 8,
    idleSleepMs: 15_000,
    idleBudgetMs: 30_000,
    now: clock.now,
    sleep: clock.sleep
  };
}

function simWorker(clock: VirtualClock, meter: ReturnType<typeof concurrencyMeter>, durations: number[]) {
  return async (message: OrgQueueMessage) => {
    const start = clock.now();
    meter.enter();
    await clock.sleep(durations[(message.msg_id - 1) % durations.length] * 1000);
    meter.exit(start, clock.now());
  };
}

/**
 * Production's shape, as environment variables, so the simulation resolves its tuning through the
 * SAME `resolveAsyncWorkerTuning` the worker calls rather than through a hand-built object. A kill
 * switch is only worth testing end to end: "the flag is read" and "the other branch still drains"
 * are different claims, and it is the second one that nobody exercises until they need it.
 */
const SIM_ENV: Record<string, string> = {
  GITHUB_ASYNC_WORKER_DRAIN_CONCURRENCY: "4",
  GITHUB_ASYNC_WORKER_VISIBILITY_TIMEOUT_SECONDS: "480",
  EDGE_WORKER_TIMEOUT_MS: "480000",
  GITHUB_ASYNC_WORKER_ORG_SLOT_GLOBAL_CAP: "8",
  GITHUB_ASYNC_WORKER_ORG_SLOT_MAX_PER_ORG: "2"
};

function simTuning(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...SIM_ENV, ...overrides };
  // asyncWorkerTuning.ts takes a `{ get(name) }`, not the bare function `SentryContext.ts` calls an
  // EnvReader. Same idea, two spellings, and this is the seam that keeps `Deno.env` out of both.
  return resolveAsyncWorkerTuning({ get: (key: string) => env[key] });
}

/**
 * One drive, either shape, selected exactly as the worker selects it: `drainOrgLease` with the
 * boolean the resolver produced. Nothing here calls a driver directly, so a switch that was wired to
 * the wrong branch — or to nothing — would show up as the wrong utilization rather than as a passing
 * test.
 */
async function simulateOrgLeaseDrain(durations: number[], tuning: ReturnType<typeof resolveAsyncWorkerTuning>) {
  const clock = virtualClock();
  const meter = concurrencyMeter();
  const q = burstRpc(
    clock,
    durations.map((_, i) => i + 1),
    "Khoury-CS3650"
  );
  const work = simWorker(clock, meter, durations);
  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({
    ...simBase(clock),
    drainConcurrency: tuning.drainConcurrency,
    rpc: q.rpc,
    inFlightCount: () => inFlight.size
  });

  await runOnVirtualTime(
    clock,
    (async () => {
      try {
        await drainOrgLease({
          run,
          inFlight,
          maxInFlight: tuning.drainConcurrency,
          continuousRefill: tuning.orgSlots.continuousRefill,
          process: (message) => work(message)
        });
      } finally {
        await run.release();
      }
    })()
  );
  return { meter, claims: q.askedFor, pins: q.pins, inFlightAtExit: inFlight.size };
}

// The fixture IS the measurement, so it gets asserted rather than trusted. If someone retunes it and
// the throughput test still passes, the test has stopped meaning anything.
Deno.test("the duration fixture reproduces the measured burst", () => {
  const stats = durationFixtureStats(productionDurationsSeconds(SIM_MESSAGES), SIM_CONCURRENCY);

  assertEquals(Math.abs(stats.mean - 48.4) < 1.5, true, `mean ${stats.mean.toFixed(1)}s, measured 48.4s`);
  assertEquals(
    Math.abs(stats.slowestOfGroup - 68.4) < 2,
    true,
    `slowest-of-4 ${stats.slowestOfGroup.toFixed(1)}s, measured 68.4s`
  );
  assertEquals(Math.abs(stats.max - 94.8) < 3, true, `worst ${stats.max.toFixed(1)}s, measured 94.8s`);
});

// The switch has to default to ON and it has to be an INTEGER. `Boolean("false") === true`, so a
// string-valued kill switch fails open at exactly the moment someone reaches for it; the tuning file
// reads it through the same bounded-integer path as the other three knobs, and this is the assertion
// that the worker's side of that agreement is the resolved boolean rather than a second reading.
Deno.test("the continuous-refill switch defaults on and rejects a value that is not 0 or 1", () => {
  assertEquals(
    simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: undefined }).orgSlots.continuousRefill,
    true,
    "unset means refill, so deploying the switch changes nothing on its own"
  );
  assertEquals(simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: "1" }).orgSlots.continuousRefill, true);
  assertEquals(simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: "0" }).orgSlots.continuousRefill, false);

  // The failure mode a string switch has: "false" is not 0, and must not quietly enable anything.
  const nonsense = simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: "false" });
  assertEquals(nonsense.issues.length > 0, true, "a value outside 0|1 is reported, not silently coerced");
});

// THE HEADLINE, and the kill switch's only honest test. Same fixture, same lease, same fake RPC,
// same entry point; the only difference between the two arms is one environment variable, resolved
// by the real `resolveAsyncWorkerTuning`. Batch-and-wait must land near the 0.708 measured on
// production (mean 48.4s per message against a mean 68.4s batch), and refill must not.
Deno.test("the continuous-refill switch picks the drain shape, and both shapes drain", async () => {
  const durations = productionDurationsSeconds(SIM_MESSAGES);

  const off = simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: "0" });
  const on = simTuning();

  // The two arms differ by ONE resolved boolean and nothing else, or the comparison below is
  // measuring something other than the switch.
  assertEquals(on.issues, [], "the simulated environment must resolve cleanly");
  assertEquals(off.issues, []);
  assertEquals(on.drainConcurrency, off.drainConcurrency);
  assertEquals(on.drainConcurrency, SIM_CONCURRENCY);
  assertEquals(on.orgSlots.continuousRefill, true);
  assertEquals(off.orgSlots.continuousRefill, false);

  const batch = await simulateOrgLeaseDrain(durations, off);
  const refill = await simulateOrgLeaseDrain(durations, on);

  const b = batch.meter.report(SIM_CONCURRENCY);
  const r = refill.meter.report(SIM_CONCURRENCY);
  console.log(
    `\n  batch-at-a-time  : concurrency ${b.effectiveConcurrency.toFixed(2)}/${SIM_CONCURRENCY} ` +
      `= ${(b.utilization * 100).toFixed(1)}% utilization, ${(b.wallClockSeconds / 60).toFixed(1)} min, ` +
      `${batch.claims.length} claims\n` +
      `  continuous refill: concurrency ${r.effectiveConcurrency.toFixed(2)}/${SIM_CONCURRENCY} ` +
      `= ${(r.utilization * 100).toFixed(1)}% utilization, ${(r.wallClockSeconds / 60).toFixed(1)} min, ` +
      `${refill.claims.length} claims\n`
  );

  assertEquals(batch.meter.count, SIM_MESSAGES, "batch mode must still drain every message");
  assertEquals(refill.meter.count, SIM_MESSAGES, "and so must refill");

  // The number from the incident: mean 48.4s per message against a mean 68.4s batch.
  assertEquals(
    b.utilization > 0.66 && b.utilization < 0.78,
    true,
    `batch-at-a-time utilization ${b.utilization.toFixed(3)} should reproduce the measured ~0.71`
  );
  assertEquals(
    r.utilization > 0.95,
    true,
    `continuous refill utilization ${r.utilization.toFixed(3)} should be ~1; the remainder is the ` +
      `ramp-down as the burst runs out, plus one ${CLAIM_LATENCY_MS}ms claim per message`
  );
  assertEquals(
    r.wallClockSeconds < b.wallClockSeconds * 0.8,
    true,
    `refill drained in ${(r.wallClockSeconds / 60).toFixed(1)} min against ${(b.wallClockSeconds / 60).toFixed(1)}`
  );

  // THE ROLLBACK IS TOTAL, and it is visible in the RPC traffic rather than only in the timing. The
  // batch shape never puts anything in the in-flight set, so it never asks for a shortfall and never
  // pins — every lease behavior continuous refill added is keyed on that set being non-empty, so
  // switching the flag off reverts the state machine and not just the loop.
  assertEquals(
    batch.claims.every((n) => n === SIM_CONCURRENCY),
    true,
    "batch-at-a-time always re-reads a whole batch; a shortfall claim would mean refill leaked in"
  );
  assertEquals(
    batch.pins.every((p) => p === undefined),
    true,
    "and it never pins, because it never claims with work in flight"
  );
  assertEquals(batch.inFlightAtExit, 0);
  assertEquals(
    refill.claims.some((n) => n < SIM_CONCURRENCY),
    true,
    "refill tops up the shortfall"
  );
  assertEquals(
    refill.pins.some((p) => p === "Khoury-CS3650"),
    true,
    "and pins those top-ups to the org it is already draining"
  );
});

// The ceiling is unchanged and that is the whole safety argument: refill buys utilization of `n`,
// never more than `n`. `maxPerOrg x n` is what bounds one org against its GitHub content quota.
Deno.test("refill never exceeds the configured concurrency, and never asks for more than it can hold", async () => {
  const durations = productionDurationsSeconds(SIM_MESSAGES);
  const refill = await simulateOrgLeaseDrain(durations, simTuning());

  assertEquals(refill.meter.peakInFlight, SIM_CONCURRENCY, "the ceiling is reached but never passed");
  assertEquals(
    refill.claims.every((n) => n >= 1 && n <= SIM_CONCURRENCY),
    true,
    `claims asked for ${[...new Set(refill.claims)].sort().join(", ")}; every one must be in [1, n]`
  );
  assertEquals(refill.claims[0], SIM_CONCURRENCY, "the first claim of a run has the whole batch to fill");
});

// The cost side of the trade, kept honest. Every claim takes a GLOBAL pg_advisory_xact_lock, so
// claim traffic is a shared resource: refill moves from one claim per BATCH to roughly one per
// MESSAGE, and that is acceptable only because it stays ~4x rather than becoming unbounded.
Deno.test("refill costs about one claim per message, not one per message per slot", async () => {
  const durations = productionDurationsSeconds(SIM_MESSAGES);
  const batch = await simulateOrgLeaseDrain(
    durations,
    simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_CONTINUOUS_REFILL: "0" })
  );
  const refill = await simulateOrgLeaseDrain(durations, simTuning());

  console.log(
    `\n  claims: batch ${batch.claims.length}, refill ${refill.claims.length}, for ${SIM_MESSAGES} messages\n`
  );
  assertEquals(
    refill.claims.length <= SIM_MESSAGES * 1.35,
    true,
    `${refill.claims.length} claims for ${SIM_MESSAGES} messages is more than the shortfall rule should cost`
  );
  assertEquals(
    refill.claims.length > batch.claims.length,
    true,
    "refill does cost more claims; the point is that it is bounded by throughput"
  );
});

// ── Refill and the lease ───────────────────────────────────────────────────────
// A claim can now land while `n-1` messages are still running, and three of the lease's decisions
// were written when that was impossible.

// Releasing here would tell the slot table this org has zero concurrency while this isolate runs
// n-1 handlers against it — and the allocator would let a second leaseholder in on top.
Deno.test("a claim that finds no work keeps the slot while messages are still running", async () => {
  const f = fakeRpc({ claim: (_a, i) => ({ data: i === 1 ? [row(1, "acme")] : statusRow("no_demand"), error: null }) });
  let inFlight = 0;
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    idleBudgetMs: 1_000,
    now: () => t,
    inFlightCount: () => inFlight
  });

  await run.claim();
  inFlight = 3;

  assertEquals(await run.claim(), null);
  assertEquals(f.releaseCalls, 0, "the slot is still in use, whatever the queue says about new work");
  assertEquals(run.heldOrg(), "acme");
  assertEquals(run.shouldContinue(), true);

  // AND THE IDLE BUDGET HAS NOT STARTED. A draining leaseholder is not an idle one; arming the
  // deadline here would end the run the moment the stream did, instead of waiting for the next
  // arrival.
  t += 5_000;
  inFlight = 0;
  assertEquals(await run.claim(), null);
  assertEquals(f.releaseCalls, 1, "now there is nothing running, the slot goes back");
  t += 500;
  assertEquals(await run.onIdle(), true, "and the budget starts from here, not from the first empty claim");
  t += 501;
  assertEquals(await run.onIdle(), false);
});

// `no_capacity` ends the run — that is unchanged — but it can now end a run that still has work
// under its lease, and a 60s TTL does not survive a 94.8s message.
Deno.test("no_capacity mid-stream ends the run but keeps the lease alive until the drain finishes", async () => {
  const timers = fakeTimers();
  const f = fakeRpc({
    claim: (_a, i) => ({ data: i === 1 ? [row(1, "acme")] : statusRow("no_capacity"), error: null })
  });
  let inFlight = 0;
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    leaseTtlMs: 30_000,
    now: () => t,
    inFlightCount: () => inFlight,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  inFlight = 2;
  assertEquals(await run.claim(), null);

  assertEquals(run.shouldContinue(), false, "the fleet is saturated; this isolate stops claiming");
  assertEquals(f.releaseCalls, 0, "but it does not hand back a slot it is still working under");

  // The timer keeps renewing even though the run is over, or the lease lapses mid-drain and another
  // leaseholder joins us in the same org.
  t += 10_001;
  timers.fireAll();
  await flush();
  assertEquals(f.renewCalls, 1, "a finished-but-draining run must keep its lease alive");

  inFlight = 0;
  await run.release();
  assertEquals(f.releaseCalls, 1, "and the drain being over is what finally releases it");
});

Deno.test("a fatal claim failure mid-stream also defers the release", async () => {
  const f = fakeRpc({
    claim: (_a, i) =>
      i === 1
        ? { data: [row(1, "acme")], error: null }
        : { data: null, error: { message: "no slot pool seeded for queue async_calls", code: "P0001" } }
  });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, inFlightCount: () => inFlight });

  await run.claim();
  inFlight = 4;
  await assertRejects(() => run.claim(), OrgClaimError);

  assertEquals(run.shouldContinue(), false, "a deployment error is still fatal on the first failure");
  assertEquals(f.releaseCalls, 0, "the messages already claimed are still ours to finish");
});

// ── Refill and priority ────────────────────────────────────────────────────────

// A momentary gap on the main queue must not be filled with analytics work: that would put both
// queues in one in-flight set, hold a slot in both pools at once, and spend capacity the main queue
// is about to want.
Deno.test("a main-queue stream is not topped up from the low-priority queue", async () => {
  let mainHasWork = true;
  const probed: string[] = [];
  const t = fakeSlotTable({
    work: (q) => {
      probed.push(q);
      return q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : statusRow("no_demand")) : [row(2, "globex")];
    }
  });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc, inFlightCount: () => inFlight });

  assertEquals((await run.claim())?.queueName, "async_calls");
  inFlight = 3;
  mainHasWork = false;
  probed.length = 0;

  assertEquals(await run.claim(), null, "the main queue has nothing right now, and that is the answer");
  assertEquals(probed, ["async_calls"], "the fallback queue is not probed behind a live main-queue stream");
  assertEquals(run.heldQueue(), "async_calls");
  assertEquals(t.rows.length, 1, "and no second pool is entered");

  // When the stream really has ended, the very next claim probes everything again — this is the
  // same `no_demand` fall-through the contract has always had, at stream granularity.
  inFlight = 0;
  probed.length = 0;
  assertEquals((await run.claim())?.queueName, "async_calls_low_priority");
  assertEquals(probed, ["async_calls", "async_calls_low_priority"]);
});

// An EARLIER VERSION OF THIS TEST asserted the opposite: that a low-priority stream probes
// `async_calls` on every refill and rotates to it mid-stream. That was wrong, and it is worth
// recording why rather than quietly flipping it. Rotating to another queue mid-stream releases the
// pool the in-flight messages were claimed under, so their org stops being counted — the same
// `max_per_org x n + (n-1)` breach that pinning closes for orgs, arriving one level up. Preemption
// is real and worth keeping, so it is bought back a different way: only the highest-priority queue
// is streamed, a lower-priority one drains its batch, and the full unpinned probe happens at that
// boundary. Same preemption cadence as before refill existed — one batch — with no breach.
Deno.test("a low-priority stream is not topped up, so the main queue is re-probed every batch", async () => {
  let mainHasWork = false;
  const probed: string[] = [];
  const t = fakeSlotTable({
    work: (q) => {
      probed.push(q);
      return q === "async_calls" ? (mainHasWork ? [row(1, "acme")] : statusRow("no_demand")) : [row(2, "globex")];
    }
  });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: t.rpc, inFlightCount: () => inFlight });

  assertEquals((await run.claim())?.queueName, "async_calls_low_priority");
  inFlight = 2;
  mainHasWork = true;
  probed.length = 0;

  assertEquals(await run.claim(), null, "a stream below the top priority quiesces instead of topping up");
  assertEquals(probed, [], "and it does not spend an RPC to discover that");
  assertEquals(t.rows.length, 1, "the slot it is draining under is untouched");
  assertEquals(run.shouldContinue(), true);

  // The batch settles. The next claim is the full unpinned probe, main queue first.
  inFlight = 0;
  const claimed = await run.claim();
  assertEquals(probed[0], "async_calls", "priority order is intact at the boundary where rotating is free");
  assertEquals(claimed?.queueName, "async_calls", "main-queue work preempts the next low-priority batch");
  assertEquals(t.rows.length, 1, "and the pool it left is released on rotation, as it always was");
});

// ── Pinning a top-up to its org ────────────────────────────────────────────────
// `claim_org_slot_and_read` re-points THIS HOLDER'S slot row at whichever org it picks. Between
// streams that is the feature. Mid-stream it is a silent cap breach: the `n-1` messages still
// running for the org we just left stop being counted, so that org reaches `max_per_org x n + (n-1)`
// — 11 against a configured 8.

Deno.test("a refill top-up stays on its org even when a needier one is waiting", async () => {
  const alloc = fakeOrgAllocator({ ready: { acme: 10, globex: 4 } });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: alloc.rpc, drainConcurrency: 4, inFlightCount: () => inFlight });

  // Nothing in flight, so this one is unpinned and correctly takes the neediest org.
  assertEquals((await run.claim())?.org, "acme");
  inFlight = 4;

  // Another class releases and is now far needier. An unpinned top-up would hand our row to it and
  // leave acme's four in-flight create_repos uncounted.
  alloc.setReady("globex", 50);
  const topUp = await run.claim(1);

  assertEquals(topUp?.org, "acme", "a top-up extends the stream it is part of; it does not rotate");
  assertEquals(alloc.pins, [undefined, "acme"], "and it says so, rather than hoping the allocator agrees");
  assertEquals(run.heldOrg(), "acme");
});

// The other half: the rotation this run gives up mid-stream is the one it is still supposed to make
// at rest, or a leaseholder would pin itself to a drained org for the rest of its life.
Deno.test("a claim with nothing in flight is unpinned and still rotates onto the neediest org", async () => {
  const alloc = fakeOrgAllocator({ ready: { acme: 10, globex: 4 } });
  const run = beginOrgLeaseRun({ ...base, rpc: alloc.rpc, drainConcurrency: 4 });

  assertEquals((await run.claim())?.org, "acme");
  alloc.setReady("globex", 50);
  assertEquals((await run.claim())?.org, "globex", "with nothing in flight, rotating costs nothing and is right");
  assertEquals(alloc.pins, [undefined, undefined]);
});

// A pinned org whose ready set has emptied must come back `no_demand` and STOP there — not fall
// back to another org, and not fall through to the next queue.
Deno.test("a pinned top-up that finds nothing does not fall back to another org or queue", async () => {
  const alloc = fakeOrgAllocator({ ready: { acme: 4, globex: 50 } });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: alloc.rpc, drainConcurrency: 4, inFlightCount: () => inFlight });

  assertEquals((await run.claim())?.org, "globex");
  inFlight = 4;
  alloc.setReady("globex", 0);

  assertEquals(await run.claim(2), null, "globex is drained, so there is nothing to top up with");
  assertEquals(alloc.pins, [undefined, "globex"], "acme is needier, and is not considered");
  assertEquals(run.heldOrg(), "globex", "the run keeps the lease it is still draining under");
  assertEquals(run.shouldContinue(), true, "and it is not over; it is just full");
});

// The image can reach a database whose claim_org_slot_and_read predates `pin_org`. PostgREST matches
// an overload on the set of argument names, so that answers PGRST202 — which is the SAME code as the
// genuine "this function does not exist" deploy skew, and that one is fatal on the first failure.
// Confusing the two would take the whole org-leased path down during a deploy window.
Deno.test("a database without pin_org degrades to batch-at-a-time instead of ending the run", async () => {
  const f = fakeRpc({
    claim: (args) =>
      args.pin_org === undefined
        ? { data: [row(1, "acme")], error: null }
        : {
            data: null,
            error: {
              message: "Could not find the function pgmq_public.claim_org_slot_and_read(pin_org, ...)",
              code: "PGRST202"
            }
          }
  });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, inFlightCount: () => inFlight });

  await run.claim();
  inFlight = 3;

  assertEquals(await run.claim(1), null, "the top-up is refused");
  assertEquals(run.shouldContinue(), true, "which is not fatal: the unpinned claims that start a run still work");
  assertEquals(f.releaseCalls, 0, "and the slot it is draining under is not given away");

  const callsBefore = f.claimArgs.length;
  assertEquals(await run.claim(1), null);
  assertEquals(f.claimArgs.length, callsBefore, "later top-ups skip the RPC entirely rather than re-learning this");

  inFlight = 0;
  assertNotEquals(await run.claim(), null, "while claims at rest carry on unpinned, exactly as before");
});

// The assertion of last resort. If the server ever ignores the pin, the messages it returned have
// already had their visibility timeout bumped, so throwing them away would defer real work for a
// whole VT to make a point. Report and carry on.
Deno.test("a server that ignores the pin is reported loudly but does not lose the messages", async () => {
  const f = fakeRpc({
    claim: (_a, i) => ({ data: i === 1 ? [row(1, "acme")] : [row(2, "globex")], error: null })
  });
  let inFlight = 0;
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, inFlightCount: () => inFlight });

  await run.claim();
  inFlight = 2;
  const claimed = await run.claim(1);

  assertEquals(claimed?.org, "globex", "the rows are already claimed server-side; they get processed");
  assertEquals(claimed?.messages.length, 1);
  assertEquals(run.shouldContinue(), true, "and the run does not throw out of a claim");
});

// ── The refill driver ──────────────────────────────────────────────────────────

Deno.test("the driver drains what is in flight before returning, even when the run ends early", async () => {
  const clock = virtualClock();
  const finished: number[] = [];
  let saturated = false;
  const rpc: OrgSlotRpc = {
    claim: async (args) => {
      await clock.sleep(CLAIM_LATENCY_MS);
      if (args.queue_name !== "async_calls" || saturated) return { data: statusRow("no_capacity"), error: null };
      saturated = true;
      return { data: [row(1, "acme"), row(2, "acme"), row(3, "acme")], error: null };
    },
    renew: () => Promise.resolve({ data: true, error: null }),
    release: () => Promise.resolve({ data: null, error: null })
  };

  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({ ...simBase(clock), rpc, inFlightCount: () => inFlight.size });
  await runOnVirtualTime(
    clock,
    drainWithContinuousRefill({
      run,
      inFlight,
      maxInFlight: SIM_CONCURRENCY,
      process: async (message) => {
        await clock.sleep(30_000);
        finished.push(message.msg_id);
      }
    })
  );

  assertEquals(run.shouldContinue(), false, "no_capacity ended the run");
  assertEquals(finished.sort(), [1, 2, 3], "and every message claimed before that still ran to completion");
  assertEquals(inFlight.size, 0, "the driver does not return with work outstanding");
});

// The anti-spin rule. With work in flight an empty claim waits for a COMPLETION, never for a sleep
// and never for nothing at all; with no work in flight it falls into the existing idle budget.
Deno.test("an empty claim waits for a completion rather than hammering the RPC", async () => {
  const clock = virtualClock();
  let sleeps = 0;
  let served = false;
  let claimsWhileBusy = 0;
  let busy = 0;

  const rpc: OrgSlotRpc = {
    claim: async (args) => {
      if (busy > 0) claimsWhileBusy++;
      await clock.sleep(CLAIM_LATENCY_MS);
      if (args.queue_name !== "async_calls" || served) return { data: statusRow("no_demand"), error: null };
      served = true;
      return { data: [row(1, "acme")], error: null };
    },
    renew: () => Promise.resolve({ data: true, error: null }),
    release: () => Promise.resolve({ data: null, error: null })
  };

  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({
    ...simBase(clock),
    rpc,
    inFlightCount: () => inFlight.size,
    idleBudgetMs: 30_000,
    sleep: (ms: number) => {
      if (busy > 0) sleeps++;
      return clock.sleep(ms);
    }
  });

  await runOnVirtualTime(
    clock,
    drainWithContinuousRefill({
      run,
      inFlight,
      maxInFlight: SIM_CONCURRENCY,
      process: async () => {
        busy++;
        await clock.sleep(600_000); // ten minutes: any spin would run away long before this settles
        busy--;
      }
    })
  );

  // One message in flight for ten minutes, three free slots, and an empty queue. A loop that
  // re-claimed on an empty answer would issue thousands of these.
  assertEquals(
    claimsWhileBusy <= 3,
    true,
    `${claimsWhileBusy} claims while one message ran for ten minutes; the shortfall must be claimed ` +
      `once per completion, not once per turn`
  );
  assertEquals(sleeps, 0, "and it must not burn the idle sleep while it is still holding a full lease");
  // The sleeps that DO happen are the ones after the drain, which is the existing idle budget doing
  // exactly what it always did.
  assertEquals(run.shouldContinue(), false, "the run ends on its idle budget once the drain is over");
});

// ── Review fixes: the four wiring faults the shipped shape could not report ────
// Every one of these is a case where the WRONG behavior was silent. That is the property under
// test as much as the behavior itself.

// `no_capacity` and `no_demand` are not interchangeable evidence about what the server WROTE.
// `no_demand` means `winner` was empty, so the slot UPDATE never ran. `no_capacity` also comes back
// when an org DID qualify, a slot WAS committed by the data-modifying `claimed` CTE, and `picked`
// then found every candidate row locked by a concurrent archive/delete/read under SKIP LOCKED.
// Reproduced against a local database: the call answers `no_capacity` with no message rows while
// `async_worker_slots` holds a live row for the caller. Dropping the queue from the release set on
// that answer loses the lease for a whole TTL.
Deno.test("a no_capacity answer still releases, because the server may have taken a slot", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_capacity"), error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  assertEquals(run.shouldContinue(), false, "no_capacity ends the run, as it always did");

  await run.release();
  assertEquals(f.releaseQueues, ["async_calls"], "the queue it may hold a slot in is still released");
});

// ...and the other half of the same rule: `no_demand` genuinely proves nothing was written, so it
// must still narrow the set. Without this the fix above would degrade into "release everything
// always", which is the behavior the touchedQueues bookkeeping exists to avoid.
Deno.test("a no_demand answer still proves there is nothing to release", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_demand"), error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc });

  assertEquals(await run.claim(), null);
  await run.release();
  assertEquals(f.releaseCalls, 0, "nothing was claimed anywhere, so nothing is given back");
});

// `inFlightCount` is optional and defaults to `() => 0`, which is exactly right for the batch driver
// and silently catastrophic for the refill one: unpinned top-ups, no deferred release, renewal
// stopping at `finished`, the idle budget arming mid-stream — and the pin-violation backstop that
// would report it is itself gated on the same count, so nothing fires.
Deno.test("refill refuses to run against a lease that cannot see the in-flight set", async () => {
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc }); // no inFlightCount
  assertEquals(run.tracksInFlight, false);

  await assertRejects(
    () =>
      drainWithContinuousRefill({
        run,
        inFlight: new Set<Promise<void>>(),
        maxInFlight: 4,
        process: () => Promise.resolve()
      }),
    Error,
    "inFlightCount"
  );
  assertEquals(f.claimArgs.length, 0, "and it refuses before claiming anything");
});

// The in-flight target and the allocator's `n` are one number. `claim()` caps ONE claim at
// `drainConcurrency`, which is not the same as capping the SET, because refill accumulates across
// claims: 4, then 4 more. The surplus is concurrency `max_per_org x drainConcurrency` never counted.
Deno.test("drainOrgLease refuses an in-flight target that is not the run's own concurrency", async () => {
  const seen: number[] = [];
  const f = fakeRpc({
    claim: (args, i) => {
      seen.push(args.n);
      return i === 1 ? { data: [row(1, "acme")], error: null } : { data: statusRow("no_demand"), error: null };
    }
  });
  const inFlight = new Set<Promise<void>>();
  // idleBudgetMs 0: `sleep` is instant here, so the default 50s budget would be 50s of WALL CLOCK
  // spent spinning on an empty queue. Nothing in this test is about idling.
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    drainConcurrency: 4,
    idleBudgetMs: 0,
    inFlightCount: () => inFlight.size
  });

  await drainOrgLease({
    run,
    inFlight,
    maxInFlight: 8, // twice the run's `n`
    continuousRefill: true,
    process: () => Promise.resolve()
  });

  assertEquals(seen[0], 4, "the first claim asks for the run's concurrency, not the inflated target");
  assertEquals(
    seen.every((n) => n <= 4),
    true,
    "and no claim in the run ever asks for more"
  );
});

// The batch shape must roll back the drain SHAPE and nothing else. Reading `maxInFlight` on one path
// and ignoring it on the other would make the kill switch a concurrency change too.
Deno.test("the kill switch changes the drain shape, not how much is in flight", async () => {
  const asked: number[] = [];
  const f = fakeRpc({
    claim: (args, i) => {
      asked.push(args.n);
      return i === 1 ? { data: [row(1, "acme")], error: null } : { data: statusRow("no_demand"), error: null };
    }
  });
  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    drainConcurrency: 3,
    idleBudgetMs: 0,
    inFlightCount: () => inFlight.size
  });

  await drainOrgLease({
    run,
    inFlight,
    maxInFlight: 3,
    continuousRefill: false,
    process: () => Promise.resolve()
  });

  assertEquals(asked[0], 3, "the batch path reads the same number the refill path would");
});

// `start`'s catch exists to make the tracked promise non-rejecting. Calling the reporter directly
// from it left that invariant resting on a callback this module does not own: a throw from `onError`
// re-rejects the very promise the catch was there to settle, and between `start` and the next
// `settleOne` nothing is attached to it — an unhandled rejection that takes the isolate down.
Deno.test("a reporter that throws cannot take the isolate down with it", async () => {
  const f = fakeRpc({
    claim: (_a, i) =>
      i === 1 ? { data: [row(1, "acme")], error: null } : { data: statusRow("no_demand"), error: null }
  });
  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, idleBudgetMs: 0, inFlightCount: () => inFlight.size });

  await drainWithContinuousRefill({
    run,
    inFlight,
    maxInFlight: 4,
    process: () => Promise.reject(new Error("handler blew up")),
    onError: () => {
      throw new Error("and so did the reporter");
    }
  });

  assertEquals(inFlight.size, 0, "the message still settled and left the in-flight set");
});

// `Math.max(1, NaN)` is NaN, so the clamp in `claim()` did not clamp. A NaN `n` is serialized by
// PostgREST as `null`, which `claim_org_slot_and_read` answers with P0001 — fatal on the FIRST
// failure, so one bad arithmetic result ends the run with a deployment error that is not one.
Deno.test("a non-finite message count resolves to the ceiling instead of a null n", async () => {
  const f = fakeRpc({ claim: () => ({ data: statusRow("no_demand"), error: null }) });
  const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, drainConcurrency: 4 });

  await run.claim(Number.NaN);
  assertEquals(f.claimArgs[0].n, 4);
  assertEquals(Number.isFinite(f.claimArgs[0].n), true, "never NaN, which crosses the wire as null");
});

// ── The wall-clock run budget ──────────────────────────────────────────────────
//
// The defect these lock down was live on 2026-09-15: nothing bounded a BUSY org-leased run, so a
// leaseholder that kept finding work drained until the runtime killed the isolate at
// EDGE_WORKER_TIMEOUT_MS ("wall clock duration reached", 664 times in 75 minutes across 27 pods),
// and everything it had read but not archived stayed invisible for a full visibility timeout —
// which in production is the same 480s. `sync_repo_permissions` redelivery reached 35.4%.
//
// Two things have to be true of the fix and each of them can be true without the other, which is
// why they are asserted separately everywhere below: the run must STOP CLAIMING at the deadline,
// and the work it had already started must STILL COMPLETE. A change that only did the first would
// be the same strand, self-inflicted.

/** The prod shape the defect was measured on: a 480s isolate and a 480s visibility timeout. */
const PROD_LIFETIME_MS = 480_000;

/**
 * Message spans, so a test can ask the question the incident asks: at the instant the runtime would
 * have killed this isolate, how many messages had been read and not yet archived? That count IS the
 * stranded set — each one invisible for the rest of its VT.
 */
type Span = { start: number; end: number };
const inFlightAt = (spans: Span[], t: number) => spans.filter((s) => s.start <= t && t < s.end).length;

/**
 * One org-leased drain against an endless-enough queue, on virtual time.
 *
 * `budgetMs === null` is the PRE-CHANGE behaviour and is what the negative control runs.
 */
async function drainWithBudget(budgetMs: number | null) {
  const clock = virtualClock();
  const claimTimes: number[] = [];
  const spans: Span[] = [];
  // STARTS counted separately from COMPLETIONS, because "stopped claiming" and "let what it had
  // finish" are different claims and a span list alone can only ever evidence the first. A driver
  // that returned while messages were still running would simply record fewer spans, and every
  // assertion written over `spans` would stay true of the smaller set.
  let startedCount = 0;
  // Bounded, or an unbudgeted run would never return and the negative control could not be written.
  // 200 x 30s at 4-way concurrency is 1500s of virtual time, comfortably past the 480s wall clock.
  const ready: number[] = [];
  for (let i = 1; i <= 200; i++) ready.push(i);

  const rpc: OrgSlotRpc = {
    claim: async (args) => {
      claimTimes.push(clock.now());
      await clock.sleep(CLAIM_LATENCY_MS);
      if (args.queue_name !== "async_calls") return { data: statusRow("no_demand"), error: null };
      const take = ready.splice(0, args.n);
      if (take.length === 0) return { data: statusRow("no_demand"), error: null };
      return { data: take.map((id) => row(id, "acme")), error: null };
    },
    renew: () => Promise.resolve({ data: true, error: null }),
    release: () => Promise.resolve({ data: null, error: null })
  };

  const inFlight = new Set<Promise<void>>();
  const run = beginOrgLeaseRun({
    ...simBase(clock),
    rpc,
    inFlightCount: () => inFlight.size,
    // The clock is injected, so the anchor must be too — `beginOrgLeaseRun` refuses the pair
    // otherwise. 0 is this isolate's birth on the virtual clock.
    ...(budgetMs === null ? {} : { runBudgetMs: budgetMs, isolateStartedAt: 0 })
  });

  await runOnVirtualTime(
    clock,
    drainWithContinuousRefill({
      run,
      inFlight,
      maxInFlight: SIM_CONCURRENCY,
      process: async (message) => {
        startedCount++;
        const start = clock.now();
        // STAGGERED, not a constant. With identical durations every message settles in lockstep and
        // the in-flight set empties completely between refills, so the deadline can only ever land
        // on an EMPTY set — and "the work in flight at the deadline still finishes" becomes a claim
        // about nothing. These are the measured spread's shape (tens of seconds, no two alike).
        await clock.sleep((17 + ((message.msg_id * 7) % 23)) * 1000);
        spans.push({ start, end: clock.now() });
      }
    })
  );
  await run.release();

  return {
    claimTimes,
    spans,
    endedAt: clock.now(),
    startedCount,
    completedCount: spans.length,
    stillTracked: inFlight.size,
    left: ready.length,
    run
  };
}

// THE CORE PROPERTY, BOTH HALVES. Claiming stops at the deadline; everything already claimed still
// runs to completion; and at the instant the runtime would have killed this isolate there is
// nothing left unarchived, which is the whole of the 2026-09-15 defect.
Deno.test(
  "a run past its wall-clock budget stops claiming, and the work it already started still finishes",
  async () => {
    const budget = 330_000;
    const d = await drainWithBudget(budget);

    const after = d.claimTimes.filter((t) => t >= budget);
    assertEquals(after, [], "no claim may be issued once the budget is spent");
    // Not vacuous: it really did keep claiming right up to the deadline rather than stopping early for
    // some unrelated reason, which is the way this test could pass while the budget did nothing.
    assertEquals(
      d.claimTimes.some((t) => t > budget - 60_000),
      true,
      "and it claimed right up to the deadline, so the stop is the budget and not an empty queue"
    );

    // THE OTHER HALF, AND IT IS COUNTED RATHER THAN INFERRED. Every message this run STARTED also
    // COMPLETED. A budget that stopped claiming and then dropped its in-flight set on the floor would
    // satisfy every assertion above and fail here — which is the exact bug this change could have
    // introduced, so it gets a count and not a property over the survivors.
    assertEquals(d.startedCount > 0, true, "the run did real work before the deadline");
    assertEquals(
      d.completedCount,
      d.startedCount,
      "every message the run started also finished; none was abandoned at the deadline"
    );
    assertEquals(d.stillTracked, 0, "and the driver did not return with work still tracked");
    assertEquals(
      d.spans.every((s) => s.end <= d.endedAt),
      true,
      "the driver did not return while a message it claimed was still running"
    );
    // THE INTERLEAVING THAT MAKES THE ASSERTION MEAN SOMETHING: messages were genuinely RUNNING at
    // the instant claiming stopped, and they ended after it. A budget that dropped its in-flight set
    // on the floor would satisfy "stops claiming" and fail here.
    assertEquals(
      inFlightAt(d.spans, budget) > 0,
      true,
      "the deadline landed mid-stream, with messages actually running"
    );
    assertEquals(
      d.spans.some((s) => s.start < budget && s.end > budget),
      true,
      "and work that was in flight AT the deadline was allowed to finish past it, not dropped"
    );
    assertEquals(d.run.shouldContinue(), false, "the run is over");

    // The point of the whole change: at the wall clock, nothing of ours is unarchived.
    assertEquals(inFlightAt(d.spans, PROD_LIFETIME_MS), 0, "nothing is stranded when the runtime kills the isolate");
    assertEquals(d.endedAt < PROD_LIFETIME_MS, true, "the isolate returned on its own terms, before the kill");
  }
);

// NEGATIVE CONTROL. The same drain with no budget is the pre-change worker, and it does exactly what
// the incident says: still claiming long past the horizon, with a full in-flight set at the kill.
Deno.test("an unbudgeted run claims past the deadline and is still holding messages at the wall clock", async () => {
  const d = await drainWithBudget(null);

  assertEquals(
    d.claimTimes.some((t) => t >= 330_000),
    true,
    "an unbudgeted run keeps claiming past where the budget would have stopped it"
  );
  assertEquals(
    d.claimTimes.some((t) => t >= PROD_LIFETIME_MS),
    true,
    "and past the wall clock itself, on an isolate the runtime has already killed"
  );
  assertEquals(
    inFlightAt(d.spans, PROD_LIFETIME_MS),
    SIM_CONCURRENCY,
    "with a full in-flight set stranded at the kill — read, unarchived, invisible for a whole VT"
  );
});

// THE PRIMARY ACCEPTANCE CRITERION, and the one case an injected clock cannot reach.
//
// `github-async-worker/index.ts` resets its `started` guard in a `.finally()`, the cron pokes twice
// a minute, and an idle run returns after its 50s idle budget — so ONE ISOLATE HOSTS A SEQUENCE OF
// RUNS. A run-scoped deadline passes every other test in this section and changes nothing in
// production, because the dangerous run is a YOUNG run that starts LATE in the isolate's life: it
// would be handed a fresh full allowance and killed minutes short of it.
//
// So this one injects NOTHING — not the clock, not the anchor. It uses the real `Date.now` and the
// real module-level capture in orgLeaseRun.ts, which is the only way to tell "the budget is module
// state that runs draw down" apart from "the budget is per run".
Deno.test("the budget is module state: a second run in the same isolate inherits what the first spent", async () => {
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // `base` deliberately does NOT set `now`, so these runs read the real clock and the real
  // module-level anchor. That is the whole design of this test.
  const live = base;

  // A budget that expires 300ms from NOW, expressed the only way it can be — as an allowance from
  // the ISOLATE's start, which is what the worker passes and what every run in this isolate shares.
  const budgetMs = Date.now() - isolateStartedAtMs() + 300;

  const first = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  const runA = beginOrgLeaseRun({ ...live, rpc: first.rpc, runBudgetMs: budgetMs });
  assertNotEquals(await runA.claim(), null, "the first run is inside the budget and claims normally");

  // The isolate ages past the shared deadline. The RUN is brand new; the ISOLATE is not.
  await realSleep(400);

  const second = fakeRpc({ claim: () => ({ data: [row(2, "acme")], error: null }) });
  const runB = beginOrgLeaseRun({ ...live, rpc: second.rpc, runBudgetMs: budgetMs });
  assertEquals(await runB.claim(), null, "the second run inherits the remainder, which is gone");
  assertEquals(second.claimArgs.length, 0, "and it never reached the RPC at all");
  assertEquals(runB.shouldContinue(), false, "so it ends rather than holding an admission slot");

  // THE CONTROL THAT MAKES THE ASSERTION ABOVE MEAN SOMETHING. Give a third run exactly what a
  // RUN-ANCHORED implementation would have given the second — an allowance measured from ITS OWN
  // start — and it claims happily. The difference between these two runs is the anchor and nothing
  // else, which is the whole point.
  const third = fakeRpc({ claim: () => ({ data: [row(3, "acme")], error: null }) });
  const runC = beginOrgLeaseRun({
    ...live,
    rpc: third.rpc,
    runBudgetMs: Date.now() - isolateStartedAtMs() + 300
  });
  assertNotEquals(await runC.claim(), null, "a run-start anchor would have let the late run claim — that is the bug");
});

// The deterministic sibling of the test above: same claim, injected clock, so the arithmetic is
// exact rather than timing-dependent. Both are kept — this one pins the SEMANTICS (an absolute
// deadline shared across runs), that one pins the WIRING (the module capture is really what
// production uses).
Deno.test("sequential runs share one deadline, and a late run gets no allowance at all", async () => {
  let t = 0;
  const isolateStartedAt = 0;
  const budgetMs = 330_000;
  const live = { ...base, now: () => t, isolateStartedAt };

  const a = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  const runA = beginOrgLeaseRun({ ...live, rpc: a.rpc, runBudgetMs: budgetMs });
  assertNotEquals(await runA.claim(), null);

  // Run A idles out at its idle budget and returns; the isolate stays alive and takes the next poke.
  t = 200_000;
  const b = fakeRpc({ claim: () => ({ data: [row(2, "acme")], error: null }) });
  const runB = beginOrgLeaseRun({ ...live, rpc: b.rpc, runBudgetMs: budgetMs });
  assertNotEquals(await runB.claim(), null, "130s of the isolate's budget is left, so this run may use it");

  // ...and the next one after that is past the shared deadline, even though it is seconds old.
  t = 340_000;
  const c = fakeRpc({ claim: () => ({ data: [row(3, "acme")], error: null }) });
  const runC = beginOrgLeaseRun({ ...live, rpc: c.rpc, runBudgetMs: budgetMs });
  assertEquals(await runC.claim(), null, "a fresh run late in the isolate's life inherits no allowance");
  assertEquals(c.claimArgs.length, 0);
  assertEquals(runC.shouldContinue(), false);
});

// Same rule the deferred-release paths already hold, reached a fourth way. A budget that gave the
// slot back while `n-1` handlers were still spending this org's GitHub quota would let a second
// leaseholder in on top of them — the per-org cap this whole feature exists to hold.
Deno.test("a spent budget does not hand back a slot that still has work under it", async () => {
  const timers = fakeTimers();
  const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
  let inFlight = 0;
  let t = 0;
  const run = beginOrgLeaseRun({
    ...base,
    rpc: f.rpc,
    leaseTtlMs: 30_000,
    now: () => t,
    isolateStartedAt: 0,
    runBudgetMs: 330_000,
    inFlightCount: () => inFlight,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });

  await run.claim();
  inFlight = 3;
  t = 330_001;

  assertEquals(await run.claim(), null, "the budget is spent, so nothing more is claimed");
  assertEquals(run.shouldContinue(), false);
  assertEquals(f.releaseCalls, 0, "but the slot stays ours while its messages are still running");
  assertEquals(run.heldOrg(), "acme");

  // And the lease keeps being renewed past the end of the run, or it lapses mid-drain.
  t = 340_002;
  timers.fireAll();
  await flush();
  assertEquals(f.renewCalls, 1, "a finished-but-draining run must keep its lease alive");

  inFlight = 0;
  await run.release();
  assertEquals(f.releaseCalls, 1, "the drain finishing is what finally gives the slot back");
});

// The failure direction that is worse than the one the budget fixes. A zero or a NaN arriving from
// a caller's arithmetic must not mean "already past the deadline": that is an isolate that never
// claims, i.e. a queue that stops draining while the lease, the heartbeats and the error count all
// stay green. Unbounded is a known and survivable failure; never claiming is not.
Deno.test("a budget that is not a usable number leaves the run unbounded rather than instantly over", async () => {
  for (const runBudgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fakeRpc({ claim: () => ({ data: [row(1, "acme")], error: null }) });
    // `now` far past any plausible deadline, which is exactly what would trip a mis-parsed budget.
    const run = beginOrgLeaseRun({ ...base, rpc: f.rpc, now: () => 10_000_000, runBudgetMs });
    assertNotEquals(await run.claim(), null, `runBudgetMs=${runBudgetMs} must not stop the worker claiming`);
    assertEquals(run.shouldContinue(), true);
  }
});

// The wiring mistake the types cannot catch, and the one that would make every test above vacuous:
// the module anchor is in Date.now()'s epoch, so a deadline built from it and compared against an
// injected clock starting at 0 sits ~1.7e12 ms in the future and can never be reached.
Deno.test("an armed budget with an injected clock and no anchor is refused rather than silently inert", () => {
  const f = fakeRpc();
  const e = assertThrows(() => beginOrgLeaseRun({ ...base, rpc: f.rpc, now: () => 0, runBudgetMs: 1000 }), Error);
  assertStringIncludes(e.message, "isolateStartedAt");
  // And the two legitimate shapes are both still allowed.
  beginOrgLeaseRun({ ...base, rpc: f.rpc, now: () => 0, isolateStartedAt: 0, runBudgetMs: 1000 });
  beginOrgLeaseRun({ ...base, rpc: f.rpc, now: () => 0 });
});

// END TO END THROUGH THE TUNING, because the budget is only worth anything at the number production
// actually resolves. SIM_ENV is the prod shape — a 480s isolate and a 480s visibility timeout, which
// is the pair that made a mid-batch kill cost a full VT of invisibility.
Deno.test("the production tuning resolves a 330s budget, and a drain at it returns before the wall clock", async () => {
  const tuning = simTuning({ GITHUB_ASYNC_WORKER_ORG_SLOT_GLOBAL_CAP: "8" });
  assertEquals(tuning.orgSlots.runBudgetSeconds, 330, "480s lifetime - 120s drain-out reserve - 30s margin");
  assertEquals(
    tuning.orgSlots.runBudgetSeconds * 1000 + PER_MESSAGE_VT_BUDGET_SECONDS * 1000 < PROD_LIFETIME_MS,
    true,
    "and it leaves a whole modelled message behind it, which is what the reserve is for"
  );

  const d = await drainWithBudget(tuning.orgSlots.runBudgetSeconds * 1000);
  assertEquals(
    d.claimTimes.filter((t) => t >= 330_000),
    [],
    "nothing is claimed past the resolved budget"
  );
  assertEquals(inFlightAt(d.spans, PROD_LIFETIME_MS), 0, "and nothing is stranded at the wall clock");
});
