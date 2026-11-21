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
 * turns the flag on (20261112120100_forgejo_reconciler.sql) or a Forgejo assignment is released
 * (20261118140000_forgejo_repos.sql). Each pass then takes students who left a group off its repo
 * (20261121200000_forgejo_group_repo_revocations.sql), and revokes the workspace tokens of students who
 * have left the repo's class (20261118160000_forgejo_repo_tokens.sql), and tokens no open has re-minted
 * for 14 days (20261119190000_forgejo_repo_tokens_idle.sql).
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

function reportFailures(scope: Sentry.Scope, step: string, failures: { userId: string; error: unknown }[]) {
  if (failures.length === 0) return;
  const stepScope = scope.clone();
  stepScope.setFingerprint(["forgejo-reconciler", step]);
  stepScope.setContext("failures", {
    count: failures.length,
    user_ids: failures.slice(0, 20).map((f) => f.userId)
  });
  Sentry.captureException(failures[0].error, stepScope);
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
    const { accounts, repos, groupRepos, hashes, staffTeams, groupLeavers, revocation } = await reconcileForgejo(
      supabase,
      config
    );
    console.log(
      `[forgejo-reconciler] Accounts ${accounts.provisioned} (failed ${accounts.failures.length}), ` +
        `repos ${repos.created} (failed ${repos.failures.length}), ` +
        `group repos ${groupRepos.created} (failed ${groupRepos.failures.length}), ` +
        `workflow hashes ${hashes.set} (failed ${hashes.failures.length}), ` +
        `staff teams ${staffTeams.synced} (failed ${staffTeams.failures.length}), ` +
        `group leavers removed ${groupLeavers.removed} (failed ${groupLeavers.failures.length})`
    );
    console.log(`[forgejo-reconciler] Revoked ${revocation.revoked} tokens, failed ${revocation.failures.length}`);
    // One event per kind per pass, not per item: an outage or a bad credential fails everything at once.
    reportFailures(scope, "provision-failed", accounts.failures);
    if (repos.failures.length > 0) {
      const repoScope = scope.clone();
      repoScope.setFingerprint(["forgejo-reconciler", "repo-failed"]);
      repoScope.setContext("failures", {
        count: repos.failures.length,
        repos: repos.failures.slice(0, 20).map((f) => ({ assignment_id: f.assignmentId, profile_id: f.profileId }))
      });
      Sentry.captureException(repos.failures[0].error, repoScope);
    }
    if (groupRepos.failures.length > 0) {
      const groupScope = scope.clone();
      groupScope.setFingerprint(["forgejo-reconciler", "group-repo-failed"]);
      groupScope.setContext("failures", {
        count: groupRepos.failures.length,
        groups: groupRepos.failures
          .slice(0, 20)
          .map((f) => ({ assignment_id: f.assignmentId, assignment_group_id: f.assignmentGroupId }))
      });
      Sentry.captureException(groupRepos.failures[0].error, groupScope);
    }
    if (hashes.failures.length > 0) {
      const hashScope = scope.clone();
      hashScope.setFingerprint(["forgejo-reconciler", "workflow-hash-failed"]);
      hashScope.setContext("failures", {
        count: hashes.failures.length,
        assignment_ids: hashes.failures.slice(0, 20).map((f) => f.assignmentId)
      });
      Sentry.captureException(hashes.failures[0].error, hashScope);
    }
    if (staffTeams.failures.length > 0) {
      const staffScope = scope.clone();
      staffScope.setFingerprint(["forgejo-reconciler", "staff-team-failed"]);
      staffScope.setContext("failures", {
        count: staffTeams.failures.length,
        class_ids: staffTeams.failures.slice(0, 20).map((f) => f.classId)
      });
      Sentry.captureException(staffTeams.failures[0].error, staffScope);
    }
    if (groupLeavers.failures.length > 0) {
      const leaveScope = scope.clone();
      leaveScope.setFingerprint(["forgejo-reconciler", "group-leave-failed"]);
      leaveScope.setContext("failures", {
        count: groupLeavers.failures.length,
        leavers: groupLeavers.failures
          .slice(0, 20)
          .map((f) => ({ assignment_group_id: f.assignmentGroupId, profile_id: f.profileId }))
      });
      Sentry.captureException(groupLeavers.failures[0].error, leaveScope);
    }
    reportFailures(scope, "revoke-failed", revocation.failures);
    await Sentry.flush(2000);
    return json({
      provisioned: accounts.provisioned,
      failed: accounts.failures.length,
      repos_created: repos.created,
      repos_failed: repos.failures.length,
      group_repos_created: groupRepos.created,
      group_repos_failed: groupRepos.failures.length,
      workflow_hashes_set: hashes.set,
      workflow_hashes_failed: hashes.failures.length,
      staff_teams_synced: staffTeams.synced,
      staff_teams_failed: staffTeams.failures.length,
      group_leavers_removed: groupLeavers.removed,
      group_leavers_failed: groupLeavers.failures.length,
      revoked: revocation.revoked,
      revoke_failed: revocation.failures.length
    });
  } catch (error) {
    console.error("[forgejo-reconciler] Error:", error);
    Sentry.captureException(error, scope);
    await Sentry.flush(2000);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
