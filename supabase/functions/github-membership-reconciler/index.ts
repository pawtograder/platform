import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import { INVITE_STALE_DAYS } from "../_shared/orgInviteWindow.ts";

/**
 * GitHub Membership Reconciler
 *
 * Invoked hourly via pg_cron (see 20260909140000_github_membership_reconciler.sql). The membership
 * counterpart of github-repo-reconciler, and the GitHub counterpart of discord-reconciler. Two jobs:
 *
 *  1. Re-invite enrollments whose org invitation LAPSED, or was never sent. A GitHub org invitation
 *     expires after 7 days and GitHub emits no event when it does, so an unaccepted invitation used
 *     to be terminal: every automated invite path is gated on `invitation_date IS NULL`, and the
 *     webhook stamps that column the moment the first invitation goes out. The student then sits
 *     outside the org — and therefore outside the team, and therefore without repo permissions —
 *     until they log in or press "Sync GitHub Account". reconcile_stale_org_invitations() finds
 *     those rows and queues an ordinary async-worker envelope per user, bounded per pass, and only
 *     for classes whose term window is open.
 *
 *  2. Alert on classes where students are stuck ANYWAY. Two shapes, deliberately distinguished:
 *
 *       missing term dates   The sweep skips these on purpose — with no start_date/end_date we
 *                            cannot tell whether the class is in session, and the wrong guess mails
 *                            GitHub invitations to a roster that is not enrolled yet. This alert is
 *                            what stops "skip" from meaning "fail silently"; it names the class and
 *                            says which dates to fill in.
 *       still stuck          Term dates set, window open, and students remain unconfirmed anyway —
 *                            a broken App installation, a login GitHub no longer recognizes, an org
 *                            that requires SSO. Automation cannot fix these; a human has to look.
 *
 *     One Sentry issue per class in both cases, never one per student: the failures that cause this
 *     strand a whole roster at once, and per-student events would bury the signal (the same lesson
 *     the Discord terminal-failure work learned from a 30,332-row flood).
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

/**
 * Enrollments re-invited per pass.
 *
 * Bounds a first run against existing damage (and any future org-wide breakage) so it drains in
 * waves instead of firing a term's worth of invitation mail in one tick. At hourly cadence this is
 * still 1200/day, far more than a real backlog.
 */
const MAX_REINVITES_PER_PASS = 50;

/**
 * How long a `user_roles` row must have been settled before a NULL invitation_date counts as a
 * dropped enqueue rather than one still in flight. The enrollment trigger fires on the same row, so
 * anything shorter races it and double-invites.
 */
const NEW_ROLE_GRACE_MINUTES = 30;

/**
 * Days unconfirmed before a class is alerted on. Comfortably longer than the staleness threshold:
 * the first re-invite should have gone out and been accepted well inside this, so crossing it means
 * the repair itself is not working.
 */
const ALERT_AFTER_DAYS = 14;

type MembershipAlert = {
  class_id: number;
  class_slug: string | null;
  github_org: string | null;
  term_start: string | null;
  term_end: string | null;
  window_open: boolean | null;
  missing_term_dates: boolean | null;
  stuck_count: number;
  oldest_invitation: string | null;
};

/** Emit one Sentry issue per class for the two stuck shapes. Returns the counts, for the response. */
function alertOnStuckClasses(alerts: MembershipAlert[], scope: Sentry.Scope) {
  let unsetTermDates = 0;
  let stuckInWindow = 0;

  for (const alert of alerts) {
    const classScope = scope.clone();
    classScope.setTag("class_id", String(alert.class_id));
    classScope.setTag("class_slug", alert.class_slug ?? "unknown");
    classScope.setTag("github_org", alert.github_org ?? "unknown");
    classScope.setContext("stuck_membership", {
      class_id: alert.class_id,
      class_slug: alert.class_slug,
      github_org: alert.github_org,
      start_date: alert.term_start,
      end_date: alert.term_end,
      students_not_in_org: alert.stuck_count,
      oldest_invitation: alert.oldest_invitation,
      unconfirmed_for_days: ALERT_AFTER_DAYS,
      invite_window_open: alert.window_open
    });
    classScope.setLevel("warning");

    if (alert.missing_term_dates) {
      // Actionable in one step, and the message says which step.
      classScope.setFingerprint(["github-org-invite-window-unset", String(alert.class_id)]);
      Sentry.captureMessage(
        "GitHub org re-invites are disabled for this class: start_date/end_date are not set",
        classScope
      );
      unsetTermDates++;
      continue;
    }
    if (!alert.window_open) {
      // Term dates set and the window is closed — the class is genuinely over (or has not started).
      // Students unconfirmed in a finished class are not a defect worth waking anyone for.
      continue;
    }
    classScope.setFingerprint(["github-org-membership-stuck", String(alert.class_id)]);
    Sentry.captureMessage("Students are still not in the class GitHub org after re-invitation", classScope);
    stuckInWindow++;
  }

  return { unsetTermDates, stuckInWindow };
}

Deno.serve(async (req) => {
  console.log(`[github-membership-reconciler] Received request: ${req.method}`);

  const scope = new Sentry.Scope();
  scope.setTag("function", "github-membership-reconciler");

  // Require the shared edge-function secret on EVERY request. The pg_cron invoker sends it via
  // call_edge_function_internal (injected from Vault). x-supabase-webhook-source is only an
  // attacker-settable routing/logging label and must never grant access on its own.
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  const webhookSource = req.headers.get("x-supabase-webhook-source");
  if (!expectedSecret || secret !== expectedSecret) {
    console.error(`[github-membership-reconciler] Unauthorized request (source=${webhookSource ?? "none"})`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error("[github-membership-reconciler] Missing required environment variables");
    return new Response(JSON.stringify({ error: "Missing required environment variables" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  try {
    // 1) Re-invite lapsed / never-sent invitations.
    const { data: reinvited, error: reconcileError } = await supabase.rpc("reconcile_stale_org_invitations", {
      p_stale_days: INVITE_STALE_DAYS,
      p_new_role_grace_minutes: NEW_ROLE_GRACE_MINUTES,
      p_max: MAX_REINVITES_PER_PASS
    });
    if (reconcileError) {
      console.error("[github-membership-reconciler] reconcile_stale_org_invitations failed:", reconcileError);
      scope.setContext("reconcile_error", { error: reconcileError.message });
      throw reconcileError;
    }
    console.log(`[github-membership-reconciler] Re-invited ${reinvited ?? 0} enrollment(s)`);

    // 2) Alert on classes still stuck, and on the ones the sweep is not allowed to touch.
    // Runs regardless of what the sweep did: the alert is the entire escalation path for both the
    // classes it skipped and the ones where re-inviting is not the answer.
    const { data: alertRows, error: alertError } = await supabase.rpc("get_stuck_org_membership_alerts", {
      p_days: ALERT_AFTER_DAYS
    });
    if (alertError) {
      console.error("[github-membership-reconciler] get_stuck_org_membership_alerts failed:", alertError);
      scope.setContext("alert_query_error", { error: alertError.message });
      throw alertError;
    }

    const alerts = (alertRows ?? []) as MembershipAlert[];
    const { unsetTermDates, stuckInWindow } = alertOnStuckClasses(alerts, scope);
    if (unsetTermDates > 0 || stuckInWindow > 0) {
      console.warn(
        `[github-membership-reconciler] Alerted: ${stuckInWindow} class(es) with students still outside the org, ` +
          `${unsetTermDates} class(es) skipped for unset term dates`
      );
    }

    // Edge runtime may tear down as soon as the response is returned; flush queued Sentry events first.
    await Sentry.flush(2000);
    return new Response(
      JSON.stringify({
        success: true,
        reinvited: reinvited ?? 0,
        classes_alerted_stuck: stuckInWindow,
        classes_alerted_unset_term_dates: unsetTermDates,
        timestamp: new Date().toISOString()
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[github-membership-reconciler] Error:", error);
    Sentry.captureException(error, scope);
    await Sentry.flush(2000);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString()
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
