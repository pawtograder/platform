import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
// Side effect: keeps console text and URL queries out of this function's Sentry events.
import "../_shared/SentryScrub.ts";
import { forgejoConfig } from "../_shared/ForgejoWrapper.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { reconcileForgejoAccounts } from "./reconcile.ts";

/**
 * Forgejo Account Reconciler (#1092)
 *
 * Creates a Forgejo account for everyone enrolled in a cloud-workspaces class, so repos can be
 * created for them (#1093) before they first sign in. Invoked hourly via pg_cron, and kicked when
 * someone joins such a class or a class turns the flag on (20261112120100_forgejo_reconciler.sql).
 */

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    beforeSend: normalizeEventFingerprint,
    ...sentryIdentity(),
    dsn: Deno.env.get("SENTRY_DSN")!,
    sendDefaultPii: true,
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const scope = new Sentry.Scope();
  scope.setTag("function", "forgejo-reconciler");

  // x-supabase-webhook-source is an attacker-settable label; only the shared secret grants access.
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  if (!expectedSecret || req.headers.get("x-edge-function-secret") !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const config = forgejoConfig();
  if (!config) {
    // A deployment without Forgejo, or one not configured yet: nothing to do, and nothing to page on.
    console.log("[forgejo-reconciler] Skipped: FORGEJO_URL, admin credentials or auth source id unset");
    return json({ skipped: "forgejo_not_configured" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return json({ error: "Missing required environment variables" }, 500);
  }
  const supabase = createClient<Database>(supabaseUrl, supabaseKey, { auth: REQUEST_SCOPED_AUTH_OPTIONS });

  try {
    const { provisioned, failures } = await reconcileForgejoAccounts(supabase, config);
    console.log(`[forgejo-reconciler] Provisioned ${provisioned}, failed ${failures.length}`);
    if (failures.length > 0) {
      // One event per pass, not per user: an outage or a bad credential fails everyone at once.
      scope.setFingerprint(["forgejo-reconciler", "provision-failed"]);
      scope.setContext("failures", {
        count: failures.length,
        user_ids: failures.slice(0, 20).map((f) => f.userId)
      });
      Sentry.captureException(failures[0].error, scope);
    }
    await Sentry.flush(2000);
    return json({ provisioned, failed: failures.length });
  } catch (error) {
    console.error("[forgejo-reconciler] Error:", error);
    Sentry.captureException(error, scope);
    await Sentry.flush(2000);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
