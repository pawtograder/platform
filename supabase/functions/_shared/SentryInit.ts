// The single Sentry.init for the edge runtime, applied as an import side effect.
//
// This used to live in HandlerUtils.ts, which meant a function was instrumented if and only if it
// imported HandlerUtils — directly or transitively. Five functions did not, and their Sentry calls
// were silent no-ops: discord-async-worker alone makes 38 of them, including the captureException
// inside its poll loop, which is why a worker failing 135 times per pod into a dead-letter queue
// produced no Sentry issue at all.
//
// Kept separate from HandlerUtils rather than asking those functions to import it: HandlerUtils
// pulls in @supabase/supabase-js, postgrest-js from esm.sh, and the whole authz surface. Importing
// all of that into `metrics` (a hot scrape endpoint) purely for a side effect inflates the bundle
// and isolate boot cost, and re-creates exactly the coupling that ErrorDetail.ts documents as the
// reason logic gets extracted out of HandlerUtils in the first place. This module depends only on
// @sentry/deno plus two pure helpers.

import * as Sentry from "npm:@sentry/deno@10.10.0";
import { normalizeEventFingerprint } from "./SentryFingerprint.ts";
import { sentryIdentity } from "./SentryContext.ts";

let initialized = false;

/**
 * Idempotent: safe to call from HandlerUtils and from a function's own index.ts.
 * No-ops when SENTRY_DSN is unset, matching the previous behavior exactly.
 */
export function initSentry(): void {
  if (initialized) return;

  const dsn = Deno.env.get("SENTRY_DSN");
  // Latch AFTER the DSN check, not before. Setting `initialized` first meant that an import-time
  // call made with SENTRY_DSN absent — local dev, a test harness, any host that populates env after
  // the module graph is evaluated — permanently installed no client and made every later
  // initSentry() a no-op, which is exactly the silent-Sentry defect this module exists to fix.
  if (!dsn) return;
  initialized = true;

  Sentry.init({
    beforeSend: normalizeEventFingerprint,
    ...sentryIdentity(),
    dsn,
    sendDefaultPii: true,
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}

initSentry();

/**
 * `Deno.serve` plus the flush that `policy: per_request` makes mandatory.
 *
 * Under per_request the isolate is destroyed as soon as the response is
 * returned, taking Sentry's in-memory transport queue with it. Anything
 * captured but not yet delivered is lost. `wrapRequestHandler` flushes for the
 * 43 functions routed through it; the ~10 functions that own their `Deno.serve`
 * boundary need this instead — including the three heaviest reporters in the
 * tree (github-repo-webhook, github-async-worker, discord-async-worker), which
 * between them capture 180 exceptions and flushed none of them.
 *
 * The flush is in a `finally`, so it covers the throwing path too, and its 2s
 * ceiling bounds the worst case: losing an event beats holding an isolate (and
 * one of `maxParallelism` admission slots) open indefinitely.
 */
export function serveWithSentryFlush(handler: Deno.ServeHandler): void {
  Deno.serve(async (req, info) => {
    try {
      return await handler(req, info);
    } finally {
      await Sentry.flush(2000);
    }
  });
}

/**
 * `EdgeRuntime.waitUntil` plus a flush that happens when the BACKGROUND work
 * settles, not when the response was returned.
 *
 * `serveWithSentryFlush` and `wrapRequestHandler` both flush in a `finally` on
 * the request, which is the right moment for anything the handler did inline —
 * and the wrong one for work handed to `waitUntil`. Those handlers return
 * immediately, so the flush runs while the background promise is still going,
 * and everything it captures afterwards dies with the isolate exactly as before.
 * The batch workers are the case that matters: their capture sites are all in
 * the loop or its startup `.catch`, i.e. entirely after the response.
 *
 * Flushing here does not remove the need to flush on the request — a handler
 * can capture inline and in the background — and a second flush with an empty
 * queue is close to free.
 */
export function waitUntilWithSentryFlush(promise: Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const flushed = promise.finally(async () => {
    await Sentry.flush(2000);
  });
  if (runtime?.waitUntil) {
    runtime.waitUntil(flushed);
  } else {
    // No runtime to hand it to (local `deno run`, tests): keep the original
    // fire-and-forget shape rather than changing behaviour, but do not let a
    // rejection surface as an unhandled one.
    void flushed.catch(() => {});
  }
}
