import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";

/**
 * GitHub Repo Reconciler
 *
 * Invoked every 15 minutes via pg_cron. Two jobs:
 *  1. Re-enqueue TRANSIENT stuck repos — is_github_ready=false with no recorded creation_error and
 *     stale for a few minutes. These are repos whose create_repo job was lost/dropped; the RPC
 *     reconcile_stuck_repo_creations() re-enqueues them idempotently. Repos WITH a creation_error
 *     are terminal (a deterministic config failure) and are left for an instructor to retry.
 *  2. Alert on repos stuck > 12h — any repo still not ready 12h after it was created is surfaced to
 *     Sentry so a human notices (grouped into one issue per class+assignment to avoid storms).
 *  3. Create solution ("grader") repos that were never created at all.
 *
 * Job 3 exists because `assignment-create-solution-repo` has exactly ONE caller in the product —
 * the new-assignment page, which awaits handout creation and then solution creation in sequence.
 * When the handout call rejects, the solution call never runs, and until this job there was nothing
 * anywhere that noticed: re-saving the assignment does not call it, jobs 1 and 2 above only ever
 * look at the `repositories` table (student repos), and the assignment simply keeps a handout repo
 * and no grader repo forever. That is how neu-cs4530/fa26 `ip2` ended up with `fa26-handout-ip2`
 * and no `fa26-solution-ip2` after handout creation ran 95.6s and the browser gave up at ~30s.
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

const STALE_MINUTES = 15;
const ALERT_AFTER_HOURS = 12;
// Grace period before job 3 treats a NULL grader_repo as abandoned rather than in flight. Creation
// normally completes in ~15s; 30 minutes is far outside that and well inside the 15-minute cadence.
const SOLUTION_REPO_GRACE_MINUTES = 30;
// Upper bound on how far back to look. An assignment this old whose repair has never succeeded is a
// standing problem for a human (job 3 alerts on it well before this), not something to keep
// retrying against GitHub every 15 minutes forever.
const SOLUTION_REPO_MAX_AGE_DAYS = 30;
// Each repair instantiates a template and syncs permissions — GitHub work measured in seconds, not
// milliseconds. Capped so one run cannot outlive its own 15-minute cadence; the remainder is picked
// up next tick, and the set only shrinks.
const SOLUTION_REPO_MAX_PER_RUN = 5;

Deno.serve(async (req) => {
  console.log(`[github-repo-reconciler] Received request: ${req.method}`);

  const scope = new Sentry.Scope();
  scope.setTag("function", "github-repo-reconciler");

  // Require the shared edge-function secret on EVERY request. The pg_cron invoker sends it via
  // call_edge_function_internal (injected from Vault). x-supabase-webhook-source is only an
  // attacker-settable routing/logging label and must never grant access on its own.
  const secret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");
  const webhookSource = req.headers.get("x-supabase-webhook-source");
  if (!expectedSecret || secret !== expectedSecret) {
    console.error(`[github-repo-reconciler] Unauthorized request (source=${webhookSource ?? "none"})`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error("[github-repo-reconciler] Missing required environment variables");
    return new Response(JSON.stringify({ error: "Missing required environment variables" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabase = createClient<Database>(supabaseUrl, supabaseKey);

  try {
    // 1) Re-enqueue transient stuck repos.
    const { data: requeuedCount, error: reconcileError } = await supabase.rpc("reconcile_stuck_repo_creations", {
      p_stale_minutes: STALE_MINUTES
    });
    if (reconcileError) {
      console.error("[github-repo-reconciler] reconcile_stuck_repo_creations failed:", reconcileError);
      scope.setContext("reconcile_error", { error: reconcileError.message });
      throw reconcileError;
    }
    console.log(`[github-repo-reconciler] Re-enqueued ${requeuedCount ?? 0} transient stuck repos`);

    // 2) Alert on repos stuck longer than the threshold.
    const cutoff = new Date(Date.now() - ALERT_AFTER_HOURS * 60 * 60 * 1000).toISOString();
    // Mirror reconcile_stuck_repo_creations: exclude assignments whose repo_mode doesn't require a
    // GitHub repo (none/no_submission) so we don't falsely alert on repos that will never be ready.
    const { data: stuckRepos, error: stuckError } = await supabase
      .from("repositories")
      .select("id, class_id, assignment_id, repository, creation_error, created_at, assignments!inner(repo_mode)")
      .eq("is_github_ready", false)
      .lt("created_at", cutoff)
      .not("assignments.repo_mode", "in", "(none,no_submission)");
    if (stuckError) {
      console.error("[github-repo-reconciler] Failed to query long-stuck repos:", stuckError);
      scope.setContext("stuck_query_error", { error: stuckError.message });
      throw stuckError;
    }

    const stuck = stuckRepos ?? [];
    for (const repo of stuck) {
      const repoScope = scope.clone();
      repoScope.setTag("class_id", String(repo.class_id));
      repoScope.setTag("assignment_id", String(repo.assignment_id));
      repoScope.setTag("repository", repo.repository);
      // Group into one Sentry issue per class+assignment (a misconfigured template hits many repos).
      repoScope.setFingerprint(["github-repo-stuck", String(repo.class_id), String(repo.assignment_id)]);
      repoScope.setContext("stuck_repo", {
        repository_id: repo.id,
        repository: repo.repository,
        created_at: repo.created_at,
        creation_error: repo.creation_error,
        hours_stuck: ALERT_AFTER_HOURS
      });
      repoScope.setLevel("error");
      Sentry.captureMessage("GitHub repository still not ready after alert threshold", repoScope);
    }
    if (stuck.length > 0) {
      console.warn(`[github-repo-reconciler] ${stuck.length} repos stuck > ${ALERT_AFTER_HOURS}h (alerted to Sentry)`);
    }

    // 3) Create solution ("grader") repos that were never created.
    //
    // `autograder.grader_repo` is written at the TOP of assignment-create-solution-repo, before it
    // touches GitHub, so NULL means the function never ran — which is exactly the create-path miss
    // described above. A non-NULL value means it ran and got past that write; whether the repo
    // exists is a different question, needs GitHub to answer, and is deliberately not this job's.
    const solutionRepairs = { attempted: 0, created: 0, failed: 0, alerted: 0 };
    const edgeFunctionsUrl = Deno.env.get("EDGE_FUNCTIONS_URL");
    if (!edgeFunctionsUrl) {
      // Skipped rather than fatal: jobs 1 and 2 are the reason this function is scheduled, and a
      // deployment that has not set this should still get them.
      console.warn("[github-repo-reconciler] EDGE_FUNCTIONS_URL not set; skipping solution-repo repair");
    } else {
      const now = Date.now();
      const graceCutoff = new Date(now - SOLUTION_REPO_GRACE_MINUTES * 60 * 1000).toISOString();
      const oldestConsidered = new Date(now - SOLUTION_REPO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: missingSolution, error: missingError } = await supabase
        .from("assignments")
        .select("id, class_id, slug, created_at, classes!inner(github_org), autograder!inner(grader_repo)")
        .is("autograder.grader_repo", null)
        .not("repo_mode", "in", "(none,no_submission)")
        .not("classes.github_org", "is", null)
        .lt("created_at", graceCutoff)
        .gt("created_at", oldestConsidered)
        .order("created_at", { ascending: true });
      if (missingError) {
        console.error("[github-repo-reconciler] Failed to query assignments missing a solution repo:", missingError);
        scope.setContext("missing_solution_query_error", { error: missingError.message });
        throw missingError;
      }

      const missing = missingSolution ?? [];
      // Alert on the whole set, but repair only a bounded slice: an assignment that has been
      // missing its grader repo past the threshold is a human's problem whether or not this tick
      // gets to it, and reporting it is what turns a silent hole into a visible one.
      const alertCutoff = now - ALERT_AFTER_HOURS * 60 * 60 * 1000;
      for (const assignment of missing) {
        if (new Date(assignment.created_at).getTime() > alertCutoff) continue;
        const missScope = scope.clone();
        missScope.setTag("class_id", String(assignment.class_id));
        missScope.setTag("assignment_id", String(assignment.id));
        missScope.setFingerprint(["solution-repo-missing", String(assignment.class_id), String(assignment.id)]);
        missScope.setContext("missing_solution_repo", {
          assignment_id: assignment.id,
          assignment_slug: assignment.slug,
          created_at: assignment.created_at,
          hours_missing: ALERT_AFTER_HOURS
        });
        missScope.setLevel("error");
        Sentry.captureMessage("Assignment has no solution (grader) repo long after creation", missScope);
        solutionRepairs.alerted++;
      }

      for (const assignment of missing.slice(0, SOLUTION_REPO_MAX_PER_RUN)) {
        solutionRepairs.attempted++;
        try {
          // Re-invoking the same edge function the new-assignment page would have called, with the
          // service role (accepted via assertUserIsInstructorOrServiceRole) and no argument the UI
          // could not have supplied. createRepo has a pre-existing-repo branch, so an assignment
          // whose repo does somehow exist is adopted rather than damaged.
          const response = await fetch(`${edgeFunctionsUrl.replace(/\/$/, "")}/assignment-create-solution-repo`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({ assignment_id: assignment.id, class_id: assignment.class_id })
          });
          if (!response.ok) {
            throw new Error(`assignment-create-solution-repo returned ${response.status}: ${await response.text()}`);
          }
          solutionRepairs.created++;
          console.log(
            `[github-repo-reconciler] Created missing solution repo for assignment ${assignment.id} (class ${assignment.class_id})`
          );
        } catch (repairError) {
          // One assignment failing must not abandon the rest, and the run is idempotent: a repaired
          // assignment has a non-NULL grader_repo and drops out of the query next tick.
          solutionRepairs.failed++;
          const failScope = scope.clone();
          failScope.setTag("class_id", String(assignment.class_id));
          failScope.setTag("assignment_id", String(assignment.id));
          failScope.setFingerprint(["solution-repo-repair-failed", String(assignment.class_id)]);
          Sentry.captureException(repairError, failScope);
          console.error(
            `[github-repo-reconciler] Failed to create solution repo for assignment ${assignment.id}:`,
            repairError
          );
        }
      }
      if (missing.length > 0) {
        console.log(
          `[github-repo-reconciler] Solution repos missing: ${missing.length}; repaired ${solutionRepairs.created}, failed ${solutionRepairs.failed}`
        );
      }
    }

    // Edge runtime may tear down as soon as the response is returned; flush queued Sentry events first.
    await Sentry.flush(2000);
    return new Response(
      JSON.stringify({
        success: true,
        requeued: requeuedCount ?? 0,
        long_stuck_alerted: stuck.length,
        solution_repos_repaired: solutionRepairs.created,
        solution_repos_failed: solutionRepairs.failed,
        solution_repos_alerted: solutionRepairs.alerted,
        timestamp: new Date().toISOString()
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[github-repo-reconciler] Error:", error);
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
