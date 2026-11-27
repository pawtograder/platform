/**
 * When an exam-async-worker invocation stops claiming messages (#1158).
 *
 * A plain-TS module (no Deno or Node imports) so the worker and the Jest test read the same rule
 * (the batchTransitions.ts pattern).
 *
 * runBatch runs under EdgeRuntime.waitUntil. Retiring an isolate (the chart's
 * beforeUnload.wallClockRatio: 50) only stops new requests reaching it; a drain it already holds
 * runs on until the isolate's hard lifetime, EDGE_WORKER_TIMEOUT_MS, and is killed there, mid-message
 * if it is still claiming (see _shared/asyncWorkerTuning.ts). So the bound that matters is the
 * isolate's age, not the invocation's.
 *
 * Before #1158 an invocation drained until the queue was empty and was often killed mid-message. A
 * fixed 60s claim window per invocation removed those kills but also cut throughput under a deep
 * backlog: the cron starts at most 5 invocations a minute, so only about 5 drains ran at once
 * instead of everything started over the isolate's life (in a scheduling model of a 1600-page batch,
 * about a third of staging's drain rate).
 *
 * The rule now: claim until the isolate is LIFETIME - MESSAGE_RESERVE - MARGIN old, so a message
 * claimed at the deadline still has its whole read window (READ_VISIBILITY_SECONDS) plus 30s before
 * the kill, and never for less than MIN_CLAIM_WINDOW_MS from the invocation's own start. The floor
 * is the previous rule, so no invocation claims for less time than it did, and a lifetime too short
 * for the reserve degrades to that rule instead of claiming nothing (a queue that drains nothing
 * while every invocation looks healthy). Requests reach an isolate only before it retires at half
 * its lifetime, so the last claim is at most max(LIFETIME - 150s, LIFETIME/2 + 60s) in, leaving
 * min(150s, LIFETIME/2 - 60s): 140s at the chart's 400s (as before) and 150s at production's 480s
 * (180s before). Either way a claimed message keeps its read window plus the margin, or, at 400s,
 * the 140s the previous rule left.
 *
 * The anchor is when the worker module was evaluated, a little after the runtime started the
 * isolate's clock; the margin covers that, as ORG_SLOT_RUN_BUDGET_MARGIN_SECONDS does for the
 * GitHub worker.
 */

/** The previous fixed window, kept as the floor. */
export const MIN_CLAIM_WINDOW_MS = 60_000;
/** A message is expected to finish within its read window (READ_VISIBILITY_SECONDS in index.ts). */
export const MESSAGE_RESERVE_MS = 120_000;
/** Bootstrap before module evaluation, an in-flight read, and the tail after the last message. */
export const CLAIM_MARGIN_MS = 30_000;
/** What the demuxer assumes when EDGE_WORKER_TIMEOUT_MS is unset (charts/.../main.ts; local CLI too). */
export const DEFAULT_ISOLATE_LIFETIME_MS = 400_000;

/** EDGE_WORKER_TIMEOUT_MS as the demuxer reads it: a positive number of ms, else the default. */
export function isolateLifetimeMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ISOLATE_LIFETIME_MS;
}

/** The time after which this invocation makes no new claim. */
export function claimDeadlineMs(isolateStartedAtMs: number, invocationStartedAtMs: number, lifetimeMs: number): number {
  return Math.max(
    isolateStartedAtMs + lifetimeMs - MESSAGE_RESERVE_MS - CLAIM_MARGIN_MS,
    invocationStartedAtMs + MIN_CLAIM_WINDOW_MS
  );
}
