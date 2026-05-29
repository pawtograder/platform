/* eslint-disable no-console */
/**
 * InitDemoManifest — refresh the program-design-and-implementation-ii block in canned-repos.json from
 * a real source-of-truth class plus a real instructor's GitHub-linked submission
 * repos. Run this when the pawtograder-playground repos change or when you want
 * to re-pin grader commit SHAs.
 *
 * Inputs (all via flags, with sensible defaults for the current setup):
 *   --class-id <N>             Source class id (default 500)
 *   --github-username <name>   GitHub user whose submission repos seed ripley/orion/paws
 *                              (default jon-bell)
 *   --archetype <key>          Block to overwrite in canned-repos.json (default program-design-and-implementation-ii)
 *
 * What it pulls:
 *   • assignments(title, slug, total_points, autograder_points, due_date, minutes_due_after_lab,
 *                 template_repo) from the source class
 *   • autograder(grader_repo, grader_commit_sha) joined by assignment id
 *   • repositories(repository) belonging to the source GitHub user, per assignment
 *
 * Mapping rules for studentSubmissions:
 *   The user's repos for each assignment are ordered (created_at asc) and assigned
 *   to ripley first, then orion, then paws. If there are fewer than 3 repos for an
 *   assignment, the remaining fleet members fall back to genericStudentSubmission
 *   (set to the first repo, or omitted if there are none).
 *
 * Behavior on missing data:
 *   • Assignment has no template_repo → entry written with empty handoutRepo string
 *     and a [warn] line so you know to fill it in by hand.
 *   • Assignment has no autograder row → solutionRepo + graderCommitSha left blank,
 *     real-handouts mode will skip the autograder wiring for that one.
 *   • User has no repos for an assignment → studentSubmissions omitted entirely.
 *
 * The script overwrites only the chosen archetype's block; everything else in
 * canned-repos.json (including the underscore-prefixed disabled archetypes) is
 * preserved.
 */
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import type {
  CannedArchetype,
  CannedAssignment,
  CannedRepoManifest,
  RealFleetName,
  SourceSubmissionSnapshot
} from "./fixtures.types";
import { mirrorRepoToOrgIfMissing, runWithConcurrency } from "./syncRepos";

/** Demo org that the provisioning CLI has write access to. Source repos from the
 * source class (which live in the class's own org) are mirrored here so demo
 * provisioning never depends on access to the source org. */
const DEMO_ORG = "pawtograder-playground";
const MIRROR_CONCURRENCY = 5;

dotenv.config({ path: ".env.local", quiet: true });

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "demo", "canned-repos.json");

const FLEET_ORDER: RealFleetName[] = ["ripley", "orion", "paws"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CliArgs {
  classId: number;
  githubUsername: string;
  archetype: string;
  /** When false, don't mirror source repos into the demo org — just record the
   * source-org names in the manifest. */
  copyRepos: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: CliArgs = {
    classId: 500,
    githubUsername: "jon-bell",
    archetype: "program-design-and-implementation-ii",
    copyRepos: true
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--class-id":
        out.classId = parseInt(val, 10);
        i++;
        break;
      case "--github-username":
        out.githubUsername = val;
        i++;
        break;
      case "--archetype":
        out.archetype = val;
        i++;
        break;
      case "--skip-repo-copy":
        out.copyRepos = false;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npx tsx scripts/demo/InitDemoManifest.ts [--class-id 500] [--github-username jon-bell] " +
            "[--archetype program-design-and-implementation-ii] [--skip-repo-copy]"
        );
        process.exit(0);
        break;
    }
  }
  if (Number.isNaN(out.classId)) throw new Error("--class-id must be a number");
  return out;
}

async function resolveSourceProfileId(
  supabase: ReturnType<typeof createAdminClient<Database>>,
  classId: number,
  githubUsername: string
): Promise<{ userId: string; profileId: string }> {
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("user_id, github_username")
    .eq("github_username", githubUsername)
    .maybeSingle();
  if (userErr) throw new Error(`Lookup user by github_username failed: ${userErr.message}`);
  if (!user) throw new Error(`No user found with github_username='${githubUsername}'`);

  const { data: role, error: roleErr } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", user.user_id)
    .eq("class_id", classId)
    .maybeSingle();
  if (roleErr) throw new Error(`Lookup user_roles failed: ${roleErr.message}`);
  if (!role) throw new Error(`${githubUsername} is not enrolled in class ${classId}`);

  return { userId: user.user_id, profileId: role.private_profile_id };
}

async function loadAssignments(
  supabase: ReturnType<typeof createAdminClient<Database>>,
  classId: number
): Promise<
  Array<{
    id: number;
    slug: string;
    title: string;
    total_points: number | null;
    autograder_points: number | null;
    due_date: string;
    minutes_due_after_lab: number | null;
    template_repo: string | null;
    group_config: "individual" | "groups" | "both" | null;
    min_group_size: number | null;
    max_group_size: number | null;
    grader_repo: string | null;
    grader_commit_sha: string | null;
  }>
> {
  const { data, error } = await supabase
    .from("assignments")
    .select(
      "id, slug, title, total_points, autograder_points, due_date, minutes_due_after_lab, template_repo, group_config, min_group_size, max_group_size, autograder(grader_repo, grader_commit_sha)"
    )
    .eq("class_id", classId)
    .order("due_date", { ascending: true });
  if (error) throw new Error(`Failed to load assignments: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`Class ${classId} has no assignments`);
  return data.map((a) => {
    const ag = Array.isArray(a.autograder) ? a.autograder[0] : a.autograder;
    return {
      id: a.id,
      slug: a.slug ?? `assignment-${a.id}`,
      title: a.title,
      total_points: a.total_points,
      autograder_points: a.autograder_points,
      due_date: a.due_date,
      minutes_due_after_lab: a.minutes_due_after_lab,
      template_repo: a.template_repo,
      group_config: a.group_config as "individual" | "groups" | "both" | null,
      min_group_size: a.min_group_size as number | null,
      max_group_size: a.max_group_size as number | null,
      grader_repo: ag?.grader_repo ?? null,
      grader_commit_sha: ag?.grader_commit_sha ?? null
    };
  });
}

/**
 * Latest autograder commit sha per assignment. The `autograder.grader_commit_sha`
 * column is often null in practice — the source of truth for "what sha would the
 * grader run on right now" lives in autograder_commits. We pick the most recent
 * row per assignment regardless of ref so this works whether the class is on main
 * or a feature branch.
 */
async function loadLatestGraderCommits(
  supabase: ReturnType<typeof createAdminClient<Database>>,
  classId: number,
  assignmentIds: number[]
): Promise<Map<number, string>> {
  if (assignmentIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("autograder_commits")
    .select("autograder_id, sha, created_at")
    .eq("class_id", classId)
    .in("autograder_id", assignmentIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load autograder_commits: ${error.message}`);
  const latest = new Map<number, string>();
  for (const row of data ?? []) {
    if (!latest.has(row.autograder_id)) latest.set(row.autograder_id, row.sha);
  }
  return latest;
}

/**
 * Pull jon-bell's submissions for each assignment in the source class, joined with
 * their grader_result and grader_result_tests. Returned as a map keyed by
 * assignment_id, with submissions sorted ascending by ordinal so Phase C can pick
 * `[0]` for paws and `[len-1]` for ripley deterministically.
 */
async function loadSourceSubmissions(
  supabase: ReturnType<typeof createAdminClient<Database>>,
  classId: number,
  profileId: string,
  assignmentIds: number[]
): Promise<Map<number, SourceSubmissionSnapshot[]>> {
  const out = new Map<number, SourceSubmissionSnapshot[]>();
  if (assignmentIds.length === 0) return out;
  // Fetch submissions + grader_results in one shot, then the per-grader-result
  // tests in a second pass. Doing it as a deep nested supabase select trips
  // supabase-js's type inference (returns GenericStringError), and a two-step
  // query is easier to read besides.
  // Disambiguate the FK: grader_results has TWO references to submissions —
  // grader_results_submission_id_fkey (the result for THIS submission) and
  // grader_results_rerun_for_submission_id_fkey (a rerun pointing back at the
  // original). We want the former.
  const { data: subRows, error: subErr } = await supabase
    .from("submissions")
    .select(
      "id, assignment_id, sha, repository, ordinal, created_at, grader_results!grader_results_submission_id_fkey(id, score, max_score, lint_passed, lint_output, lint_output_format)"
    )
    .eq("class_id", classId)
    .eq("profile_id", profileId)
    .in("assignment_id", assignmentIds)
    .order("ordinal", { ascending: true });
  if (subErr) throw new Error(`Failed to load source submissions: ${subErr.message}`);

  type SubRow = {
    id: number;
    assignment_id: number;
    sha: string;
    repository: string | null;
    ordinal: number | null;
    created_at: string | null;
    grader_results:
      | {
          id: number;
          score: number | null;
          max_score: number | null;
          lint_passed: boolean | null;
          lint_output: string | null;
          lint_output_format: string | null;
        }
      | Array<{
          id: number;
          score: number | null;
          max_score: number | null;
          lint_passed: boolean | null;
          lint_output: string | null;
          lint_output_format: string | null;
        }>
      | null;
  };
  const subs = (subRows ?? []) as unknown as SubRow[];
  const graderResultIds = subs
    .map((s) => (Array.isArray(s.grader_results) ? s.grader_results[0]?.id : s.grader_results?.id))
    .filter((id): id is number => typeof id === "number");

  const testsByGraderResult = new Map<number, NonNullable<SourceSubmissionSnapshot["graderResultTests"]>>();
  if (graderResultIds.length > 0) {
    const { data: testRows, error: testErr } = await supabase
      .from("grader_result_tests")
      .select("grader_result_id, name, name_format, score, max_score, output, output_format, is_released, extra_data")
      .in("grader_result_id", graderResultIds);
    if (testErr) throw new Error(`Failed to load grader_result_tests: ${testErr.message}`);
    for (const t of testRows ?? []) {
      const arr = testsByGraderResult.get(t.grader_result_id) ?? [];
      arr.push({
        name: t.name,
        name_format: t.name_format ?? null,
        score: t.score ?? 0,
        max_score: t.max_score ?? 0,
        output: t.output ?? null,
        output_format: t.output_format ?? null,
        is_released: t.is_released ?? null,
        extra_data: t.extra_data ?? null
      });
      testsByGraderResult.set(t.grader_result_id, arr);
    }
  }

  for (const s of subs) {
    const gr = Array.isArray(s.grader_results) ? s.grader_results[0] : s.grader_results;
    const snap: SourceSubmissionSnapshot = {
      sha: s.sha,
      ordinal: s.ordinal,
      createdAt: s.created_at,
      repository: s.repository,
      graderResult: gr
        ? {
            score: gr.score ?? 0,
            max_score: gr.max_score ?? 0,
            lint_passed: gr.lint_passed ?? false,
            lint_output: gr.lint_output ?? null,
            lint_output_format: gr.lint_output_format ?? null
          }
        : null,
      graderResultTests: gr ? (testsByGraderResult.get(gr.id) ?? []) : []
    };
    const arr = out.get(s.assignment_id) ?? [];
    arr.push(snap);
    out.set(s.assignment_id, arr);
  }
  return out;
}

/** Repos for the source user across the class, both individual and group. */
async function loadUserRepos(
  supabase: ReturnType<typeof createAdminClient<Database>>,
  classId: number,
  userId: string,
  profileId: string
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();

  // Individual repos: repositories.profile_id == source user's private profile.
  const { data: indiv, error: indivErr } = await supabase
    .from("repositories")
    .select("assignment_id, repository, created_at")
    .eq("class_id", classId)
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true });
  if (indivErr) throw new Error(`Failed to load individual repos: ${indivErr.message}`);
  for (const r of indiv ?? []) {
    if (!r.repository) continue;
    const arr = out.get(r.assignment_id) ?? [];
    arr.push(r.repository);
    out.set(r.assignment_id, arr);
  }

  // Group repos: any assignment_group jon-bell is a member of → its repositories.
  const { data: groupMemberships, error: gmErr } = await supabase
    .from("assignment_groups_members")
    .select("assignment_id, assignment_groups(repositories(repository, created_at))")
    .eq("class_id", classId)
    .eq("user_roles.user_id", userId);
  if (gmErr) {
    // Non-fatal — if the schema relation doesn't match, just skip group repos.
    console.warn(`[warn] Group repo lookup failed (continuing without): ${gmErr.message}`);
  } else {
    for (const gm of groupMemberships ?? []) {
      const ag = gm.assignment_groups;
      const repos = Array.isArray(ag?.repositories) ? ag!.repositories : [];
      for (const r of repos) {
        if (!r.repository) continue;
        const arr = out.get(gm.assignment_id) ?? [];
        if (!arr.includes(r.repository)) arr.push(r.repository);
        out.set(gm.assignment_id, arr);
      }
    }
  }

  return out;
}

function computeWeeksFromStart(dueDate: string, earliest: Date): number {
  const due = new Date(dueDate).getTime();
  const weeks = Math.max(1, Math.round((due - earliest.getTime()) / ONE_WEEK_MS) + 1);
  return weeks;
}

function buildCannedAssignment(
  a: {
    id: number;
    slug: string;
    title: string;
    total_points: number | null;
    autograder_points: number | null;
    due_date: string;
    minutes_due_after_lab: number | null;
    template_repo: string | null;
    group_config: "individual" | "groups" | "both" | null;
    min_group_size: number | null;
    max_group_size: number | null;
    grader_repo: string | null;
    grader_commit_sha: string | null;
  },
  jonRepos: string[],
  sourceSubmissions: SourceSubmissionSnapshot[],
  earliest: Date
): CannedAssignment {
  const studentSubmissions: Partial<Record<RealFleetName, string>> = {};
  for (let i = 0; i < jonRepos.length && i < FLEET_ORDER.length; i++) {
    studentSubmissions[FLEET_ORDER[i]] = jonRepos[i];
  }
  const entry: CannedAssignment = {
    slug: a.slug,
    title: a.title,
    weeksFromStart: computeWeeksFromStart(a.due_date, earliest),
    isLab: a.minutes_due_after_lab !== null,
    points: a.total_points ?? 0,
    autograderPoints: a.autograder_points ?? 0,
    handoutRepo: a.template_repo ?? "",
    solutionRepo: a.grader_repo ?? "",
    graderCommitSha: a.grader_commit_sha ?? "",
    sourceAssignmentId: a.id
  };
  if (a.group_config && a.group_config !== "individual") {
    entry.groupConfig = a.group_config;
  }
  if (a.min_group_size != null) entry.minGroupSize = a.min_group_size;
  if (a.max_group_size != null) entry.maxGroupSize = a.max_group_size;
  if (jonRepos.length > 0) {
    entry.genericStudentSubmission = jonRepos[0];
    entry.studentSubmissions = studentSubmissions;
  }
  if (sourceSubmissions.length > 0) {
    entry.sourceSubmissions = sourceSubmissions;
  }
  return entry;
}

/** Every owner/repo a canned assignment points at (handout, solution, generic +
 * per-fleet student submissions, and each captured source submission's repo). */
function collectRepoRefs(entry: CannedAssignment): string[] {
  const refs: string[] = [];
  if (entry.handoutRepo) refs.push(entry.handoutRepo);
  if (entry.solutionRepo) refs.push(entry.solutionRepo);
  if (entry.genericStudentSubmission) refs.push(entry.genericStudentSubmission);
  for (const v of Object.values(entry.studentSubmissions ?? {})) if (v) refs.push(v);
  for (const s of entry.sourceSubmissions ?? []) if (s.repository) refs.push(s.repository);
  return refs;
}

/** Rewrite every repo reference on the entry through `remap` (source → demo-org copy). */
function remapRepoRefs(entry: CannedAssignment, remap: Map<string, string>): void {
  const map = (r: string | undefined | null) => (r && remap.get(r)) || r || undefined;
  if (entry.handoutRepo) entry.handoutRepo = map(entry.handoutRepo) ?? entry.handoutRepo;
  if (entry.solutionRepo) entry.solutionRepo = map(entry.solutionRepo) ?? entry.solutionRepo;
  if (entry.genericStudentSubmission) entry.genericStudentSubmission = map(entry.genericStudentSubmission);
  if (entry.studentSubmissions) {
    for (const k of Object.keys(entry.studentSubmissions) as RealFleetName[]) {
      const cur = entry.studentSubmissions[k];
      if (cur) entry.studentSubmissions[k] = map(cur) ?? cur;
    }
  }
  for (const s of entry.sourceSubmissions ?? []) {
    if (s.repository) s.repository = map(s.repository) ?? s.repository;
  }
}

/**
 * Mirror every source repo referenced by the canned entries into the demo org
 * (private), skipping any that already exist, then return a source→copy remap so
 * the manifest can be rewritten to point exclusively at demo-org repos. This is
 * what lets demo provisioning run without access to the source class's org.
 */
async function mirrorSourceReposToDemoOrg(canned: CannedAssignment[]): Promise<Map<string, string>> {
  const unique = [...new Set(canned.flatMap(collectRepoRefs))]
    // Only mirror repos that aren't already in the demo org.
    .filter((r) => r && !r.startsWith(`${DEMO_ORG}/`));
  const remap = new Map<string, string>();
  if (unique.length === 0) {
    console.log(`✓ No source repos to mirror (all already in ${DEMO_ORG})`);
    return remap;
  }
  console.log(`📦 Mirroring ${unique.length} source repos into ${DEMO_ORG} (private, skip-if-exists)…`);
  let created = 0;
  let reused = 0;
  const failures: string[] = [];
  await runWithConcurrency(
    unique.map((source) => async () => {
      try {
        const { target, created: didCreate } = await mirrorRepoToOrgIfMissing(source, DEMO_ORG, { private: true });
        remap.set(source, target);
        if (didCreate) created++;
        else reused++;
        console.log(`  ✓ ${source} → ${target} ${didCreate ? "(mirrored)" : "(exists)"}`);
      } catch (e) {
        failures.push(`${source}: ${(e as Error).message}`);
        console.warn(`  ⚠ ${source}: mirror failed — ${(e as Error).message}`);
      }
    }),
    MIRROR_CONCURRENCY
  );
  console.log(`📦 Mirror pass: ${created} created, ${reused} reused, ${failures.length} failed`);
  return remap;
}

async function main() {
  const args = parseArgs();
  const supabase = createAdminClient<Database>();

  console.log(
    `🔎 Refreshing manifest from class ${args.classId}, GitHub user ${args.githubUsername} → archetype "${args.archetype}"`
  );

  const { userId, profileId } = await resolveSourceProfileId(supabase, args.classId, args.githubUsername);
  console.log(`✓ Source profile: user_id=${userId} profile_id=${profileId}`);

  const assignments = await loadAssignments(supabase, args.classId);
  console.log(`✓ Loaded ${assignments.length} assignments`);

  const repoMap = await loadUserRepos(supabase, args.classId, userId, profileId);
  const totalRepos = [...repoMap.values()].reduce((s, r) => s + r.length, 0);
  console.log(`✓ Found ${totalRepos} ${args.githubUsername} repos across ${repoMap.size} assignments`);

  const latestShas = await loadLatestGraderCommits(
    supabase,
    args.classId,
    assignments.map((a) => a.id)
  );
  console.log(`✓ Resolved ${latestShas.size} latest grader commit shas from autograder_commits`);

  const sourceSubmissions = await loadSourceSubmissions(
    supabase,
    args.classId,
    profileId,
    assignments.map((a) => a.id)
  );
  const totalSourceSubs = [...sourceSubmissions.values()].reduce((s, arr) => s + arr.length, 0);
  console.log(
    `✓ Captured ${totalSourceSubs} ${args.githubUsername} submissions across ${sourceSubmissions.size} assignments`
  );

  const earliest = new Date(assignments[0].due_date);

  const canned: CannedAssignment[] = [];
  for (const a of assignments) {
    const repos = repoMap.get(a.id) ?? [];
    const subs = sourceSubmissions.get(a.id) ?? [];
    // autograder.grader_commit_sha is usually NULL — prefer the latest sha from
    // autograder_commits.
    const effectiveSha = a.grader_commit_sha ?? latestShas.get(a.id) ?? null;
    if (!a.template_repo) console.warn(`[warn] ${a.slug}: no template_repo in DB; handoutRepo left blank`);
    if (!effectiveSha)
      console.warn(`[warn] ${a.slug}: no grader commit sha (autograder + autograder_commits both empty); left blank`);
    if (subs.length === 0)
      console.warn(
        `[warn] ${a.slug}: no ${args.githubUsername} submissions in source class; Phase C will fall back to HEAD`
      );
    canned.push(buildCannedAssignment({ ...a, grader_commit_sha: effectiveSha }, repos, subs, earliest));
  }

  // Copy every referenced source repo into the demo org (private) so the manifest
  // points exclusively at repos the provisioning CLI can reach, then rewrite the
  // entries to the demo-org copies. Full `--mirror` preserves the submission SHAs
  // the manifest records. `--skip-repo-copy` keeps the raw source-org names.
  if (args.copyRepos) {
    const remap = await mirrorSourceReposToDemoOrg(canned);
    for (const entry of canned) remapRepoRefs(entry, remap);
  } else {
    console.log("⏭  --skip-repo-copy: leaving source-org repo names in the manifest");
  }

  // Load and surgically patch the manifest.
  const manifestRaw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(manifestRaw) as CannedRepoManifest;
  const existing: Partial<CannedArchetype> = manifest[args.archetype] ?? {};
  const next: CannedArchetype = {
    courseTitle: existing.courseTitle ?? `Class ${args.classId} (imported)`,
    description: existing.description,
    timeZone: existing.timeZone ?? "America/New_York",
    sourceClassId: args.classId,
    assignments: canned
  };
  manifest[args.archetype] = next;

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`✓ Wrote ${MANIFEST_PATH} (${canned.length} assignments under "${args.archetype}")`);

  const missingHandouts = canned.filter((c) => !c.handoutRepo).length;
  const missingSolutions = canned.filter((c) => !c.solutionRepo).length;
  const missingShas = canned.filter((c) => !c.graderCommitSha).length;
  if (missingHandouts || missingSolutions || missingShas) {
    console.log("");
    console.log(
      `⚠ ${missingHandouts} entries missing handoutRepo, ${missingSolutions} missing solutionRepo, ${missingShas} missing graderCommitSha`
    );
    console.log(
      "   Fill these in by hand (or wire pawtograder-playground repos for them) before running real-handouts."
    );
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ Init failed:", e);
    process.exit(1);
  });
}
