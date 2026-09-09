import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import { isE2eFixtureTarget } from "../_shared/e2eGithubGuard.ts";
import { assignmentShouldHaveRepos } from "../_shared/handoutRepoStrategy.ts";
import { edgeFunctionEndpoint } from "../_shared/edgeFunctionUrl.ts";
import { canStartRepair, remainingBudgetMs } from "../_shared/repairBudget.ts";
import { waitUntilWithSentryFlush } from "../_shared/SentryInit.ts";

/**
 * GitHub Repo Reconciler
 *
 * Invoked every 15 minutes via pg_cron. Three jobs:
 *  1. Re-enqueue TRANSIENT stuck repos — is_github_ready=false with no recorded creation_error and
 *     stale for a few minutes. These are repos whose create_repo job was lost/dropped; the RPC
 *     reconcile_stuck_repo_creations() re-enqueues them idempotently. Repos WITH a creation_error
 *     are terminal (a deterministic config failure) and are left for an instructor to retry.
 *  2. Alert on repos stuck > 12h — any repo still not ready 12h after it was created is surfaced to
 *     Sentry so a human notices (grouped into one issue per class+assignment to avoid storms).
 *  3. Create solution ("grader") repos the create path never created — and ONLY where the database
 *     proves it. DETACHED via waitUntil: see the note at its call site. Assignments missing both repos are neither repaired nor alerted on; see the note
 *     on repairMissingSolutionRepos for why that shape is unactionable without asking GitHub.
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

// Grace before a missing solution repo is treated as abandoned rather than in flight. Creation
// normally completes in seconds; 30 minutes is far outside that and inside the 15-minute cadence.
const REPAIR_GRACE_MINUTES = 30;
// Ceiling on AUTOMATIC repair only. An assignment older than this whose repair has never succeeded
// is a standing problem for a human, not something to keep retrying against GitHub forever.
// Alerting deliberately has NO such ceiling — see the alert query, which must keep surfacing the
// whole overdue set or a defect older than this would silently stop being reported.
const REPAIR_MAX_AGE_DAYS = 30;
const REPAIR_MAX_SUCCESSES_PER_RUN = 5;
// Attempts are capped separately from successes so that a deterministic failure (an invalid source
// assignment, a class whose GitHub App was uninstalled) costs an attempt but does NOT consume a
// success slot. Counting attempts instead would let five permanently-broken assignments at the
// front of the oldest-first ordering starve every healthy one behind them, on every tick, forever.
const REPAIR_MAX_ATTEMPTS_PER_RUN = 25;

type RepairTally = { repairable: number; ambiguous: number; created: number; failed: number; alerted: number };

/** The row shape both the repair and the alert pass reduce to. */
type AssignmentRow = {
  id: number;
  class_id: number;
  slug: string | null;
  created_at: string;
  repo_mode: Parameters<typeof assignmentShouldHaveRepos>[0];
  template_repo: string | null;
  has_autograder: boolean | null;
  source_assignment_id: number | null;
  classes: { slug: string | null; github_org: string | null; archived: boolean | null } | null;
  autograder: { grader_repo: string | null; workflow_sha: string | null } | null;
};

/**
 * Is this assignment one the product would have created repos for, and one we may safely touch?
 *
 * Deliberately conservative. Every exclusion here is a case where acting would CREATE GitHub
 * repositories that nobody asked for:
 *
 *   - repo_mode none/no_submission: `assignment-create-handout-repo` actively CLEARS template_repo
 *     for these, so a NULL pointer is the correct state. Decided by `assignmentShouldHaveRepos`.
 *   - No github_org: the class cannot have repos at all.
 *   - NULL assignment or class slug: the repo name is derived from both, so a NULL would create or
 *     ADOPT `<class>-solution-null` — and a second such assignment in the same class would then be
 *     pointed at the very same repository.
 *   - Archived class or assignment: deliberately retired. `admin_delete_class` soft-deletes by
 *     setting `classes.archived`, and archived assignments are already excluded from user-facing
 *     queries. Creating repos for them resurrects work someone chose to stop.
 *   - E2E fixtures: `assignment-create-handout-repo` returns BEFORE persisting template_repo for
 *     `pawtograder-playground` + `e2e-ignore-*` classes, by design, so those rows are permanently
 *     NULL and are not defects.
 */
function isEligibleForRepoWork(a: AssignmentRow, excludedOrgs: Set<string>): boolean {
  if (!assignmentShouldHaveRepos(a.repo_mode)) return false;
  if (!a.classes?.github_org || !a.classes?.slug) return false;
  // Case-insensitively, because the SQL `not.in` above is exact and GitHub org logins are not.
  // `admin_create_class` and `admin_update_class` store whatever was typed, and the uniqueness
  // constraint compares `lower(github_org)` — so a class recorded as `Pawtograder-Playground`
  // slips past an exclusion seeded as `pawtograder-playground` and the reconciler would create
  // repos in the very org marked off-limits. The query stays the cheap prefilter; this is the
  // authority, the same split as assignmentShouldHaveRepos below.
  if (excludedOrgs.has(a.classes.github_org.toLowerCase())) return false;
  if (!a.slug) return false;
  if (a.classes.archived) return false;
  // The repo NAME matters as well as the course slug: isE2eFixtureTarget also matches repos named
  // `e2e-test*` / `test-e2e*`, and omitting it here is why 57 `e2e-test-class-*` assignments were
  // classified as repairable in the first production dry run.
  if (
    isE2eFixtureTarget({
      org: a.classes.github_org,
      courseSlug: a.classes.slug,
      repoName: `${a.classes.slug}-solution-${a.slug}`
    })
  ) {
    return false;
  }
  return true;
}

/**
 * Repair assignments whose solution ("grader") repo was never created, and alert on the ones we
 * must not touch automatically.
 *
 * WHY ONLY THE SOLUTION REPO IS REPAIRED AUTOMATICALLY. A NULL pointer on its own does NOT mean
 * creation was attempted and failed — `assignments.repo_mode` defaults to `template_only_staff`,
 * and `scripts/SeedCourseAssignments.ts` inserts placeholder assignments without ever setting it.
 * Every placeholder in every seeded course therefore looks exactly like a failed handout: repo_mode
 * template_only_staff, template_repo NULL, no repos on GitHub. Repairing on that evidence would
 * mass-create handout and solution repositories nobody asked for, across every course.
 *
 * What distinguishes a real create-path miss is POSITIVE evidence that creation ran and got
 * partway. The new-assignment page calls handout first and solution second, so:
 *
 *   template_repo SET + grader_repo NULL   handout succeeded, solution never ran. Unambiguous —
 *                                          this is exactly the neu-cs4530/fa26 ip2 shape, and the
 *                                          only case repaired automatically.
 *   both NULL                              creation either never started or died on its first step.
 *                                          Indistinguishable from a seeded placeholder FROM THE
 *                                          DATABASE, so it is counted and otherwise ignored —
 *                                          not repaired, and not alerted on either, because the
 *                                          placeholders vastly outnumber the real failures and the
 *                                          alert would be pure noise. Only GitHub can settle it
 *                                          (does the expected handout repo exist?), which the
 *                                          script does on demand with --check-github.
 *
 * This predicate is only sound because assignment-create-solution-repo writes grader_repo LAST,
 * after the repo exists and its config is stored. It used to write it FIRST, which meant any later
 * failure — including this job's own request timeout — left a non-NULL pointer to a repo that might
 * not exist, and the row then matched no scan and was never retried or alerted. That write was moved
 * in this branch; without it, every failed repair here would quietly orphan the assignment it was
 * trying to fix.
 *
 * A handout that failed always leaves both NULL (solution never runs after it), so handout repair
 * has no unambiguous signal at all and is intentionally never automatic.
 */
async function repairMissingSolutionRepos(opts: {
  supabase: ReturnType<typeof createClient<Database>>;
  serviceRoleKey: string;
  /** `null` when EDGE_FUNCTIONS_URL is unset: detection and alerting still run, repairs do not. */
  edgeFunctionsUrl: string | null;
  scope: Sentry.Scope;
}): Promise<RepairTally> {
  const { supabase, serviceRoleKey, edgeFunctionsUrl, scope } = opts;
  const tally: RepairTally = { repairable: 0, ambiguous: 0, created: 0, failed: 0, alerted: 0 };
  const startedAt = Date.now();
  const graceCutoff = new Date(startedAt - REPAIR_GRACE_MINUTES * 60 * 1000).toISOString();

  // NO lower age bound on the query. The 30-day ceiling applies to automatic repair only; a defect
  // older than that must still be alerted, both on first deployment against existing damage and on
  // the day an unresolved one crosses the boundary.
  // Orgs that background automation must never act on, read from configuration rather than
  // hardcoded. Measured on prod 2026-09-09: every one of the 133 assignments missing a solution
  // repo was in a test/dev/demo org, and none were in a real course org — so without this the
  // reconciler would spend all of its effort creating repositories nobody wants. `classes.is_demo`
  // cannot serve here: it is false on every one of those classes.
  const excludedOrgs: string[] = [];
  for (let from = 0; ; from += 500) {
    // Paged for the same max_rows reason as the assignment scan below. An exclusion silently
    // dropped past the cap would let the reconciler create repos in an org configured to receive no
    // automation at all, which is the one outcome this list exists to prevent.
    const { data, error } = await supabase
      .from("github_orgs")
      .select("org_name")
      .eq("excluded_from_automation", true)
      .order("org_name")
      .range(from, from + 499);
    if (error) throw error;
    excludedOrgs.push(...(data ?? []).map((o) => o.org_name));
    if ((data ?? []).length < 500) break;
  }

  const rows: AssignmentRow[] = [];
  const PAGE = 500;
  // `not.in` needs a non-empty list, and the org names are quoted so a name containing a comma or
  // a parenthesis cannot break out of it.
  const excludedList = excludedOrgs.length > 0 ? `(${excludedOrgs.map((o) => `"${o}"`).join(",")})` : null;
  for (let from = 0; ; from += PAGE) {
    // Everything that CAN be expressed in SQL is, rather than read-then-discard: on prod this is
    // the difference between reading ~1000 assignments every 15 minutes and reading the handful
    // that are actually candidates. `classes.archived` uses `not.is.true` rather than `eq.false`
    // because the column is nullable and NULL means "not archived".
    let query = supabase
      .from("assignments")
      .select(
        "id, class_id, slug, created_at, repo_mode, template_repo, has_autograder, source_assignment_id, classes!inner(slug, github_org, archived), autograder!inner(grader_repo, workflow_sha)"
      )
      .is("autograder.grader_repo", null)
      .is("archived_at", null)
      .not("repo_mode", "in", "(none,no_submission)")
      .not("slug", "is", null)
      .not("classes.github_org", "is", null)
      .not("classes.slug", "is", null)
      .not("classes.archived", "is", true)
      .lt("created_at", graceCutoff);
    if (excludedList) {
      query = query.not("classes.github_org", "in", excludedList);
    }
    // `id` is the tie-breaker, and it is load-bearing rather than cosmetic: `created_at` is not
    // unique (a multi-row insert gives every row the same timestamp), and Postgres is free to
    // return tied rows in a different order for each OFFSET page. Without a stable total order the
    // pages can duplicate some rows and skip others, and a skipped row gets neither the repair nor
    // the alert — the one outcome this scan exists to prevent.
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as AssignmentRow[];
    rows.push(...page);
    // PostgREST caps a response at max_rows (1000 in both supabase/config.toml and the chart), so
    // an unpaged read would silently report a complete result while omitting everything past the
    // first page once a deployment has more assignments than that.
    if (page.length < PAGE) break;
  }

  const excludedOrgSet = new Set(excludedOrgs.map((o) => o.toLowerCase()));
  const eligible = rows.filter((a) => isEligibleForRepoWork(a, excludedOrgSet));
  // A NULL template_repo is normally unactionable — indistinguishable from a placeholder that was
  // never meant to have repos. `fork_from_prior_assignment` is the exception, and it is positive
  // evidence of the same kind the non-NULL pointer provides: nothing DEFAULTS to that mode (the
  // column default is template_only_staff), so somebody chose it and named a source assignment.
  // Repairing it is also the safe direction — the handout call inherits the source's existing repo
  // rather than creating a new one, so there is no uncertain repository to regret.
  const isConfiguredFork = (a: AssignmentRow) =>
    a.repo_mode === "fork_from_prior_assignment" && a.source_assignment_id !== null;
  const repairable = eligible.filter((a) => a.template_repo !== null || isConfiguredFork(a));
  const ambiguous = eligible.filter((a) => a.template_repo === null && !isConfiguredFork(a));
  tally.repairable = repairable.length;

  const alertCutoff = startedAt - ALERT_AFTER_HOURS * 60 * 60 * 1000;
  const alertOn = (a: AssignmentRow, kind: "solution-missing", message: string) => {
    if (new Date(a.created_at).getTime() > alertCutoff) return;
    const s = scope.clone();
    s.setTag("class_id", String(a.class_id));
    s.setTag("assignment_id", String(a.id));
    s.setFingerprint([kind, String(a.class_id), String(a.id)]);
    s.setContext("assignment_repo_gap", {
      assignment_id: a.id,
      assignment_slug: a.slug,
      repo_mode: a.repo_mode,
      template_repo: a.template_repo,
      created_at: a.created_at,
      hours_missing: ALERT_AFTER_HOURS
    });
    s.setLevel("error");
    Sentry.captureMessage(message, s);
    tally.alerted++;
  };

  // `ambiguous` (both pointers NULL) is deliberately NOT alerted on. Every placeholder assignment
  // created by scripts/SeedCourseAssignments.ts has this exact shape — and there are many, in every
  // seeded course — so an alert here fires constantly, says nothing actionable, and gets muted,
  // which is strictly worse than no alert. Resolving it needs GitHub, not the database: see
  // scripts/RepairMissingAssignmentRepos.ts --check-github, which asks whether the expected handout
  // repo actually exists. That is a human-triggered sweep precisely because it costs a GitHub
  // request per candidate and cannot be justified every 15 minutes against a set that is mostly
  // placeholders. Counted so the number is visible in the run summary without paging anyone.
  tally.ambiguous = ambiguous.length;
  for (const a of repairable) {
    alertOn(a, "solution-missing", "Assignment has a handout repo but no solution (grader) repo");
  }

  if (!edgeFunctionsUrl) {
    // Detection and alerting are database-only and are the whole escalation path for a deployment
    // that cannot make the outbound call. Skipping them along with the repairs left such a
    // deployment with nothing but a recurring console warning.
    console.warn(
      `[github-repo-reconciler] EDGE_FUNCTIONS_URL not set; alerted ${tally.alerted}, repaired none of ${repairable.length}`
    );
    return tally;
  }

  const oldestRepairable = new Date(startedAt - REPAIR_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).getTime();
  // Rotate the window between ticks. Capping attempts stops a handful of deterministic failures
  // starving the rest WITHIN a tick, but with a fixed oldest-first order the same first
  // REPAIR_MAX_ATTEMPTS_PER_RUN candidates are retried on every tick forever — so if that many fail
  // deterministically, healthy candidates behind them are never attempted at all and can cross the
  // 30-day repair ceiling while still fixable. The offset advances once per cadence period, which
  // needs no persisted state and guarantees every candidate eventually gets a turn. The alert pass
  // above is unaffected: it already covers the whole set on every run.
  const rotation =
    repairable.length === 0 ? 0 : Math.floor(startedAt / (STALE_MINUTES * 60 * 1000)) % repairable.length;
  const rotated = [...repairable.slice(rotation), ...repairable.slice(0, rotation)];
  let attempts = 0;
  for (const a of rotated) {
    if (tally.created >= REPAIR_MAX_SUCCESSES_PER_RUN) break;
    if (attempts >= REPAIR_MAX_ATTEMPTS_PER_RUN) break;
    if (!canStartRepair(Date.now() - startedAt)) {
      console.warn("[github-repo-reconciler] Not enough budget left to start another repair; resumes next tick");
      break;
    }
    if (new Date(a.created_at).getTime() < oldestRepairable) continue;

    // Revalidate the retirement guards immediately before acting. This pass is detached and may run
    // for minutes, so an operator can archive the assignment or its class, or mark the org excluded,
    // between the scan and this candidate's turn — and creating repositories for something somebody
    // has just deliberately retired is exactly what those guards exist to prevent. The solution
    // handler rechecks repo_mode itself, but it reads neither archive flag nor the org exclusion.
    // The org exclusion is re-read too, not taken from the set captured at the start of the pass.
    // It is a safety switch: an operator flipping it expects automation to stop, and a detached pass
    // can still be working through candidates minutes later. Reading the flag for this one org is a
    // single indexed lookup.
    const [{ data: fresh, error: freshError }, { data: freshOrg, error: freshOrgError }] = await Promise.all([
      supabase
        .from("assignments")
        .select("repo_mode, archived_at, classes!inner(slug, github_org, archived)")
        .eq("id", a.id)
        .maybeSingle(),
      supabase
        .from("github_orgs")
        .select("excluded_from_automation")
        .ilike("org_name", a.classes?.github_org ?? "")
        .maybeSingle()
    ]);
    if (freshOrgError || freshOrg?.excluded_from_automation) {
      // Unreadable is treated the same as excluded: this is the switch that stops automation, so
      // "we could not tell" must not mean "carry on".
      scope.setTag("repair_skipped_revalidation", "org_excluded_or_unknown");
      console.log(
        `[github-repo-reconciler] Org ${a.classes?.github_org} is excluded or unreadable; skipping assignment ${a.id}`
      );
      continue;
    }
    if (freshError) {
      // A failed read is not permission to proceed.
      console.warn(`[github-repo-reconciler] Could not revalidate assignment ${a.id}; skipping this tick`);
      continue;
    }
    const stillEligible =
      fresh !== null &&
      fresh.archived_at === null &&
      assignmentShouldHaveRepos(fresh.repo_mode) &&
      isEligibleForRepoWork(
        {
          ...a,
          repo_mode: fresh.repo_mode,
          classes: fresh.classes as AssignmentRow["classes"]
        },
        excludedOrgSet
      );
    if (!stillEligible) {
      scope.setTag("repair_skipped_revalidation", "true");
      console.log(`[github-repo-reconciler] Assignment ${a.id} no longer eligible for repair; skipping`);
      continue;
    }

    attempts++;
    try {
      // A non-NULL template_repo proves the handout call reached its pointer write — but that write
      // happens BEFORE updateAutograderWorkflowHash, so a failure in between leaves the pointer set
      // and autograder.workflow_sha NULL. Nothing else restores it: the solution call does not, and
      // once that call writes grader_repo the assignment drops out of this scan for good while every
      // student submission is rejected for a workflow-SHA mismatch. Re-run the handout call first in
      // that case — it is idempotent (createRepo adopts the existing repo) and it is what calls
      // updateAutograderWorkflowHash.
      // Either the handout never ran at all (a configured fork with no inherited pointer yet), or it
      // ran but died before updateAutograderWorkflowHash.
      const needsHandoutFinish =
        a.template_repo === null || (a.has_autograder !== false && (a.autograder?.workflow_sha ?? null) === null);
      const functions = needsHandoutFinish
        ? ["assignment-create-handout-repo", "assignment-create-solution-repo"]
        : ["assignment-create-solution-repo"];
      // The reserve is re-checked before EACH request, not just once per candidate. A
      // handout-then-solution pair can spend the whole reserve on the first call, and the second
      // would then start with a near-zero timeout, abort immediately, and be recorded as a genuine
      // failure with a Sentry event — reporting a budget shortfall as a broken assignment.
      let ranOutOfBudget = false;
      for (const fn of functions) {
        if (!canStartRepair(Date.now() - startedAt)) {
          ranOutOfBudget = true;
          break;
        }
        // Bounded by whatever budget is actually left.
        const left = remainingBudgetMs(Date.now() - startedAt);
        const response = await fetch(edgeFunctionEndpoint(edgeFunctionsUrl, fn), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
          body: JSON.stringify({ assignment_id: a.id, class_id: a.class_id }),
          signal: AbortSignal.timeout(left)
        });
        if (!response.ok) {
          throw new Error(`${fn} returned ${response.status}: ${await response.text()}`);
        }
      }
      if (ranOutOfBudget) {
        // Neither created nor failed: nothing is wrong with this assignment, we simply stopped. A
        // partial handout-then-solution leaves grader_repo NULL, so the row is still repairable and
        // the next tick picks it up — the handout call it did make is idempotent.
        console.warn(`[github-repo-reconciler] Budget exhausted mid-repair of assignment ${a.id}; resumes next tick`);
        break;
      }
      tally.created++;
      console.log(
        `[github-repo-reconciler] Repaired assignment ${a.id} (class ${a.class_id}) via ${functions.join(" + ")}`
      );
    } catch (repairError) {
      // Costs an attempt, not a success slot, so the loop moves past a permanently broken
      // assignment to the healthy ones behind it rather than retrying the same five forever.
      tally.failed++;
      const failScope = scope.clone();
      failScope.setTag("class_id", String(a.class_id));
      failScope.setTag("assignment_id", String(a.id));
      failScope.setFingerprint(["solution-repo-repair-failed", String(a.class_id)]);
      Sentry.captureException(repairError, failScope);
      console.error(`[github-repo-reconciler] Failed to create solution repo for assignment ${a.id}:`, repairError);
    }
  }
  if (eligible.length > 0) {
    console.log(
      `[github-repo-reconciler] Solution repos repairable: ${repairable.length} (repaired ${tally.created}, failed ${tally.failed}); ` +
        `ambiguous (no handout either, not touched): ${ambiguous.length}`
    );
  }
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

    // 3) Create solution repos the create path never created, and alert on the rest.
    // 3) DETACHED, not awaited. pg_cron reaches this function through
    // call_edge_function_internal with a 5000ms pg_net timeout
    // (20260709130000_repo-creation-reconciler.sql), while a repair pass is bounded at 240s and a
    // single creation has been measured at p50 279.5s under contention. Awaiting it inside the
    // handler meant the scheduled caller gave up, and disconnected, on every single tick — jobs 1
    // and 2 are fast and would have returned fine, but job 3 could never complete within the
    // invocation that triggers it.
    //
    // Same shape as assignment-create-all-repos, which detaches its own long repo-creation run:
    // hand the work to waitUntil and answer immediately. waitUntilWithSentryFlush flushes when the
    // BACKGROUND work settles rather than when the response returns, which matters here because
    // every alert and every failure this job reports is captured after that point.
    const repairTask = async () => {
      try {
        const repairs = await repairMissingSolutionRepos({
          supabase,
          serviceRoleKey: supabaseKey,
          edgeFunctionsUrl: Deno.env.get("EDGE_FUNCTIONS_URL") ?? null,
          scope
        });
        console.log(
          `[github-repo-reconciler] Repair pass: repaired ${repairs.created}, failed ${repairs.failed}, ` +
            `alerted ${repairs.alerted}, missing both repos ${repairs.ambiguous}`
        );
      } catch (error) {
        // Nothing is awaiting this, so an escaping error would otherwise be invisible.
        console.error("[github-repo-reconciler] Repair pass failed:", error);
        Sentry.captureException(error, scope);
      }
    };
    waitUntilWithSentryFlush(repairTask());

    // Edge runtime may tear down as soon as the response is returned; flush queued Sentry events first.
    await Sentry.flush(2000);
    return new Response(
      JSON.stringify({
        success: true,
        requeued: requeuedCount ?? 0,
        long_stuck_alerted: stuck.length,
        // The repair pass is detached, so its counts are not known when this response is written.
        // They are logged and reported to Sentry from the background task instead.
        solution_repair: "started",
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
