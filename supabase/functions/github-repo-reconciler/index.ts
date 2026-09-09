import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import { isE2eFixtureTarget } from "../_shared/e2eGithubGuard.ts";
import { assignmentShouldHaveRepos } from "../_shared/handoutRepoStrategy.ts";

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
const REPAIR_GRACE_MINUTES = 30;
// Upper bound on how far back to look. An assignment this old whose repair has never succeeded is a
// standing problem for a human (job 3 alerts on it well before this), not something to keep
// retrying against GitHub every 15 minutes forever.
const REPAIR_MAX_AGE_DAYS = 30;
// Each repair instantiates a template and syncs permissions — GitHub work measured in seconds, not
// milliseconds. Capped so one run cannot outlive its own 15-minute cadence; the remainder is picked
// up next tick, and the set only shrinks.
const REPAIR_MAX_PER_RUN = 5;

type RepairTally = { missing: number; created: number; failed: number; alerted: number };
const EMPTY_REPAIR: RepairTally = { missing: 0, created: 0, failed: 0, alerted: 0 };

/** The one row shape both jobs reduce to, so the alert/repair half is written once. */
type RepairCandidate = {
  id: number;
  class_id: number;
  slug: string | null;
  created_at: string;
  repo_mode: RepairCandidateMode;
  org: string;
  courseSlug: string | null;
};

/** `assignments.repo_mode` as the generated types express it. */
type RepairCandidateMode = Parameters<typeof assignmentShouldHaveRepos>[0];

/**
 * Repair assignments whose handout or solution repo was never created.
 *
 * WHICH ASSIGNMENTS SHOULD HAVE WHICH REPO — this is the whole correctness question, and it is
 * decided by `repo_mode` (see `_shared/handoutRepoStrategy.ts`, which is authoritative):
 *
 *   none / no_submission        no repo of either kind. assignment-create-handout-repo actively
 *                               CLEARS template_repo for these, so a NULL is correct and must
 *                               never be "repaired". Excluded by the repo_mode filter.
 *   template_only_staff         handout created; solution created.
 *   template_with_student_forks handout created (students team gets read); solution created.
 *   fork_from_prior_assignment  handout INHERITED from the source assignment rather than created,
 *                               but template_repo is still expected to be non-NULL. Re-invoking
 *                               the function is still the right repair — it takes the
 *                               inherit_from_source branch. Its own solution repo is created
 *                               normally.
 *
 * So "pointer is NULL and repo_mode is not none/no_submission" is the correct condition for BOTH,
 * and neither `has_autograder` nor `submission_mode` narrows it: the new-assignment page gates
 * both calls on repo_mode alone, and a repo-only or PR-mode assignment still needs its handout and
 * still needs pawtograder.yml read out of a solution repo (that is where submissionFiles comes
 * from, which the empty-submission check depends on whether or not an autograder runs).
 *
 * WHY THE POINTER IS THE SIGNAL: each function writes its pointer before, or immediately after,
 * the GitHub work it cannot repeat — `autograder.grader_repo` at the very top of
 * assignment-create-solution-repo, `assignments.template_repo` after createRepo succeeds. NULL
 * therefore means the function did not get that far, which is the create-path miss this repairs.
 *
 * E2E FIXTURES ARE EXCLUDED. assignment-create-handout-repo returns BEFORE persisting
 * template_repo for `pawtograder-playground` fixture classes, deliberately, so those rows are
 * permanently NULL by design — without this filter the reconciler would retry them against
 * GitHub every 15 minutes forever. (The solution function writes grader_repo before its own e2e
 * guard, so those self-exclude, but it is filtered here too so the two jobs cannot drift.)
 */
async function repairMissingAssignmentRepos(opts: {
  kind: "handout" | "solution";
  supabase: ReturnType<typeof createClient<Database>>;
  serviceRoleKey: string;
  edgeFunctionsUrl: string;
  scope: Sentry.Scope;
}): Promise<RepairTally> {
  const { kind, supabase, serviceRoleKey, edgeFunctionsUrl, scope } = opts;
  const isHandout = kind === "handout";
  const functionName = isHandout ? "assignment-create-handout-repo" : "assignment-create-solution-repo";
  const tally: RepairTally = { missing: 0, created: 0, failed: 0, alerted: 0 };

  const now = Date.now();
  const graceCutoff = new Date(now - REPAIR_GRACE_MINUTES * 60 * 1000).toISOString();
  const oldestConsidered = new Date(now - REPAIR_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // The two queries are written out rather than built from a ternary: postgrest-js derives the row
  // type from the select STRING, and a union of two literals collapses it to an unusable type.
  let candidates: RepairCandidate[];
  if (isHandout) {
    const { data, error } = await supabase
      .from("assignments")
      .select("id, class_id, slug, created_at, repo_mode, classes!inner(github_org, slug)")
      .is("template_repo", null)
      .not("repo_mode", "in", "(none,no_submission)")
      .not("classes.github_org", "is", null)
      .lt("created_at", graceCutoff)
      .gt("created_at", oldestConsidered)
      .order("created_at", { ascending: true });
    if (error) throw error;
    candidates = (data ?? []).map((a) => ({
      id: a.id,
      class_id: a.class_id,
      slug: a.slug,
      created_at: a.created_at,
      repo_mode: a.repo_mode,
      org: a.classes.github_org!,
      courseSlug: a.classes.slug
    }));
  } else {
    const { data, error } = await supabase
      .from("assignments")
      .select(
        "id, class_id, slug, created_at, repo_mode, classes!inner(github_org, slug), autograder!inner(grader_repo)"
      )
      .is("autograder.grader_repo", null)
      .not("repo_mode", "in", "(none,no_submission)")
      .not("classes.github_org", "is", null)
      .lt("created_at", graceCutoff)
      .gt("created_at", oldestConsidered)
      .order("created_at", { ascending: true });
    if (error) throw error;
    candidates = (data ?? []).map((a) => ({
      id: a.id,
      class_id: a.class_id,
      slug: a.slug,
      created_at: a.created_at,
      repo_mode: a.repo_mode,
      org: a.classes.github_org!,
      courseSlug: a.classes.slug
    }));
  }

  const missing = candidates.filter(
    // `assignmentShouldHaveRepos` is the authority, applied to the rows rather than trusted to the
    // SQL: the repo_mode filter above is a prefilter for efficiency, and re-checking here is what
    // stops the two descriptions of the matrix drifting apart when a repo_mode is added.
    (a) => assignmentShouldHaveRepos(a.repo_mode) && !isE2eFixtureTarget({ org: a.org, courseSlug: a.courseSlug })
  );
  tally.missing = missing.length;
  if (missing.length === 0) return tally;

  // Alert on the WHOLE overdue set, not just the slice this tick repairs: an assignment past the
  // threshold is a human's problem whether or not this run reaches it, and reporting is what turns
  // a silent hole into a visible one.
  const alertCutoff = now - ALERT_AFTER_HOURS * 60 * 60 * 1000;
  for (const assignment of missing) {
    if (new Date(assignment.created_at).getTime() > alertCutoff) continue;
    const missScope = scope.clone();
    missScope.setTag("class_id", String(assignment.class_id));
    missScope.setTag("assignment_id", String(assignment.id));
    missScope.setTag("repo_kind", kind);
    missScope.setFingerprint([`${kind}-repo-missing`, String(assignment.class_id), String(assignment.id)]);
    missScope.setContext("missing_assignment_repo", {
      assignment_id: assignment.id,
      assignment_slug: assignment.slug,
      created_at: assignment.created_at,
      hours_missing: ALERT_AFTER_HOURS
    });
    missScope.setLevel("error");
    Sentry.captureMessage(`Assignment has no ${kind} repo long after creation`, missScope);
    tally.alerted++;
  }

  for (const assignment of missing.slice(0, REPAIR_MAX_PER_RUN)) {
    try {
      // Re-invoking the same edge function the new-assignment page would have called, with the
      // service role (accepted via assertUserIsInstructorOrServiceRole) and no argument the UI
      // could not have supplied. createRepo has a pre-existing-repo branch, so an assignment whose
      // repo does exist on GitHub is ADOPTED rather than damaged — which is exactly the state a
      // handout failure after createRepo but before the pointer write leaves behind.
      const response = await fetch(`${edgeFunctionsUrl.replace(/\/$/, "")}/${functionName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ assignment_id: assignment.id, class_id: assignment.class_id })
      });
      if (!response.ok) {
        throw new Error(`${functionName} returned ${response.status}: ${await response.text()}`);
      }
      tally.created++;
      console.log(
        `[github-repo-reconciler] Created missing ${kind} repo for assignment ${assignment.id} (class ${assignment.class_id})`
      );
    } catch (repairError) {
      // One assignment failing must not abandon the rest, and the run is idempotent: a repaired
      // assignment has a non-NULL pointer and drops out of the query next tick.
      tally.failed++;
      const failScope = scope.clone();
      failScope.setTag("class_id", String(assignment.class_id));
      failScope.setTag("assignment_id", String(assignment.id));
      failScope.setTag("repo_kind", kind);
      failScope.setFingerprint([`${kind}-repo-repair-failed`, String(assignment.class_id)]);
      Sentry.captureException(repairError, failScope);
      console.error(
        `[github-repo-reconciler] Failed to create ${kind} repo for assignment ${assignment.id}:`,
        repairError
      );
    }
  }
  console.log(
    `[github-repo-reconciler] ${kind} repos missing: ${missing.length}; repaired ${tally.created}, failed ${tally.failed}`
  );
  return tally;
}

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

    // 3) Create assignment-level repos that the create path never created.
    //
    // Handout first: `fork_from_prior_assignment` inherits its template_repo from a source
    // assignment, so a source that is itself unrepaired has to be fixed before its dependents.
    // Ordering both jobs by created_at ascending is what makes that fall out for free. Solution
    // creation also seeds handout file hashes from template_repo as its last step, so it reads
    // better after the handout pointer exists.
    const repairs = { handout: EMPTY_REPAIR, solution: EMPTY_REPAIR };
    const edgeFunctionsUrl = Deno.env.get("EDGE_FUNCTIONS_URL");
    if (!edgeFunctionsUrl) {
      // Skipped rather than fatal: jobs 1 and 2 are the reason this function is scheduled, and a
      // deployment that has not set this should still get them.
      console.warn("[github-repo-reconciler] EDGE_FUNCTIONS_URL not set; skipping assignment-repo repair");
    } else {
      repairs.handout = await repairMissingAssignmentRepos({
        kind: "handout",
        supabase,
        serviceRoleKey: supabaseKey,
        edgeFunctionsUrl,
        scope
      });
      repairs.solution = await repairMissingAssignmentRepos({
        kind: "solution",
        supabase,
        serviceRoleKey: supabaseKey,
        edgeFunctionsUrl,
        scope
      });
    }

    // Edge runtime may tear down as soon as the response is returned; flush queued Sentry events first.
    await Sentry.flush(2000);
    return new Response(
      JSON.stringify({
        success: true,
        requeued: requeuedCount ?? 0,
        long_stuck_alerted: stuck.length,
        handout_repos_repaired: repairs.handout.created,
        handout_repos_failed: repairs.handout.failed,
        handout_repos_alerted: repairs.handout.alerted,
        solution_repos_repaired: repairs.solution.created,
        solution_repos_failed: repairs.solution.failed,
        solution_repos_alerted: repairs.solution.alerted,
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
