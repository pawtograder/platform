/**
 * Find and repair assignments whose handout or solution ("grader") repo was never created.
 *
 * WHY THIS EXISTS: `assignment-create-handout-repo` and `assignment-create-solution-repo` are
 * called from exactly one place in the product — the new-assignment page
 * (`app/course/[course_id]/manage/assignments/new/page.tsx`), which awaits them in sequence. If the
 * handout call rejects, the solution call never runs, and nothing retries either: re-saving the
 * assignment does not call them, and until the reconciler job added alongside this script, nothing
 * scanned for them. The assignment is left missing a repo, permanently, with no in-product way to
 * recover.
 *
 * That is not hypothetical. On 2026-09-08 the handout call for neu-cs4530/fa26 `ip2` took 95.6s
 * server-side; the browser gave up at ~30s, so the solution call never fired. `fa26-handout-ip2`
 * exists on GitHub and `fa26-solution-ip2` does not.
 *
 * WHICH ASSIGNMENTS SHOULD HAVE REPOS: decided by `repo_mode` alone, via
 * `assignmentShouldHaveRepos` in `supabase/functions/_shared/handoutRepoStrategy.ts` — the same
 * helper the reconciler uses, so this script cannot drift from it. `none` and `no_submission` opt
 * out entirely (handout creation actively CLEARS template_repo for them, so NULL is correct);
 * every other mode expects both pointers, including `fork_from_prior_assignment`, which inherits
 * its handout from a source assignment rather than creating one.
 *
 * DETECTION: each function writes its pointer as part of the work it cannot repeat —
 * `autograder.grader_repo` at the very top of the solution function, `assignments.template_repo`
 * after createRepo succeeds. NULL therefore means it never got that far, which is the shape this
 * repairs. A non-NULL pointer means it did; the repo may still be missing for a different reason,
 * which needs GitHub to determine and is reported rather than repaired (--include-partial).
 *
 * E2E fixtures (`pawtograder-playground` + `e2e-ignore-*`) are excluded: handout creation returns
 * before persisting template_repo for those by design, so they are permanently NULL and are not
 * defects.
 *
 * SAFETY: repair re-invokes the same edge function the product would have called, with no argument
 * the UI could not have supplied. `createRepo` has a pre-existing-repo branch, so an assignment
 * whose repo does exist on GitHub is adopted rather than damaged — which is exactly the state a
 * handout failure after createRepo but before the pointer write leaves behind. Dry run is default.
 *
 * Requires a service-role environment (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local);
 * both functions accept the service role via assertUserIsInstructorOrServiceRole.
 *
 * Usage:
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts                       # dry run, both kinds
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --kind handout        # dry run, handout only
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --assignment 456      # dry run, one assignment
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --class 123 --apply   # repair one class
 *   npx tsx scripts/RepairMissingAssignmentRepos.ts --include-partial     # also list set pointers
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

type Kind = "handout" | "solution";
const FUNCTION_FOR: Record<Kind, string> = {
  handout: "assignment-create-handout-repo",
  solution: "assignment-create-solution-repo"
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

type Row = {
  id: number;
  class_id: number;
  slug: string | null;
  repo_mode: string;
  template_repo: string | null;
  classes: { slug: string | null; github_org: string | null } | null;
  autograder: { grader_repo: string | null } | null;
};

async function main() {
  const apply = hasFlag("apply");
  const includePartial = hasFlag("include-partial");
  const kindArg = (arg("kind") ?? "both") as Kind | "both";
  if (!["handout", "solution", "both"].includes(kindArg)) {
    console.error(`--kind must be handout, solution, or both (got "${kindArg}")`);
    process.exit(2);
  }
  const kinds: Kind[] = kindArg === "both" ? ["handout", "solution"] : [kindArg];
  const classId = arg("class") ? Number.parseInt(arg("class")!, 10) : undefined;
  const assignmentId = arg("assignment") ? Number.parseInt(arg("assignment")!, 10) : undefined;

  const supabase = createAdminClient<Database>();

  // One read for both kinds. `autograder` is 1:1 with `assignments` (autograder.id IS the
  // assignment id), so both pointers come back together.
  let query = supabase
    .from("assignments")
    .select("id, class_id, slug, repo_mode, template_repo, classes(slug, github_org), autograder(grader_repo)")
    .order("class_id")
    .order("id");
  if (classId !== undefined) query = query.eq("class_id", classId);
  if (assignmentId !== undefined) query = query.eq("id", assignmentId);

  const { data, error } = await query;
  if (error) {
    console.error("Failed to read assignments:", error.message);
    process.exit(1);
  }

  const eligible = ((data ?? []) as unknown as Row[]).filter((a) => {
    // A class with no GitHub org cannot have repos of any kind, so a missing one is not a defect.
    if (!a.classes?.github_org || !a.classes?.slug) return false;
    if (REPO_MODES_WITHOUT_REPOS.has(a.repo_mode)) return false;
    return !isE2eFixture(a.classes.github_org, a.classes.slug);
  });

  const pointerOf = (a: Row, kind: Kind) =>
    kind === "handout" ? a.template_repo : (a.autograder?.grader_repo ?? null);

  // Handout first: fork_from_prior_assignment inherits its template_repo from a source assignment,
  // so a source that is itself unrepaired has to be fixed before its dependents. Solution creation
  // also seeds handout file hashes from template_repo as its last step.
  for (const kind of kinds) {
    const missing = eligible.filter((a) => pointerOf(a, kind) === null);
    console.log(`\n=== ${kind}: ${missing.length} assignment(s) with no repo ===`);
    for (const a of missing) {
      const suffix = kind === "handout" ? "handout" : "solution";
      const expected = `${a.classes!.github_org}/${a.classes!.slug}-${suffix}-${a.slug}`;
      const inherits = a.repo_mode === "fork_from_prior_assignment" && kind === "handout";
      console.log(
        `  class=${a.class_id} assignment=${a.id} ${a.slug} (${a.repo_mode})` +
          (inherits ? "  -> inherits handout from its source assignment" : `  -> expected ${expected}`)
      );
    }

    if (includePartial) {
      const partial = eligible.filter((a) => pointerOf(a, kind) !== null);
      console.log(`  (${partial.length} already have a ${kind} pointer; whether the repo exists needs GitHub)`);
    }

    if (!apply) continue;

    // Sequential, not concurrent: each call instantiates a template and syncs permissions, which is
    // many GitHub writes. Fanning these out is how a clean repair meets a secondary rate limit and
    // becomes a partial one.
    let ok = 0;
    for (const a of missing) {
      process.stdout.write(`  repairing ${kind} for assignment ${a.id}... `);
      const { error: invokeError } = await supabase.functions.invoke(FUNCTION_FOR[kind], {
        body: { assignment_id: a.id, class_id: a.class_id }
      });
      if (invokeError) {
        // Keep going: one assignment failing (a missing source, a GitHub outage) must not stop the
        // rest, and the run is re-runnable — a repaired assignment drops out of `missing` next time.
        console.log(`FAILED: ${invokeError.message}`);
        continue;
      }
      // Refresh the in-memory pointer so the solution pass sees the handout this pass just created.
      if (kind === "handout") a.template_repo = `${a.classes!.github_org}/${a.classes!.slug}-handout-${a.slug}`;
      ok++;
      console.log("ok");
    }
    console.log(`  repaired ${ok}/${missing.length}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to create the repos listed above.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
