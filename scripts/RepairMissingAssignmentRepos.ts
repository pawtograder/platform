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
 *                                          Listed as NEEDS REVIEW and skipped unless you name it
 *                                          explicitly with --assignment.
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
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --assignment 456 --apply
 *        # one assignment, INCLUDING the needs-review shape and including a non-NULL grader_repo
 *        # (for a run that failed after the pointer was written). Naming it is the confirmation.
 */
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createAdminClient } from "@/utils/supabase/client";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// Mirrors _shared/handoutRepoStrategy.ts::assignmentShouldHaveRepos and _shared/e2eGithubGuard.ts.
// Restated rather than imported because those are Deno modules (relative ".ts" specifiers) and this
// runs under tsx; keep them in step if a repo_mode is ever added.
const REPO_MODES_WITHOUT_REPOS = new Set(["none", "no_submission"]);
const E2E_FIXTURE_ORG = "pawtograder-playground";
const isE2eFixture = (org: string | null, courseSlug: string | null) =>
  org === E2E_FIXTURE_ORG && (courseSlug?.startsWith("e2e-ignore-") ?? false);

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
  const classId = intArg("class");
  const assignmentId = intArg("assignment");

  const supabase = createAdminClient<Database>();

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
    if (isE2eFixture(a.classes.github_org, a.classes.slug)) return false;
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

  console.log(`\n=== Needs review: no handout either (${needsReview.length}) ===`);
  console.log("  Not repaired by default — this is also what a placeholder assignment that was");
  console.log("  never meant to have repos looks like. Confirm, then use --assignment <id> --apply.");
  needsReview.forEach((a) => console.log(`  ${describe(a)}`));

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

  const toRepair = targeted ? [...repairable, ...needsReview, ...targetedPointerSet] : repairable;

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to repair ${toRepair.length} assignment(s).`);
    return;
  }

  // Sequential: each call instantiates a template and syncs permissions, which is many GitHub
  // writes. Fanning them out is how a clean repair meets a secondary rate limit and becomes a
  // partial one.
  let ok = 0;
  let failed = 0;
  for (const a of toRepair) {
    process.stdout.write(`  repairing assignment ${a.id}... `);
    const { error: invokeError } = await supabase.functions.invoke("assignment-create-solution-repo", {
      body: { assignment_id: a.id, class_id: a.class_id }
    });
    if (invokeError) {
      // Keep going: one assignment failing must not stop the rest, and the run is re-runnable.
      failed++;
      console.log(`FAILED: ${invokeError.message}`);
      continue;
    }
    ok++;
    console.log("ok");
  }
  console.log(`\nRepaired ${ok}/${toRepair.length}${failed ? `, ${failed} failed` : ""}.`);
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
