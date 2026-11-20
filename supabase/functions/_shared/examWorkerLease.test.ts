/**
 * The exam worker's message lease (#1158), driven by a fake client on a fake clock.
 *
 * What the database does with these calls (a stale read_ct gets false and leaves vt alone; a
 * second reader takes over after the lease) is tested against Postgres in
 * tests/e2e/exam-worker-batch-status-db.spec.ts. These pin the worker's side: it calls
 * pgmq_public.set_vt_if_claimed with the read_ct it claimed, every LEASE_RENEW_MS, one call at a
 * time, stops when the message is no longer its own, and keeps trying through errors.
 *
 * FakeTime makes the schedule exact: a renewal happens when the clock reaches LEASE_RENEW_MS after
 * the previous call returned, and not before, however slowly the test runner happens to run.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { FakeTime } from "jsr:@std/testing@^1/time";
import { holdLease, LEASE_RENEW_MS, LEASE_SECONDS, type LeaseClient } from "./examWorkerLease.ts";

type Result = { data: unknown; error: unknown };
type Reply = Result | Error | Promise<Result>;
type Call = { schema: string; fn: string; args: Record<string, unknown>; signal: AbortSignal };

const HELD: Result = { data: true, error: null };
const msg = { msg_id: 41, read_ct: 3 };

/**
 * Answers each call with the next reply (then "held"), and records the calls and their overlap.
 * Replies settle on the microtask queue, so only the fake clock decides when the next call starts.
 */
function fakeClient(replies: Reply[] = []) {
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    schema: (schema: string) => ({
      rpc: (fn: string, args: Record<string, unknown>) => ({
        abortSignal: async (signal: AbortSignal) => {
          calls.push({ schema, fn, args, signal });
          maxActive = Math.max(maxActive, ++active);
          try {
            const reply = replies.length ? replies.shift()! : HELD;
            if (reply instanceof Error) throw reply;
            return await reply;
          } finally {
            active--;
          }
        }
      })
    })
  } as unknown as LeaseClient;
  return { client, calls, maxActive: () => maxActive };
}

function silenceWarnings() {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  return { warnings, restore: () => (console.warn = original) };
}

/** Advance the fake clock by `periods` renewal periods, running every timer and promise due. */
async function advance(time: FakeTime, periods: number) {
  for (let i = 0; i < periods; i++) await time.tickAsync(LEASE_RENEW_MS);
}

Deno.test("each renewal is set_vt_if_claimed with the claimed read_ct, every LEASE_RENEW_MS, one at a time", async () => {
  const time = new FakeTime();
  const fake = fakeClient();
  let release: ((seconds?: number) => Promise<void>) | undefined;
  try {
    release = await holdLease(fake.client, "exam_processing", msg);
    // The first call has returned before holdLease does.
    assertEquals(fake.calls.length, 1);
    await time.tickAsync(LEASE_RENEW_MS - 1);
    assertEquals(fake.calls.length, 1, "no renewal before LEASE_RENEW_MS");
    await time.tickAsync(1);
    assertEquals(fake.calls.length, 2);
    await advance(time, 2);
    assertEquals(fake.calls.length, 4);
    for (const call of fake.calls) {
      assertEquals(call.schema, "pgmq_public");
      assertEquals(call.fn, "set_vt_if_claimed");
      assertEquals(call.args, { queue_name: "exam_processing", msg_id: 41, read_ct: 3, vt: LEASE_SECONDS });
      assert(call.signal instanceof AbortSignal);
    }
    assertEquals(fake.maxActive(), 1);
  } finally {
    await release?.();
    time.restore();
  }
});

Deno.test("once the message is no longer this reader's, it stops renewing", async () => {
  const time = new FakeTime();
  const fake = fakeClient([HELD, { data: false, error: null }]);
  let release: ((seconds?: number) => Promise<void>) | undefined;
  try {
    release = await holdLease(fake.client, "exam_processing", msg);
    await advance(time, 1);
    assertEquals(fake.calls.length, 2);
    await advance(time, 10);
    assertEquals(fake.calls.length, 2);
  } finally {
    await release?.();
    time.restore();
  }
});

Deno.test("an error, a throw or an odd reply does not end the lease, and is logged once", async () => {
  const time = new FakeTime();
  const log = silenceWarnings();
  const fake = fakeClient([
    { data: null, error: { message: "connection reset" } },
    new Error("aborted"),
    { data: "yes", error: null }
  ]);
  let release: ((seconds?: number) => Promise<void>) | undefined;
  try {
    release = await holdLease(fake.client, "exam_processing", msg);
    await advance(time, 4);
    // Three failures, then two successes, one per period.
    assertEquals(fake.calls.length, 5);
    assertEquals(log.warnings.length, 1);
    assert(log.warnings[0].includes("msg 41"));
  } finally {
    await release?.();
    time.restore();
    log.restore();
  }
});

Deno.test("release() stops renewing and makes no call of its own", async () => {
  const time = new FakeTime();
  const fake = fakeClient();
  try {
    const release = await holdLease(fake.client, "exam_processing", msg);
    await advance(time, 1);
    await release();
    assertEquals(fake.calls.length, 2);
    await advance(time, 10);
    assertEquals(fake.calls.length, 2);
  } finally {
    time.restore();
  }
});

Deno.test("release(seconds) waits for the call in flight, then sets the lease once to that", async () => {
  const time = new FakeTime();
  let finishRenewal!: () => void;
  const slowRenewal = new Promise<Result>((resolve) => {
    finishRenewal = () => resolve(HELD);
  });
  const fake = fakeClient([HELD, slowRenewal]);
  try {
    const release = await holdLease(fake.client, "exam_processing", msg);
    await advance(time, 1); // the second call is now waiting on slowRenewal
    assertEquals(fake.calls.length, 2);
    const released = release(120);
    await time.runMicrotasks();
    assertEquals(fake.calls.length, 2, "release must wait for the call in flight");
    finishRenewal();
    await released;
    assertEquals(fake.calls.length, 3);
    assertEquals(fake.calls[2].args.vt, 120);
    assertEquals(fake.calls[2].args.read_ct, 3);
    await advance(time, 10);
    assertEquals(fake.calls.length, 3);
  } finally {
    finishRenewal();
    time.restore();
  }
});
