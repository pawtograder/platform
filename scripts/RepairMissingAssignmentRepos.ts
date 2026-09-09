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
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createAdminClient } from "@/utils/supabase/client";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// Mirrors _shared/handoutRepoStrategy.ts::assignmentShouldHaveRepos and _shared/e2eGithubGuard.ts.
// Restated rather than imported because those are Deno modules (relative ".ts" specifiers) and this
// runs under tsx; keep them in step if a repo_mode is ever added.
const REPO_MODES_WITHOUT_REPOS = new Set(["none", "no_submission"]);
const E2E_FIXTURE_ORG = "pawtograder-playground";
const isE2eFixture = (org: string | null, courseSlug: string | null, repoName?: string | null) =>
  org === E2E_FIXTURE_ORG &&
  ((courseSlug?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("e2e-ignore-") ?? false) ||
    (repoName?.startsWith("test-e2e") ?? false) ||
    (repoName?.startsWith("e2e-test") ?? false));

// PostgREST caps a response at max_rows (1000, in both supabase/config.toml and the chart), so an
// unpaged read would report a complete result while silently omitting everything past the cap.
const PAGE_SIZE = 500;

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
async function makeHandoutExistenceChecker(): Promise<(org: string, repo: string) => Promise<boolean | null>> {
  const appId = process.env.GITHUB_APP_ID;
  const raw = process.env.GITHUB_PRIVATE_KEY_STRING;
  if (!appId || !raw) {
    throw new Error("--check-github needs GITHUB_APP_ID and GITHUB_PRIVATE_KEY_STRING in .env.local");
  }
  // .env files commonly store the PEM with literal \n; normalize to real newlines.
  const privateKey = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;

  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  const installations = await appOctokit.request("GET /app/installations", { per_page: 100 });
  const byOrg = new Map<string, number>();
  for (const inst of installations.data) {
    if (inst.account && "login" in inst.account) byOrg.set(inst.account.login.toLowerCase(), inst.id);
  }
  // One installation-scoped client per org, reused across that org's assignments.
  const clients = new Map<string, Octokit>();

  return async (org: string, repo: string) => {
    const installationId = byOrg.get(org.toLowerCase());
    if (installationId === undefined) return null;
    let client = clients.get(org.toLowerCase());
    if (!client) {
      client = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId } });
      clients.set(org.toLowerCase(), client);
    }
    try {
      await client.request("GET /repos/{owner}/{repo}", { owner: org, repo });
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) return false;
      // Anything else (403, 5xx, network) is unknown, not absent.
      return null;
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
  classes: { slug: string | null; github_org: string | null; archived: boolean | null } | null;
  autograder: { grader_repo: string | null } | null;
};

async function main() {
  const apply = hasFlag("apply");
  const checkGithub = hasFlag("check-github");
  const classId = intArg("class");
  const assignmentId = intArg("assignment");

  const supabase = createAdminClient<Database>();

  // Orgs background automation must never touch, from configuration rather than a hardcoded list.
  // Measured on prod 2026-09-09: all 133 assignments missing a solution repo were in test/dev/demo
  // orgs and none in a real course org. `classes.is_demo` is false on every one of them, so it
  // cannot serve as the filter — the GitHub org is what actually separates them.
  const { data: excludedOrgRows, error: excludedError } = await supabase
    .from("github_orgs")
    .select("org_name")
    .eq("excluded_from_automation", true);
  if (excludedError) {
    console.error("Failed to read excluded orgs:", excludedError.message);
    process.exit(1);
  }
  const excludedOrgs = (excludedOrgRows ?? []).map((o) => o.org_name);
  const excludedList = excludedOrgs.length > 0 ? `(${excludedOrgs.map((o) => `"${o}"`).join(",")})` : null;

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("assignments")
      .select(
        "id, class_id, slug, repo_mode, template_repo, archived_at, classes(slug, github_org, archived), autograder(grader_repo)"
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
    if (REPO_MODES_WITHOUT_REPOS.has(a.repo_mode)) return false;
    // The repo NAME matters as well as the course slug — the shared predicate also treats repos
    // named `e2e-test*` / `test-e2e*` as fixtures, and omitting that is why 57 `e2e-test-class-*`
    // assignments were reported as repairable in the first production dry run.
    if (isE2eFixture(a.classes.github_org, a.classes.slug, `${a.classes.slug}-solution-${a.slug}`)) return false;
    if (!targeted && (a.classes.archived || a.archived_at)) return false;
    return true;
  });

  const missing = eligible.filter((a) => (a.autograder?.grader_repo ?? null) === null);
  const repairable = missing.filter((a) => a.template_repo !== null);
  const needsReview = missing.filter((a) => a.template_repo === null);
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
  if (!checkGithub) {
    console.log("  Skipped: from the database this is indistinguishable from a placeholder assignment");
    console.log("  that was never meant to have repos. Re-run with --check-github to settle it.");
    needsReview.forEach((a) => console.log(`  ${describe(a)}`));
  } else {
    const handoutExists = await makeHandoutExistenceChecker();
    let placeholders = 0;
    let unknown = 0;
    for (const a of needsReview) {
      const handoutName = `${a.classes!.slug}-handout-${a.slug}`;
      const exists = await handoutExists(a.classes!.github_org!, handoutName);
      if (exists === true) {
        // The repo is on GitHub but nothing in the database points at it — handout creation got
        // past createRepo and died before the pointer write. Genuinely broken.
        confirmedBroken.push(a);
        console.log(`  BROKEN  ${describe(a)}`);
        console.log(`          handout ${a.classes!.github_org}/${handoutName} exists but template_repo is NULL`);
      } else if (exists === false) {
        placeholders++;
      } else {
        unknown++;
        console.log(`  UNKNOWN ${describe(a)} — App not installed on ${a.classes!.github_org}, or GitHub errored`);
      }
    }
    console.log(
      `  ${confirmedBroken.length} genuinely broken, ${placeholders} never created (placeholders), ${unknown} unknown`
    );
  }

  // A targeted run may also want an assignment whose grader_repo was written but whose creation
  // then failed downstream (template resolution, GitHub, permission sync, config load) — the
  // pointer is non-NULL, so a sweep would never see it again.
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

  const plans: RepairPlan[] = targeted
    ? [
        ...repairable.map((row) => ({ row, functions: SOLUTION_ONLY })),
        // A named assignment with neither pointer gets the handout call too. Unlike the sweep, this
        // may CREATE a handout that never existed — naming the assignment is the confirmation that
        // you want that.
        ...needsReview.map((row) => ({ row, functions: HANDOUT_THEN_SOLUTION })),
        ...targetedPointerSet.map((row) => ({ row, functions: SOLUTION_ONLY }))
      ]
    : [
        ...repairable.map((row) => ({ row, functions: SOLUTION_ONLY })),
        ...confirmedBroken.map((row) => ({ row, functions: HANDOUT_THEN_SOLUTION }))
      ];

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to repair ${plans.length} assignment(s).`);
    if (!checkGithub && needsReview.length > 0) {
      console.log(`Add --check-github to also settle the ${needsReview.length} with no handout.`);
    }
    return;
  }

  // Sequential: each call instantiates a template and syncs permissions, which is many GitHub
  // writes. Fanning them out is how a clean repair meets a secondary rate limit and becomes a
  // partial one.
  let ok = 0;
  let failed = 0;
  for (const { row, functions } of plans) {
    let allOk = true;
    for (const fn of functions) {
      process.stdout.write(`  ${fn} for assignment ${row.id}... `);
      const { error: invokeError } = await supabase.functions.invoke(fn, {
        body: { assignment_id: row.id, class_id: row.class_id }
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
  console.log(`\nRepaired ${ok}/${plans.length}${failed ? `, ${failed} failed` : ""}.`);
  if (failed > 0) {
    // Non-zero, so a wrapper script or operator automation cannot read an incomplete repair as a
    // successful one.
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
