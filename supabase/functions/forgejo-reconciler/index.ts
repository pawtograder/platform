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
import { reconcileForgejo } from "./reconcile.ts";

/**
 * Forgejo Reconciler
 *
 * Creates a Forgejo account for everyone enrolled in a cloud-workspaces class (#1092), then a repo
 * for each student in each released Forgejo assignment (#1093), so both exist before the student
 * first signs in. Invoked hourly via pg_cron, and kicked when someone joins such a class, a class
 * turns the flag on (20261109130000_forgejo_reconciler.sql) or a Forgejo assignment is released
 * (20261110120000_forgejo_repos.sql).
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
    const { accounts, repos } = await reconcileForgejo(supabase, config);
    console.log(
      `[forgejo-reconciler] Accounts ${accounts.provisioned} (failed ${accounts.failures.length}), ` +
        `repos ${repos.created} (failed ${repos.failures.length})`
    );
    // One event per kind per pass, not per item: an outage or a bad credential fails everything at once.
    if (accounts.failures.length > 0) {
      const accountScope = scope.clone();
      accountScope.setFingerprint(["forgejo-reconciler", "provision-failed"]);
      accountScope.setContext("failures", {
        count: accounts.failures.length,
        user_ids: accounts.failures.slice(0, 20).map((f) => f.userId)
      });
      Sentry.captureException(accounts.failures[0].error, accountScope);
    }
    if (repos.failures.length > 0) {
      const repoScope = scope.clone();
      repoScope.setFingerprint(["forgejo-reconciler", "repo-failed"]);
      repoScope.setContext("failures", {
        count: repos.failures.length,
        repositories: repos.failures.slice(0, 20).map((f) => f.repository)
      });
      Sentry.captureException(repos.failures[0].error, repoScope);
    }
    await Sentry.flush(2000);
    return json({
      provisioned: accounts.provisioned,
      failed: accounts.failures.length,
      repos_created: repos.created,
      repos_failed: repos.failures.length
    });
  } catch (error) {
    console.error("[forgejo-reconciler] Error:", error);
    Sentry.captureException(error, scope);
    await Sentry.flush(2000);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
