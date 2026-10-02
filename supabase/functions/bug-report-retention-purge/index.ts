import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
// Side effect: keeps console text and URL queries out of this function's Sentry events.
import "../_shared/SentryScrub.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { RETENTION_GRACE_DAYS, SENTRY_LOOKBACK_DAYS, SentryPurgeApi, runPurge } from "./purge.ts";

/**
 * Bug report retention purge (ADR 1, package 6b).
 *
 * Invoked daily via pg_cron (see 20260929120000_bug_reporter.sql). Deletes the Sentry feedback and
 * replays tagged with the `class_id` of every class whose end_date is more than 30 days past. The
 * rules that keep it from deleting anything else are in purge.ts.
 *
 * Which classes: get_bug_report_retention_purge_candidates() returns the classes past the grace
 * period that ended within the Sentry lookback window and weren't swept in the last day, oldest
 * sweep first. bug_report_retention_purges records each finished sweep. A class keeps being swept
 * daily until it leaves the lookback window, because a report can be filed against an archived
 * course after its first purge; once past the window, Sentry's own cleanup has removed anything
 * older and the class is never queried again.
 *
 * Logs and the response carry counts only: no class, issue or replay ids, and no report content.
 *
 * Env: SENTRY_PURGE_TOKEN (scopes org:read, project:write, event:admin), SENTRY_URL, SENTRY_ORG,
 * SENTRY_PROJECT (the project holding the replays, pawtograder-web), and optionally
 * SENTRY_PURGE_ENVIRONMENT to limit the purge to one Sentry environment. Without the token the
 * function does nothing and says so.
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

const LOG = "[bug-report-retention-purge]";

/** Classes per run. A run that can't finish them all leaves the rest for tomorrow, oldest sweep first. */
const MAX_CLASSES_PER_RUN = 50;
/** A class swept less than this long ago is skipped, so a retried or doubled cron call does no extra work. */
const RESWEEP_AFTER_HOURS = 20;
/**
 * Stop after this long, well inside the edge runtime's wall-clock limit. Checked between classes and
 * between Sentry requests inside a class; a class cut short is left unrecorded for the next run.
 */
const TIME_BUDGET_MS = 100_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const scope = new Sentry.Scope();
  scope.setTag("function", "bug-report-retention-purge");

  // The pg_cron invoker sends the shared secret via call_edge_function_internal (injected from Vault).
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  if (!expectedSecret || secret !== expectedSecret) {
    console.error(`${LOG} Unauthorized request`);
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error(`${LOG} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return json({ error: "Missing required environment variables" }, 500);
  }

  const config = {
    token: Deno.env.get("SENTRY_PURGE_TOKEN"),
    baseUrl: Deno.env.get("SENTRY_URL"),
    org: Deno.env.get("SENTRY_ORG"),
    replayProject: Deno.env.get("SENTRY_PROJECT")
  };
  const missing = Object.entries({
    SENTRY_PURGE_TOKEN: config.token,
    SENTRY_URL: config.baseUrl,
    SENTRY_ORG: config.org,
    SENTRY_PROJECT: config.replayProject
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    // Not an error: most installs have no Sentry, and a missing token is the state until HU3. Say so
    // on every run, because reports tagged with a class then live until Sentry's own cleanup.
    console.warn(`${LOG} Not configured, nothing purged. Missing: ${missing.join(", ")}`);
    return json({ success: true, skipped: "not_configured", missing });
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey, { auth: REQUEST_SCOPED_AUTH_OPTIONS });

  try {
    const { data: candidates, error: candidatesError } = await supabase.rpc(
      "get_bug_report_retention_purge_candidates",
      {
        p_grace_days: RETENTION_GRACE_DAYS,
        p_lookback_days: SENTRY_LOOKBACK_DAYS,
        p_resweep_after_hours: RESWEEP_AFTER_HOURS,
        p_limit: MAX_CLASSES_PER_RUN
      }
    );
    if (candidatesError) throw new Error(`candidate query failed: ${candidatesError.message}`);

    const api = new SentryPurgeApi({
      baseUrl: config.baseUrl!,
      org: config.org!,
      replayProject: config.replayProject!,
      token: config.token!,
      environment: Deno.env.get("SENTRY_PURGE_ENVIRONMENT") || undefined
    });

    const summary = await runPurge({
      api,
      candidates: candidates ?? [],
      timeBudgetMs: TIME_BUDGET_MS,
      recordPurged: async (classId, result) => {
        const { error } = await supabase.rpc("record_bug_report_retention_purge", {
          p_class_id: classId,
          p_feedback_deleted: result.feedbackDeleted,
          p_replays_deleted: result.replaysDeleted
        });
        if (error) throw new Error(`record failed: ${error.message}`);
      }
    });

    const counts = Object.entries(summary)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const failed = summary.classes_failed > 0 || summary.stopped_by !== null;
    if (failed) {
      console.error(`${LOG} Run finished with failures: ${counts}`);
      scope.setContext("purge_summary", summary);
      scope.setLevel("warning");
      scope.setFingerprint(["bug-report-retention-purge-failed", summary.stopped_by ?? "class-failures"]);
      Sentry.captureMessage("Bug report retention purge did not finish", scope);
    } else {
      console.log(`${LOG} Run finished: ${counts}`);
    }

    await Sentry.flush(2000);
    return json({ success: !failed, ...summary, timestamp: new Date().toISOString() }, failed ? 502 : 200);
  } catch (error) {
    console.error(`${LOG} Error:`, error instanceof Error ? error.message : "unknown");
    Sentry.captureException(error, scope);
    await Sentry.flush(2000);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
