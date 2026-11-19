/**
 * The exam worker's message lease (#1158), driven by a fake client.
 *
 * What the database does with these calls (a stale read_ct gets false and leaves vt alone; a
 * second reader takes over after the lease) is tested against Postgres in
 * tests/e2e/exam-worker-batch-status-db.spec.ts. These pin the worker's side: it calls
 * pgmq_public.set_vt_if_claimed with the read_ct it claimed, renews one call at a time, stops when
 * the message is no longer its own, and keeps trying through errors.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { holdLease, LEASE_SECONDS, type LeaseClient } from "./examWorkerLease.ts";

type Reply = { data: unknown; error: unknown } | Error | Promise<{ data: unknown; error: unknown }>;
type Call = { schema: string; fn: string; args: Record<string, unknown>; signal: AbortSignal };

const HELD = { data: true, error: null };
const RENEW_MS = 5;
const msg = { msg_id: 41, read_ct: 3 };
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers each call with the next reply (then "held"), and records the calls and their overlap. */
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
            await tick(1);
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

Deno.test("each renewal is set_vt_if_claimed with the claimed read_ct, one call at a time", async () => {
  const fake = fakeClient();
  const release = await holdLease(fake.client, "exam_processing", msg, { renewMs: RENEW_MS });
  // The first call has returned before holdLease does.
  assertEquals(fake.calls.length, 1);
  await tick(60);
  await release();
  assert(fake.calls.length >= 4, `expected renewals, got ${fake.calls.length} call(s)`);
  for (const call of fake.calls) {
    assertEquals(call.schema, "pgmq_public");
    assertEquals(call.fn, "set_vt_if_claimed");
    assertEquals(call.args, { queue_name: "exam_processing", msg_id: 41, read_ct: 3, vt: LEASE_SECONDS });
    assert(call.signal instanceof AbortSignal);
  }
  assertEquals(fake.maxActive(), 1);
});

Deno.test("once the message is no longer this reader's, it stops renewing", async () => {
  const fake = fakeClient([HELD, { data: false, error: null }]);
  const release = await holdLease(fake.client, "exam_processing", msg, { renewMs: RENEW_MS });
  await tick(60);
  assertEquals(fake.calls.length, 2);
  await release();
  assertEquals(fake.calls.length, 2);
});

Deno.test("an error, a throw or an odd reply does not end the lease, and is logged once", async () => {
  const log = silenceWarnings();
  try {
    const fake = fakeClient([
      { data: null, error: { message: "connection reset" } },
      new Error("aborted"),
      { data: "yes", error: null }
    ]);
    const release = await holdLease(fake.client, "exam_processing", msg, { renewMs: RENEW_MS });
    await tick(80);
    await release();
    assert(fake.calls.length >= 5, `expected renewals past the failures, got ${fake.calls.length}`);
    assertEquals(log.warnings.length, 1);
    assert(log.warnings[0].includes("msg 41"));
  } finally {
    log.restore();
  }
});

Deno.test("release() stops renewing and makes no call of its own", async () => {
  const fake = fakeClient();
  const release = await holdLease(fake.client, "exam_processing", msg, { renewMs: RENEW_MS });
  await release();
  const after = fake.calls.length;
  await tick(30);
  assertEquals(fake.calls.length, after);
});

Deno.test("release(seconds) waits for the call in flight, then sets the lease once to that", async () => {
  let finishRenewal!: () => void;
  const slowRenewal = new Promise<{ data: unknown; error: unknown }>((resolve) => {
    finishRenewal = () => resolve(HELD);
  });
  const fake = fakeClient([HELD, slowRenewal]);
  const release = await holdLease(fake.client, "exam_processing", msg, { renewMs: RENEW_MS });
  await tick(20); // the second call is now waiting on slowRenewal
  assertEquals(fake.calls.length, 2);
  const released = release(120);
  await tick(10);
  assertEquals(fake.calls.length, 2, "release must wait for the call in flight");
  finishRenewal();
  await released;
  assertEquals(fake.calls.length, 3);
  assertEquals(fake.calls[2].args.vt, 120);
  assertEquals(fake.calls[2].args.read_ct, 3);
  await tick(30);
  assertEquals(fake.calls.length, 3);
});
