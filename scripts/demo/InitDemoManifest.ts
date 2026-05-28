/* eslint-disable no-console */
/**
 * InitDemoManifest — refresh the intro-cs-java block in canned-repos.json from
 * a real source-of-truth class plus a real instructor's GitHub-linked submission
 * repos. Run this when the pawtograder-playground repos change or when you want
 * to re-pin grader commit SHAs.
 *
 * Inputs (all via flags, with sensible defaults for the current setup):
 *   --class-id <N>             Source class id (default 500)
 *   --github-username <name>   GitHub user whose submission repos seed ripley/orion/paws
 *                              (default jon-bell)
 *   --archetype <key>          Block to overwrite in canned-repos.json (default intro-cs-java)
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
import type { CannedArchetype, CannedAssignment, CannedRepoManifest, RealFleetName } from "./fixtures.types";

dotenv.config({ path: ".env.local", quiet: true });

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "demo", "canned-repos.json");

const FLEET_ORDER: RealFleetName[] = ["ripley", "orion", "paws"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CliArgs {
  classId: number;
  githubUsername: string;
  archetype: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: CliArgs = { classId: 500, githubUsername: "jon-bell", archetype: "intro-cs-java" };
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
      case "--help":
      case "-h":
        console.log(
          "Usage: npx tsx scripts/demo/InitDemoManifest.ts [--class-id 500] [--github-username jon-bell] [--archetype intro-cs-java]"
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
): Promise<Array<{
  id: number;
  slug: string;
  title: string;
  total_points: number | null;
  autograder_points: number | null;
  due_date: string;
  minutes_due_after_lab: number | null;
  template_repo: string | null;
  grader_repo: string | null;
  grader_commit_sha: string | null;
}>> {
  const { data, error } = await supabase
    .from("assignments")
    .select(
      "id, slug, title, total_points, autograder_points, due_date, minutes_due_after_lab, template_repo, autograder(grader_repo, grader_commit_sha)"
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
      grader_repo: ag?.grader_repo ?? null,
      grader_commit_sha: ag?.grader_commit_sha ?? null
    };
  });
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
    grader_repo: string | null;
    grader_commit_sha: string | null;
  },
  jonRepos: string[],
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
  if (jonRepos.length > 0) {
    entry.genericStudentSubmission = jonRepos[0];
    entry.studentSubmissions = studentSubmissions;
  }
  return entry;
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

  const earliest = new Date(assignments[0].due_date);

  const canned: CannedAssignment[] = [];
  for (const a of assignments) {
    const repos = repoMap.get(a.id) ?? [];
    if (!a.template_repo) console.warn(`[warn] ${a.slug}: no template_repo in DB; handoutRepo left blank`);
    if (!a.grader_commit_sha) console.warn(`[warn] ${a.slug}: no autograder.grader_commit_sha; left blank`);
    canned.push(buildCannedAssignment(a, repos, earliest));
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
    console.log("   Fill these in by hand (or wire pawtograder-playground repos for them) before running real-handouts.");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ Init failed:", e);
    process.exit(1);
  });
}
