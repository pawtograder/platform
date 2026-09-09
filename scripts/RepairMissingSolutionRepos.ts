/**
 * Find and repair assignments whose solution ("grader") repo was never created.
 *
 * WHY THIS EXISTS: `assignment-create-solution-repo` has exactly one caller in the product —
 * the new-assignment page (`app/course/[course_id]/manage/assignments/new/page.tsx`), which
 * awaits `assignmentCreateHandoutRepo` and then `assignmentCreateSolutionRepo` in sequence. If
 * the handout call rejects, the solution call never runs, and NOTHING retries it: re-saving the
 * assignment does not call it, and no reconciler scans for it. The assignment is left with a
 * handout repo and no grader repo, permanently, with no in-product way to recover.
 *
 * That is not hypothetical. On 2026-09-08 the handout call for neu-cs4530/fa26 `ip2` took 95.6s
 * server-side (see the permission-sync work in this repo's history); the browser gave up at ~30s,
 * so the solution call never fired. `fa26-handout-ip2` exists on GitHub and `fa26-solution-ip2`
 * does not. Any assignment created while handout creation was slow or failing can be in this
 * state, in any course, and there is no signal for it anywhere.
 *
 * DETECTION: `autograder.grader_repo` is written at the TOP of assignment-create-solution-repo,
 * before it touches GitHub. So a NULL `grader_repo` means the function never ran at all, which is
 * the shape this repairs. A non-NULL `grader_repo` means it ran and got at least that far — the
 * repo may still be missing if it failed later, but distinguishing that needs GitHub and is
 * reported rather than repaired (see --include-partial).
 *
 * SAFETY: repair re-invokes the same edge function the product would have called, with no
 * arguments the UI could not have supplied. `createRepo` has a pre-existing-repo branch, so an
 * assignment whose repo does exist is not damaged by a re-run. Dry-run is the default.
 *
 * Requires a service-role environment (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local);
 * assignment-create-solution-repo accepts the service role via assertUserIsInstructorOrServiceRole.
 *
 * Usage:
 *   npx tsx scripts/RepairMissingSolutionRepos.ts                      # dry run, all classes
 *   npx tsx scripts/RepairMissingSolutionRepos.ts --class 123          # dry run, one class
 *   npx tsx scripts/RepairMissingSolutionRepos.ts --assignment 456     # dry run, one assignment
 *   npx tsx scripts/RepairMissingSolutionRepos.ts --class 123 --apply  # actually repair
 *   npx tsx scripts/RepairMissingSolutionRepos.ts --include-partial    # also list grader_repo-set rows
 */
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createAdminClient } from "@/utils/supabase/client";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// repo_mode values that never get repos at all; nothing to repair for these.
const NO_REPO_MODES = new Set(["none", "no_submission"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const apply = hasFlag("apply");
  const includePartial = hasFlag("include-partial");
  const classId = arg("class") ? Number.parseInt(arg("class")!, 10) : undefined;
  const assignmentId = arg("assignment") ? Number.parseInt(arg("assignment")!, 10) : undefined;

  const supabase = createAdminClient<Database>();

  // `autograder` is 1:1 with `assignments` (autograder.id IS the assignment id), so this reads the
  // pointer and the assignment in one round trip rather than per-assignment.
  let query = supabase
    .from("assignments")
    .select("id, class_id, slug, title, repo_mode, template_repo, classes(slug, github_org), autograder(grader_repo)")
    .order("class_id")
    .order("id");
  if (classId !== undefined) query = query.eq("class_id", classId);
  if (assignmentId !== undefined) query = query.eq("id", assignmentId);

  const { data, error } = await query;
  if (error) {
    console.error("Failed to read assignments:", error.message);
    process.exit(1);
  }

  const candidates = (data ?? []).filter((a) => {
    // A class with no GitHub org cannot have repos of any kind, so a missing one is not a defect.
    if (!a.classes?.github_org || !a.classes?.slug) return false;
    if (NO_REPO_MODES.has(a.repo_mode as string)) return false;
    const graderRepo = (a.autograder as { grader_repo: string | null } | null)?.grader_repo ?? null;
    return includePartial ? true : graderRepo === null;
  });

  const missing = candidates.filter(
    (a) => ((a.autograder as { grader_repo: string | null } | null)?.grader_repo ?? null) === null
  );
  const partial = candidates.filter(
    (a) => ((a.autograder as { grader_repo: string | null } | null)?.grader_repo ?? null) !== null
  );

  console.log(`Assignments with NO grader_repo (never created): ${missing.length}`);
  for (const a of missing) {
    const expected = `${a.classes!.github_org}/${a.classes!.slug}-solution-${a.slug}`;
    console.log(
      `  class=${a.class_id} assignment=${a.id} ${a.title ?? a.slug} -> expected ${expected}` +
        `${a.template_repo ? "" : "  [also missing template_repo — run the handout repair first]"}`
    );
  }

  if (includePartial && partial.length > 0) {
    console.log(`\ngrader_repo IS set (${partial.length}) — creation got past its first write.`);
    console.log("Whether the repo actually exists needs a GitHub check; not repaired here.");
    for (const a of partial) {
      console.log(
        `  class=${a.class_id} assignment=${a.id} -> ${(a.autograder as { grader_repo: string | null }).grader_repo}`
      );
    }
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to create ${missing.length} solution repo(s).`);
    return;
  }

  // Sequential, not concurrent: each call creates a repo from a template and then syncs its
  // permissions, which is many GitHub writes. Fanning these out is how you meet a secondary rate
  // limit and turn a clean repair into a partial one.
  let ok = 0;
  for (const a of missing) {
    process.stdout.write(`Creating solution repo for assignment ${a.id} (class ${a.class_id})... `);
    const { error: invokeError } = await supabase.functions.invoke("assignment-create-solution-repo", {
      body: { assignment_id: a.id, class_id: a.class_id }
    });
    if (invokeError) {
      // Keep going: one assignment failing (a missing template, a GitHub outage) must not stop the
      // rest, and the run is re-runnable — a repaired assignment drops out of `missing` next time.
      console.log(`FAILED: ${invokeError.message}`);
      continue;
    }
    ok++;
    console.log("ok");
  }
  console.log(`\nRepaired ${ok}/${missing.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
