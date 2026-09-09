/**
 * Find and repair assignments whose solution ("grader") repo was never created.
 *
 * WHY THIS EXISTS: `assignment-create-handout-repo` and `assignment-create-solution-repo` are
 * called from exactly one place in the product — the new-assignment page
 * (`app/course/[course_id]/manage/assignments/new/page.tsx`), which awaits them in sequence. If the
 * handout call rejects, the solution call never runs, and nothing retries either. Re-saving the
 * assignment does not call them. On 2026-09-08 the handout call for neu-cs4530/fa26 `ip2` took
 * 95.6s server-side, the browser gave up at ~30s, and `fa26-solution-ip2` was never created.
 *
 * WHAT COUNTS AS EVIDENCE — this is the part that matters, because acting on a bad signal creates
 * GitHub repositories in a real org that nobody asked for. A NULL pointer alone is NOT evidence:
 * `assignments.repo_mode` defaults to `template_only_staff`, and `scripts/SeedCourseAssignments.ts`
 * inserts placeholder assignments without ever setting it, so every placeholder in every seeded
 * course looks exactly like a failed handout. The create order (handout, then solution) is what
 * separates them:
 *
 *   template_repo SET + grader_repo NULL   handout succeeded, solution never ran. Unambiguous, and
 *                                          the only thing repaired by default.
 *   both NULL                              creation never started, or died on its first step, or
 *                                          the assignment was never meant to have repos at all.
 *                                          The database cannot tell these apart, so they are
 *                                          skipped by default. --check-github settles it by asking
 *                                          whether the expected handout repo actually exists: if it
 *                                          does, the pointer is missing and the assignment IS
 *                                          broken; if it 404s, nothing was ever created and the
 *                                          assignment is almost certainly a placeholder. The
 *                                          reconciler deliberately does NOT do this — one GitHub
 *                                          request per candidate every 15 minutes, against a set
 *                                          that is mostly placeholders, is not worth it.
 *
 * The NULL check is only sound because assignment-create-solution-repo writes grader_repo LAST,
 * after the repo exists and its config is stored — it used to write it first, so any later failure
 * left a pointer to a repo that might not exist and the row matched no scan ever again.
 *
 * Also excluded: classes with no github_org, archived classes and assignments, rows with a NULL
 * class or assignment slug (the repo name is derived from both, so a NULL would create or adopt
 * `<class>-solution-null` and point several assignments at one repository), and e2e fixtures
 * (`pawtograder-playground` + `e2e-ignore-*`, whose handout creation deliberately returns before
 * persisting template_repo).
 *
 * SAFETY: repair re-invokes the same edge function the product would have called, with no argument
 * the UI could not have supplied. `createRepo` has a pre-existing-repo branch, so an assignment
 * whose repo does exist on GitHub is adopted rather than damaged. Dry run is the default, and
 * --apply exits non-zero if any repair failed.
 *
 * Requires a service-role environment (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local).
 *
 * Usage:
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts                      # dry run, everything
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --class 123          # dry run, one class
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --class 123 --apply  # repair one class
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --check-github        # settle the ambiguous set
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --check-github --apply # and repair what it finds
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --assignment 456 --apply
 *        # one assignment, INCLUDING the needs-review shape and including a non-NULL grader_repo
 *        # (for a run that failed after the pointer was written). Naming it is the confirmation.
 */
import {
  assignmentShouldHaveRepos,
  expectedHandoutRepo,
  handoutPointerIsOurs
} from "@/supabase/functions/_shared/handoutRepoStrategy";
import type { AssignmentRepoMode } from "@/supabase/functions/_shared/repoCreationStrategy";
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createAdminClient } from "@/utils/supabase/client";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// Mirrors _shared/e2eGithubGuard.ts. Restated rather than imported: that module reaches for Deno
// APIs, and this runs under tsx. `assignmentShouldHaveRepos` used to be restated here for the same
// stated reason, but handoutRepoStrategy.ts is Deno-free — its only cross-module import is a `import
// type`, which is erased — so it is imported above instead. One fewer copy of a rule that has
// already drifted once in this file's history.
const E2E_FIXTURE_ORG = "pawtograder-playground";
const isE2eFixture = (org: string | null, courseSlug: string | null, repoName?: string | null) =>
  // Lowercased for the same reason as the shared predicate: an exact comparison fails OPEN, and an
  // explicit --assignment deliberately bypasses the excluded-org set, so this is the only thing
  // left standing between a fixture and a real GitHub mutation.
  org?.toLowerCase() === E2E_FIXTURE_ORG &&
  ((courseSlug?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("test-e2e") ?? false) ||
    (repoName?.startsWith("e2e-test") ?? false));

// PostgREST caps a response at max_rows (1000, in both supabase/config.toml and the chart), so an
// unpaged read would report a complete result while silently omitting everything past the cap.
const PAGE_SIZE = 500;

// Matches the reconciler's grace. `template_repo` is written before the rest of handout setup and
// before the solution call, so an assignment still being created legitimately looks "repairable"
// for the length of that flow. A broad sweep that acted on it would race the run already in
// progress into duplicate GitHub creation and permission work. A named --assignment overrides it,
// since that is a human who knows the state.
const SWEEP_GRACE_MINUTES = 30;

// Every option this script accepts. Anything else is a typo, and a typo must not silently widen the
// run: `--clas 123 --apply` would otherwise leave classId undefined and sweep every repairable
// assignment instead of one class.
const VALUE_OPTIONS = new Set(["class", "assignment"]);
const BOOLEAN_OPTIONS = new Set(["apply", "check-github"]);

function validateArgv(): void {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      // A bare word or a short option is not silently ignored: `-c 123 --apply` and
      // `class 123 --apply` both leave classId undefined, which turns a scoped repair into an
      // all-assignment one. That is the same widening the option checks below exist to stop.
      console.error(`Unexpected argument "${token}". Options must be written in full, as --name value.`);
      process.exit(2);
    }
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) continue;
    if (VALUE_OPTIONS.has(name)) {
      // Present-but-valueless must not read as absent, for the same widening reason.
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`--${name} requires a value`);
        process.exit(2);
      }
      i++;
      continue;
    }
    console.error(`Unknown option "${token}".`);
    console.error(
      `Known options: ${[...VALUE_OPTIONS].map((o) => `--${o} <n>`).join(", ")}, ${[...BOOLEAN_OPTIONS].map((o) => `--${o}`).join(", ")}`
    );
    process.exit(2);
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Strict, because this flag decides which GitHub repositories get created. `Number.parseInt`
 * accepts a numeric prefix, so `--class 123x` would silently target class 123 and `--assignment
 * 456.7` would target 456 — a typo must not redirect the mutation onto another valid record.
 */
function intArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    console.error(`--${name} must be a positive integer (got "${raw}")`);
    process.exit(2);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Does the handout repo an assignment WOULD have been given actually exist on GitHub?
 *
 * This is the only thing that can separate "handout creation failed before it wrote the pointer"
 * from "this assignment was never meant to have repos". The repo name is fully determined by the
 * class slug and assignment slug (`assignment-create-handout-repo` derives it the same way), so a
 * plain existence check answers it:
 *
 *   200  the repo is there and the database pointer is missing  -> genuinely broken, repair it
 *   404  nothing was ever created                               -> placeholder, leave it alone
 *
 * Returns null when the answer is UNKNOWN — the App is not installed on the org, or GitHub failed.
 * Unknown must not be read as either verdict: reporting a placeholder as broken invites someone to
 * create a repo nobody wanted, and reporting a broken one as fine hides it.
 */
/**
 * "exists" / "absent" are answers. "inaccessible" and "error" are not, and they differ: the first is
 * a stable property of how the App is installed, the second is a transient failure that makes the
 * whole sweep incomplete and must be reflected in the exit status.
 */
type HandoutProbe = "exists" | "absent" | "inaccessible" | "error";

async function makeHandoutExistenceChecker(): Promise<(org: string, repo: string) => Promise<HandoutProbe>> {
  const appId = process.env.GITHUB_APP_ID;
  const raw = process.env.GITHUB_PRIVATE_KEY_STRING;
  if (!appId || !raw) {
    throw new Error("--check-github needs GITHUB_APP_ID and GITHUB_PRIVATE_KEY_STRING in .env.local");
  }
  // .env files commonly store the PEM with literal \n; normalize to real newlines.
  const privateKey = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;

  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  // Paged explicitly: @octokit/core has no `.paginate` (that lives in plugin-paginate-rest, which
  // this project does not depend on), so a single request would cap at 100 installations and every
  // org past the first page would report UNKNOWN and never be repairable.
  // `repository_selection` is kept alongside the id because it changes what a 404 MEANS. An
  // installation scoped to selected repositories returns 404 for a repo that exists but is not in
  // the selection, which is indistinguishable from a repo that is not there — and reading it as
  // "never created" files a genuinely broken assignment as a placeholder and drops it from --apply.
  // github-check-app-installation draws the same distinction for the same reason.
  const byOrg = new Map<string, { id: number; selection: string }>();
  for (let page = 1; ; page++) {
    const installations = await appOctokit.request("GET /app/installations", { per_page: 100, page });
    for (const inst of installations.data) {
      if (inst.account && "login" in inst.account) {
        byOrg.set(inst.account.login.toLowerCase(), {
          id: inst.id,
          selection: inst.repository_selection ?? "all"
        });
      }
    }
    if (installations.data.length < 100) break;
  }
  // One installation-scoped client per org, reused across that org's assignments.
  const clients = new Map<string, Octokit>();

  return async (org: string, repo: string): Promise<HandoutProbe> => {
    const installation = byOrg.get(org.toLowerCase());
    if (installation === undefined) return "inaccessible";
    let client = clients.get(org.toLowerCase());
    if (!client) {
      client = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId: installation.id }
      });
      clients.set(org.toLowerCase(), client);
    }
    try {
      await client.request("GET /repos/{owner}/{repo}", { owner: org, repo });
      return "exists";
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        // Only an installation that can see EVERY repo in the org can turn a 404 into "absent".
        // Under `selected`, the same 404 is returned for a repo that exists but was not granted, so
        // the honest answer is that we cannot see it — a stable fact about the installation, not a
        // transient failure.
        return installation.selection === "all" ? "absent" : "inaccessible";
      }
      // A rate limit, a 5xx, a network drop: the question was never answered. Distinct from
      // "inaccessible", because it makes the run incomplete rather than describing the setup.
      return "error";
    }
  };
}

type Row = {
  id: number;
  class_id: number;
  slug: string | null;
  repo_mode: string;
  template_repo: string | null;
  archived_at: string | null;
  created_at: string;
  has_autograder: boolean | null;
  source_assignment_id: number | null;
  classes: { slug: string | null; github_org: string | null; archived: boolean | null } | null;
  autograder: { grader_repo: string | null; workflow_sha: string | null } | null;
};

async function main() {
  validateArgv();
  const apply = hasFlag("apply");
  const checkGithub = hasFlag("check-github");
  const classId = intArg("class");
  const assignmentId = intArg("assignment");

  const supabase = createAdminClient<Database>();

  // Orgs background automation must never touch, from configuration rather than a hardcoded list.
  // Measured on prod 2026-09-09: all 133 assignments missing a solution repo were in test/dev/demo
  // orgs and none in a real course org. `classes.is_demo` is false on every one of them, so it
  // cannot serve as the filter — the GitHub org is what actually separates them.
  const excludedOrgs: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    // Paged for the same max_rows reason as the assignment scan. A truncated exclusion list means
    // --apply creating repositories in an org explicitly configured to receive no automation.
    const { data, error } = await supabase
      .from("github_orgs")
      .select("org_name")
      .eq("excluded_from_automation", true)
      .order("org_name")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("Failed to read excluded orgs:", error.message);
      process.exit(1);
    }
    excludedOrgs.push(...(data ?? []).map((o) => o.org_name));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  const excludedList = excludedOrgs.length > 0 ? `(${excludedOrgs.map((o) => `"${o}"`).join(",")})` : null;
  const excludedOrgSet = new Set(excludedOrgs.map((o) => o.toLowerCase()));

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("assignments")
      .select(
        "id, class_id, slug, repo_mode, template_repo, archived_at, created_at, has_autograder, source_assignment_id, classes(slug, github_org, archived), autograder(grader_repo, workflow_sha)"
      )
      .order("class_id")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (classId !== undefined) query = query.eq("class_id", classId);
    if (assignmentId !== undefined) query = query.eq("id", assignmentId);
    // Excluded orgs are filtered in SQL, not read and discarded. A named --assignment bypasses it,
    // since that is a human deliberately repairing one row.
    if (excludedList && assignmentId === undefined) {
      query = query.not("classes.github_org", "in", excludedList);
    }

    const { data, error } = await query;
    if (error) {
      console.error("Failed to read assignments:", error.message);
      process.exit(1);
    }
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  // An explicitly named assignment is a human saying "yes, this one" — it bypasses the ambiguity
  // and archived guards, which exist to stop an UNATTENDED sweep from acting on a bad signal.
  const targeted = assignmentId !== undefined;

  const eligible = rows.filter((a) => {
    if (!a.classes?.github_org || !a.classes?.slug) return false;
    if (!a.slug) return false;
    // Case-insensitive, for the same reason as the reconciler: the SQL filter is exact but GitHub
    // org logins are not, and classes store whatever capitalization was typed.
    //
    // Gated on `targeted`, like the archived and grace checks below it. The SQL query already
    // exempts a named --assignment from the exclusion, and the flag is scoped to background
    // automation — so applying it here unconditionally made it impossible to repair anything in a
    // test/dev/demo org by hand, contradicting both the query and the column's own documentation.
    if (!targeted && excludedOrgSet.has(a.classes.github_org.toLowerCase())) return false;
    if (!assignmentShouldHaveRepos(a.repo_mode as AssignmentRepoMode)) return false;
    // The repo NAME matters as well as the course slug — the shared predicate also treats repos
    // named `e2e-test*` / `test-e2e*` as fixtures, and omitting that is why 57 `e2e-test-class-*`
    // assignments were reported as repairable in the first production dry run.
    if (isE2eFixture(a.classes.github_org, a.classes.slug, `${a.classes.slug}-solution-${a.slug}`)) return false;
    if (!targeted && (a.classes.archived || a.archived_at)) return false;
    // Skip assignments whose creation may still be running (see SWEEP_GRACE_MINUTES).
    if (!targeted && Date.now() - new Date(a.created_at).getTime() < SWEEP_GRACE_MINUTES * 60 * 1000) return false;
    return true;
  });

  if (targeted && rows.length === 0) {
    // A stale id, or an id paired with the wrong --class. Without this the empty result flows into
    // an empty plan and --apply exits 0 after printing "Repaired 0/0", so operator automation reads
    // a repair that never even found its assignment as a success.
    console.error(`No assignment ${assignmentId}${classId !== undefined ? ` in class ${classId}` : ""} found.`);
    process.exit(1);
  }
  if (targeted && eligible.length === 0) {
    // It exists but something disqualified it — a no-repo repo_mode, a class with no github_org, a
    // NULL slug. Say so rather than reporting nothing to do.
    console.error(
      `Assignment ${assignmentId} is not eligible for repo work (check repo_mode, the class's github_org, and slugs).`
    );
    process.exit(1);
  }

  const missing = eligible.filter((a) => (a.autograder?.grader_repo ?? null) === null);
  // The same exception the reconciler makes, and for the same reason. A NULL template_repo is
  // normally unactionable — indistinguishable from a placeholder that was never meant to have repos
  // — but `fork_from_prior_assignment` with a named source is positive evidence of the same kind a
  // non-NULL pointer gives: nothing DEFAULTS to that mode (the column default is
  // template_only_staff), so somebody chose it and picked a source. Repairing it is also the safe
  // direction, because the handout call INHERITS the source's existing repository rather than
  // creating a new one — there is no uncertain repository to regret. Without this the script put
  // every such row in needsReview, so a run without --check-github silently skipped assignments the
  // reconciler would have repaired.
  const isConfiguredFork = (a: Row) => a.repo_mode === "fork_from_prior_assignment" && a.source_assignment_id !== null;
  const repairable = missing.filter((a) => a.template_repo !== null || isConfiguredFork(a));
  const needsReview = missing.filter((a) => a.template_repo === null && !isConfiguredFork(a));
  const pointerSet = eligible.filter((a) => (a.autograder?.grader_repo ?? null) !== null);

  const describe = (a: Row) =>
    `class=${a.class_id} assignment=${a.id} ${a.slug} (${a.repo_mode})` +
    `  -> ${a.classes!.github_org}/${a.classes!.slug}-solution-${a.slug}`;

  console.log(`\n=== Repairable: handout exists, solution repo missing (${repairable.length}) ===`);
  repairable.forEach((a) => console.log(`  ${describe(a)}`));

  console.log(`\n=== No handout either (${needsReview.length}) ===`);
  // Resolved against GitHub only on request: it costs a request per assignment, and most of these
  // are placeholders from SeedCourseAssignments, which never sets repo_mode and so leaves every one
  // of them looking exactly like a failed handout.
  const confirmedBroken: Row[] = [];
  // Transient GitHub failures during --check-github. Tracked separately from "not visible", because
  // an unanswered question makes the run incomplete while a scoped installation is just a fact.
  let checkFailures = 0;

  const byId = new Map(rows.map((r) => [r.id, r]));

  // The handout a `fork_from_prior_assignment` INHERITS: the source assignment's template_repo.
  // Used twice — to probe the right repository under --check-github, and to decide below whether a
  // pointer already on the row is the inherited one (safe to rerun) or a custom choice (must not be
  // rebuilt over).
  const sourceHandoutFor = async (a: Row, opts?: { reload?: boolean }): Promise<string | null> => {
    // `byId` only holds what the scan returned, and the scan is narrowed by --class and
    // --assignment. A fork whose source sits in another class, or any fork in an --assignment run,
    // would miss here and be reported as having no source — dropping a genuinely broken assignment
    // from the plan. Fetch the source directly when it is not already in hand.
    if (a.source_assignment_id === null) return null;
    // `reload` bypasses the plan-time cache. The apply loop needs it: on a broad sweep, an
    // instructor can repoint the SOURCE while earlier repairs run, and answering from the cached
    // snapshot would compare the target's pointer against the source's OLD handout — classifying a
    // pointer that is now custom as automation-owned, and rerunning creation to replace it with the
    // source's new one. The plan-building path deliberately keeps the cache: it reads every row in
    // one pass and has no window to go stale within.
    const known = opts?.reload === true ? undefined : byId.get(a.source_assignment_id);
    if (known) return known.template_repo ?? null;
    const { data: fetched, error: sourceError } = await supabase
      .from("assignments")
      .select("template_repo")
      .eq("id", a.source_assignment_id)
      .maybeSingle();
    if (sourceError) {
      // Discarding this would report NO SOURCE for an assignment whose source may well have a
      // handout, drop it from the plan, repair everything else, and exit 0 — so operator automation
      // reads an incomplete sweep as a complete one. A failed lookup is not an answer about the
      // source.
      console.error(
        `Failed to load source assignment ${a.source_assignment_id} for assignment ${a.id}: ${sourceError.message}`
      );
      process.exit(1);
    }
    return fetched?.template_repo ?? null;
  };
  if (!checkGithub) {
    console.log("  Skipped: from the database this is indistinguishable from a placeholder assignment");
    console.log("  that was never meant to have repos. Re-run with --check-github to settle it.");
    needsReview.forEach((a) => console.log(`  ${describe(a)}`));
  } else {
    const handoutExists = await makeHandoutExistenceChecker();
    let placeholders = 0;
    let inaccessible = 0;
    // `fork_from_prior_assignment` never creates `<course>-handout-<assignment>` — it copies the
    // SOURCE assignment's template_repo. Probing the derived name would 404 for every such row and
    // silently file a genuine failure as a placeholder, so resolve the source's repo instead.
    for (const a of needsReview) {
      let owner = a.classes!.github_org!;
      let handoutName = `${a.classes!.slug}-handout-${a.slug}`;
      if (a.repo_mode === "fork_from_prior_assignment") {
        const sourceRepo = await sourceHandoutFor(a);
        if (!sourceRepo) {
          // No source, or a source that is itself unprovisioned: there is nothing to inherit, so
          // this is a configuration problem rather than a repo that failed to be created.
          console.log(
            `  NO SOURCE ${describe(a)} — forks from #${a.source_assignment_id ?? "?"}, which has no handout`
          );
          continue;
        }
        [owner, handoutName] = sourceRepo.split("/");
      }
      const exists = await handoutExists(owner, handoutName);
      if (exists === "error") {
        // A transient failure leaves this assignment undetermined, which makes the whole sweep
        // incomplete. Recorded so --apply cannot exit 0 over it.
        checkFailures++;
        console.log(`  ERROR   ${describe(a)} — could not check ${owner}/${handoutName}; run incomplete`);
      } else if (exists === "exists") {
        // The repo is on GitHub but nothing in the database points at it — handout creation got
        // past createRepo and died before the pointer write. Genuinely broken.
        confirmedBroken.push(a);
        console.log(`  BROKEN  ${describe(a)}`);
        console.log(`          handout ${owner}/${handoutName} exists but template_repo is NULL`);
      } else if (exists === "absent") {
        placeholders++;
      } else {
        inaccessible++;
        console.log(
          `  NOT VISIBLE ${describe(a)} — the App is not installed on ${owner}, or is scoped to selected repos`
        );
      }
    }
    console.log(
      `  ${confirmedBroken.length} genuinely broken, ${placeholders} never created (placeholders), ` +
        `${inaccessible} not visible to this installation, ${checkFailures} check failure(s)`
    );
  }

  // A targeted run may also want an assignment whose pointer is set but whose repo is wrong or
  // absent. Since grader_repo is now written last, that is no longer the normal shape of a partial
  // failure — but it remains reachable (the pointer write itself failing after the config write, or
  // a repo deleted on GitHub afterwards), and a sweep would never look at it again.
  const targetedPointerSet = targeted ? pointerSet : [];
  if (targetedPointerSet.length > 0) {
    console.log(`\n=== Named assignment already has a grader_repo pointer ===`);
    console.log("  Re-running is safe (createRepo adopts an existing repo) and is how a creation");
    console.log("  that failed after the pointer write is recovered.");
    targetedPointerSet.forEach((a) => console.log(`  ${describe(a)} (currently ${a.autograder!.grader_repo})`));
  }

  // Each entry carries WHICH functions to re-run, because the two broken shapes need different
  // work. A repairable row already has its handout pointer, so only the solution call is missing.
  // A GitHub-confirmed broken row has an orphaned handout repo AND no pointer, so the handout call
  // has to run first — it adopts the existing repo (createRepo has a pre-existing-repo branch) and
  // writes template_repo — before the solution call, which reads that pointer when it seeds handout
  // file hashes.
  const SOLUTION_ONLY = ["assignment-create-solution-repo"];
  const HANDOUT_THEN_SOLUTION = ["assignment-create-handout-repo", "assignment-create-solution-repo"];
  type RepairPlan = { row: Row; functions: string[] };

  // A non-NULL template_repo proves the handout call reached its pointer write, but that write
  // happens BEFORE updateAutograderWorkflowHash — so a failure in between leaves the pointer set and
  // autograder.workflow_sha NULL, which the solution call never restores. Once it writes grader_repo
  // the row leaves this scan for good while student submissions are rejected for a workflow-SHA
  // mismatch. Finish the handout first in that case.
  // Same gate as the reconciler: assignment-create-handout-repo ignores whatever template_repo
  // holds, rebuilds the pointer and overwrites the column with it, so rerunning it against an
  // assignment carrying a CUSTOM handout silently replaces the instructor's choice. Completing a
  // missing workflow_sha is not worth that; those rows get the solution repair only.
  //
  // `expectedHandoutRepo` rather than the derived name inline, and shared with the reconciler so
  // the two cannot disagree about which rows are safe to rerun. It matters most for
  // fork_from_prior_assignment, which creates no handout at all — it mirrors the SOURCE's pointer,
  // which can never equal `<class>-handout-<assignment>`. Comparing against the derived name
  // reported every inherited handout as custom, so an inherit that wrote its pointer and then died
  // before recording its workflow hash got solution creation only: that publishes grader_repo,
  // which drops the row out of the automatic scan for good, leaving workflow_sha NULL and every
  // student submission rejected for a workflow-SHA mismatch.
  //
  // Resolved up front rather than inside planFor, because the fork source may need a query and
  // planFor is called from .map().
  const expectedHandouts = new Map<number, string | null>();
  for (const row of [...repairable, ...targetedPointerSet]) {
    expectedHandouts.set(
      row.id,
      expectedHandoutRepo({
        mode: row.repo_mode as AssignmentRepoMode,
        githubOrg: row.classes?.github_org,
        classSlug: row.classes?.slug,
        assignmentSlug: row.slug,
        sourceTemplateRepo: row.repo_mode === "fork_from_prior_assignment" ? await sourceHandoutFor(row) : null
      })
    );
  }

  const planFor = (row: Row) => {
    const expected = expectedHandouts.get(row.id) ?? null;
    const handoutIsOurs = handoutPointerIsOurs(row.template_repo, expected);
    // A missing pointer needs the handout call whatever the autograder setting: the solution call
    // reads template_repo to seed handout file hashes, and for a configured fork the pointer is the
    // only thing that links it to the source's repository. The workflow-hash clause is the OTHER
    // reason to run it, for a row that already has its pointer.
    const wantsHandout =
      row.template_repo === null || (row.has_autograder !== false && (row.autograder?.workflow_sha ?? null) === null);
    if (wantsHandout && !handoutIsOurs) {
      console.log(
        `  note: assignment ${row.id} has a custom handout (${row.template_repo}, expected ${expected ?? "none"}); not rerunning handout creation`
      );
    }
    return wantsHandout && handoutIsOurs ? HANDOUT_THEN_SOLUTION : SOLUTION_ONLY;
  };

  const plans: RepairPlan[] = targeted
    ? [
        ...repairable.map((row) => ({ row, functions: planFor(row) })),
        // A named assignment with neither pointer gets the handout call too. Unlike the sweep, this
        // may CREATE a handout that never existed — naming the assignment is the confirmation that
        // you want that.
        ...needsReview.map((row) => ({ row, functions: HANDOUT_THEN_SOLUTION })),
        ...targetedPointerSet.map((row) => ({ row, functions: planFor(row) }))
      ]
    : [
        ...repairable.map((row) => ({ row, functions: planFor(row) })),
        ...confirmedBroken.map((row) => ({ row, functions: HANDOUT_THEN_SOLUTION }))
      ];

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to repair ${plans.length} assignment(s).`);
    if (!checkGithub && needsReview.length > 0) {
      console.log(`Add --check-github to also settle the ${needsReview.length} with no handout.`);
    }
    if (checkFailures > 0) {
      // A dry run that could not check some handouts has not produced the list it claims to. Its
      // output is what an operator decides from, so it must not exit 0 either.
      console.error(`${checkFailures} assignment(s) could not be checked against GitHub; this listing is incomplete.`);
      process.exitCode = 1;
    }
    return;
  }

  // Sequential: each call instantiates a template and syncs permissions, which is many GitHub
  // writes. Fanning them out is how a clean repair meets a secondary rate limit and becomes a
  // partial one.
  let ok = 0;
  let failed = 0;
  for (const plan of plans) {
    const { row } = plan;
    let functions = plan.functions;
    // Revalidate the archive state immediately before acting, exactly as the scheduled reconciler
    // does. Repairs are sequential and each one can take minutes, so on a broad sweep an operator
    // can retire an assignment or a whole class while earlier entries are still running — and
    // neither creation function rejects an archived row, so the plan built at the start would
    // happily publish repositories for work somebody has since withdrawn. A named --assignment is
    // exempt: that is a human who knows what they are repairing.
    if (!targeted) {
      // The org exclusion is re-read too, not taken from the set loaded at startup. It is the
      // switch that stops automation, the creation functions deliberately do not enforce it, and a
      // sequential sweep can still be running minutes after an operator flips it.
      // The org is reloaded WITH the assignment, not taken from the plan. An admin can move a class
      // between orgs while earlier sequential repairs run, and the creation functions read the
      // class as it is now — so checking the org captured at plan time would clear an assignment
      // against org A and then create repositories in an excluded org B.
      const { data: fresh, error: freshError } = await supabase
        .from("assignments")
        .select(
          "archived_at, template_repo, repo_mode, source_assignment_id, has_autograder, slug, classes(archived, github_org, slug), autograder(grader_repo, workflow_sha)"
        )
        .eq("id", row.id)
        .maybeSingle();
      const currentOrg = (fresh?.classes as { github_org: string | null } | null)?.github_org ?? null;
      const { data: freshOrg, error: freshOrgError } = currentOrg
        ? await supabase
            .from("github_orgs")
            .select("excluded_from_automation")
            .ilike("org_name", currentOrg)
            .maybeSingle()
        : { data: null, error: null };
      if (freshOrgError) {
        // Unreadable counts as excluded — this is the stop switch, so "could not tell" must not mean
        // "carry on" — but it is NOT a clean skip: the assignment was never attempted, so counting
        // it as a failure is what stops automation reading the run as complete.
        failed++;
        console.log(`  skipping assignment ${row.id}: could not read the exclusion for ${currentOrg}`);
        continue;
      }
      if (freshOrg?.excluded_from_automation) {
        // A genuine exclusion IS a clean skip: the operator asked for exactly this.
        console.log(`  skipping assignment ${row.id}: org ${currentOrg} is excluded from automation`);
        continue;
      }
      if (freshError) {
        // A failed read is not permission to proceed.
        console.log(`  skipping assignment ${row.id}: could not revalidate (${freshError.message})`);
        failed++;
        continue;
      }
      const clazz = fresh?.classes as { archived: boolean | null } | null;
      if (!fresh || fresh.archived_at || clazz?.archived) {
        console.log(`  skipping assignment ${row.id}: archived since the plan was built`);
        continue;
      }
      if (!currentOrg) {
        // The class no longer has a GitHub org, so it can no longer have repos — the same condition
        // the eligibility filter applies when the plan is built.
        console.log(`  skipping assignment ${row.id}: its class no longer has a github_org`);
        continue;
      }
      if (!assignmentShouldHaveRepos(fresh.repo_mode as AssignmentRepoMode)) {
        // An instructor opted the assignment out of repositories while earlier repairs in this
        // sweep ran. A CLEAN skip, not a failure: the assignment is in exactly the state they asked
        // for. Without this the recompute below read the now-NULL template_repo as "needs the
        // handout step", the handout endpoint returned its successful no-op, the solution endpoint
        // correctly rejected the no-repo mode, and the script reported a failed repair and exited
        // non-zero — which is what operator automation reads to decide whether the sweep worked.
        console.log(`  skipping assignment ${row.id}: repo_mode is now ${fresh.repo_mode}, which uses no repositories`);
        continue;
      }
      // Both pointers are re-read, because both creation functions will overwrite what they find:
      // the handout endpoint rebuilds the derived name and writes it over template_repo, and the
      // solution endpoint treats a grader_repo naming a different repository as stale and replaces
      // it. Earlier repairs in this sweep take minutes, so an instructor can select a custom repo in
      // between — and acting on the plan-time values would erase that choice.
      const freshGrader = (fresh.autograder as { grader_repo: string | null } | null)?.grader_repo ?? null;
      const freshWorkflowSha = (fresh.autograder as { workflow_sha: string | null } | null)?.workflow_sha ?? null;
      const freshTemplate = fresh.template_repo ?? null;
      if (freshGrader !== null) {
        console.log(
          `  skipping assignment ${row.id}: it gained a grader_repo (${freshGrader}) since the plan was built`
        );
        continue;
      }
      // Derived from the RELOADED class slug. An admin can change a class's slug — the GitHub
      // prefix every repo name is built from — while earlier repairs in this sweep run, and using
      // the plan-time slug would judge a handout named for the old prefix as still "derived",
      // letting the endpoint create a repository under the new prefix and replace the pointer.
      const currentSlug = (fresh.classes as { slug: string | null } | null)?.slug ?? null;
      if (!currentSlug) {
        console.log(`  skipping assignment ${row.id}: its class no longer has a slug`);
        continue;
      }
      // The same rule the plan used, re-evaluated against the reloaded row rather than a derived
      // name spelled out again here. Spelling it out was wrong for exactly one mode:
      // fork_from_prior_assignment mirrors the SOURCE's pointer, which can never equal
      // `<class>-handout-<assignment>`, so every inherited handout was skipped here as "custom"
      // even after planFor had correctly scheduled the handout step for it — the assignment came
      // out of a broad --apply with neither its workflow hash nor its solution repo.
      const expectedHandoutNow = expectedHandoutRepo({
        mode: (fresh.repo_mode ?? row.repo_mode) as AssignmentRepoMode,
        githubOrg: currentOrg,
        classSlug: currentSlug,
        // Reloaded for the same reason as the class slug beside it: both halves of the derived
        // handout name can be renamed while earlier repairs in this sweep run, and judging the
        // pointer against the OLD name lets creation replace one the instructor kept.
        assignmentSlug: fresh.slug ?? row.slug,
        sourceTemplateRepo:
          (fresh.repo_mode ?? row.repo_mode) === "fork_from_prior_assignment"
            ? await sourceHandoutFor(
                { ...row, source_assignment_id: fresh.source_assignment_id ?? null },
                { reload: true }
              )
            : null
      });
      // `functions` is RECOMPUTED from the reloaded row, not just narrowed. Only checking it when
      // the plan already included the handout step made the guard one-directional: a plan built as
      // solution-only stayed solution-only even after an instructor switched the assignment to
      // fork_from_prior_assignment and picked a source. The solution endpoint accepts every
      // repository-backed mode, so it would publish grader_repo while template_repo still named the
      // old handout — and a published pointer takes the assignment out of every future scan.
      const wantsHandoutNow = freshTemplate === null || (fresh.has_autograder !== false && freshWorkflowSha === null);
      const handoutIsOursNow = handoutPointerIsOurs(freshTemplate, expectedHandoutNow);
      if (wantsHandoutNow && !handoutIsOursNow) {
        console.log(
          `  skipping assignment ${row.id}: it gained a custom handout (${freshTemplate}, expected ${expectedHandoutNow ?? "none"}) since the plan was built`
        );
        continue;
      }
      const functionsNow = wantsHandoutNow ? HANDOUT_THEN_SOLUTION : SOLUTION_ONLY;
      if (functionsNow.join() !== functions.join()) {
        console.log(
          `  note: assignment ${row.id} changed since the plan was built; running ${functionsNow.join(" + ")}`
        );
      }
      functions = functionsNow;
    }
    let allOk = true;
    for (const fn of functions) {
      process.stdout.write(`  ${fn} for assignment ${row.id}... `);
      const { error: invokeError } = await supabase.functions.invoke(fn, {
        body: {
          assignment_id: row.id,
          class_id: row.class_id,
          // Only on a SWEEP. The pointer was read before the handout call, which takes minutes, and
          // this flag makes the solution endpoint refuse rather than retire a custom grader
          // repository an instructor chose in that window. A named --assignment deliberately does
          // NOT send it: replacing a differently named pointer is the whole point of a targeted
          // repair, and `targetedPointerSet` exists to do exactly that.
          ...(targeted ? {} : { expect_no_grader_repo: true })
        }
      });
      if (invokeError) {
        // Stop this assignment but keep going with the rest: the solution call depends on the
        // handout pointer the previous call was supposed to write, so running it anyway would
        // repeat the original half-finished state. The run is re-runnable.
        console.log(`FAILED: ${invokeError.message}`);
        allOk = false;
        break;
      }
      console.log("ok");
    }
    if (allOk) ok++;
    else failed++;
  }
  console.log(
    `\nRepaired ${ok}/${plans.length}${failed ? `, ${failed} failed` : ""}` +
      `${checkFailures ? `, ${checkFailures} assignment(s) could not be checked` : ""}.`
  );
  if (failed > 0 || checkFailures > 0) {
    // Non-zero, so a wrapper script or operator automation cannot read an incomplete repair — or a
    // sweep that never determined whether some handouts exist — as a successful one.
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
