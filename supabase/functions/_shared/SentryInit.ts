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

import * as Sentry from "npm:@sentry/deno";
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
