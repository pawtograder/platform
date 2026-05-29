/* eslint-disable no-console */
/**
 * SeedDemoClass — CLI for site-admin demo provisioning.
 *
 * Spins up a believable demo class for a visiting instructor: real assignment
 * shapes pulled from scripts/demo/canned-repos.json, LLM-authored discussion
 * and help-request fixtures from scripts/demo/fixtures/<archetype>/, and a
 * fixed fleet of student/grader personas that lives across all demo classes.
 *
 * Usage:
 *   npm run seed:demo -- \
 *       --archetype program-design-and-implementation-ii \
 *       --instructor jane@school.edu \
 *       [--instructor co-teacher@school.edu] \
 *       [--class-name "CS 1500 — Demo for Jane"] \
 *       [--handout-strategy fake-repos|real-handouts|real-everything] \
 *       [--graders 4]
 *
 * Prerequisites:
 *   • local Supabase running with the schema migrated (see AGENTS.md)
 *   • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 *   • For --handout-strategy != fake-repos: the platform's GitHub App must
 *     be configured and the canned source repos (handout, solution, optional
 *     per-student-submission) must exist under pawtograder-playground.
 *   • The three real fleet users (ripley@ripley.cloud, orion@ripley.cloud,
 *     paws@ripley.cloud) must already exist — see DemoFleetManager.ts.
 */
// GenerateDemoFixtures (the LLM fixture author) imports @langchain/anthropic
// transitively; importing it here keeps the package in the dependency graph so
// `npm prune`/dead-import tooling can't drop it out from under that script.
import { ChatAnthropic } from "@langchain/anthropic";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";

import { DatabaseSeeder, enrollExistingUserInClass } from "./DatabaseSeedingUtils";
import { ensureDemoFleet, type DemoFleet, type DemoFleetUser } from "./demo/DemoFleetManager";
import type { CannedArchetype, CannedRepoManifest, FixtureBundle, HandoutStrategy } from "./demo/fixtures.types";
import { pushSourceContent, runWithConcurrency, waitForRepo } from "./demo/syncRepos";
import { assignmentCreateHandoutRepo, assignmentCreateSolutionRepo } from "@/lib/edgeFunctions";
import { TestingUser } from "@/tests/e2e/TestingUtils";
import { DEFAULT_RATE_LIMITS, RateLimitManager } from "@/tests/generator/GenerationUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Reference the otherwise-unused import so lint doesn't strip it; see the note
// at the import for why this transitive dependency edge must stay.
void ChatAnthropic;

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "demo", "canned-repos.json");
const FIXTURES_ROOT = path.join(ROOT, "scripts", "demo", "fixtures");

const supabase = createAdminClient<Database>();

interface CliArgs {
  archetype: string;
  instructors: string[];
  className?: string;
  handoutStrategy: HandoutStrategy;
  graders: number;
  /** When set, only the first N canned assignments are provisioned. Lets you
   * smoke-test the GitHub-touching paths (`real-handouts` / `real-everything`)
   * without waiting for every assignment to mirror. */
  maxAssignments?: number;
  /** Comma-separated assignment slugs to provision. When set, only canned
   * assignments whose slug is in the list are kept (in the order they appear in
   * the manifest, NOT the order they appear on the CLI). Combines with
   * --max-assignments: the slug filter is applied first, then truncated. */
  assignmentSlugs?: string[];
}

const MIRROR_CONCURRENCY = 5;

/**
 * Stub files written into a student/group repo when the chosen canned submission
 * contributes nothing (empty source, or its tree matches the handout exactly).
 * Without these the demo produces an empty submission, which the assignment
 * rejects (permit_empty_submissions=false). We include a couple of common
 * source-file extensions plus a notes file so the autograder's submissionFiles
 * globs are likely to match something regardless of the archetype's language.
 */
function demoFallbackFiles(slug: string): Array<{ path: string; content: string }> {
  const banner = `Demo placeholder submission for "${slug}". The source submission was empty,\nso these stub files were added to keep the submission non-empty.`;
  return [
    { path: "DEMO_SUBMISSION.md", content: `# Demo submission\n\n${banner}\n` },
    {
      path: "src/DemoSubmission.java",
      content: `// ${banner}\npublic class DemoSubmission {\n    public static void main(String[] args) {\n        System.out.println("demo placeholder");\n    }\n}\n`
    },
    {
      path: "demo_submission.py",
      content: `# ${banner}\n\ndef main():\n    print("demo placeholder")\n\n\nif __name__ == "__main__":\n    main()\n`
    }
  ];
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: CliArgs = {
    archetype: "",
    instructors: [],
    handoutStrategy: "real-handouts",
    graders: 4
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
      case "--archetype":
        if (!next) throw new Error("--archetype requires a value");
        out.archetype = next;
        i++;
        break;
      case "--instructor":
        if (!next) throw new Error("--instructor requires a value");
        out.instructors.push(next);
        i++;
        break;
      case "--class-name":
        out.className = next;
        i++;
        break;
      case "--handout-strategy":
        if (next !== "fake-repos" && next !== "real-handouts" && next !== "real-everything") {
          throw new Error(`--handout-strategy must be one of fake-repos|real-handouts|real-everything`);
        }
        out.handoutStrategy = next;
        i++;
        break;
      case "--graders":
        out.graders = parseInt(next, 10);
        i++;
        break;
      case "--max-assignments":
        if (!next) throw new Error("--max-assignments requires a value");
        out.maxAssignments = parseInt(next, 10);
        if (Number.isNaN(out.maxAssignments) || out.maxAssignments < 1) {
          throw new Error("--max-assignments must be a positive integer");
        }
        i++;
        break;
      case "--assignment-slugs":
        if (!next) throw new Error("--assignment-slugs requires a comma-separated value");
        out.assignmentSlugs = next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (out.assignmentSlugs.length === 0) {
          throw new Error("--assignment-slugs must list at least one slug");
        }
        i++;
        break;
      default:
        if (arg.startsWith("--")) {
          console.warn(`Unknown flag: ${arg}`);
        }
    }
  }
  if (!out.archetype) {
    showHelp();
    throw new Error("Missing required --archetype");
  }
  if (out.instructors.length === 0) {
    showHelp();
    throw new Error("Missing required --instructor (can be passed multiple times)");
  }
  return out;
}

function showHelp() {
  console.log(`
seed:demo — provision a demo class for a visiting instructor

Required:
  --archetype <name>          One of the archetypes in scripts/demo/canned-repos.json
  --instructor <email>        Instructor account to grant access to (can repeat)

Optional:
  --class-name <name>         Override the default class name (archetype's courseTitle)
  --handout-strategy <mode>   fake-repos | real-handouts | real-everything (default real-handouts)
  --graders <N>               Grader fleet size (default 4)
  --max-assignments <N>       Only provision the first N canned assignments (smoke-test shortcut)
  --assignment-slugs <a,b>    Comma-separated slugs to keep (applied before --max-assignments)
`);
}

function loadManifest(): CannedRepoManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  return JSON.parse(raw) as CannedRepoManifest;
}

function loadFixtures(archetype: string): FixtureBundle {
  const dir = path.join(FIXTURES_ROOT, archetype);
  if (!fs.existsSync(dir)) {
    throw new Error(`Fixture directory not found: ${dir}. Run scripts/demo/GenerateDemoFixtures.ts first.`);
  }
  const read = <T>(filename: string): T => {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing fixture file: ${p}`);
    }
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  };
  return {
    discussions: read("discussions.json"),
    privatePosts: read("private_posts.json"),
    helpRequests: read("help_requests.json"),
    surveyFreeform: read("survey_freeform.json")
  };
}

/** Convert a DemoFleetUser into the shape DatabaseSeeder.withSharedFleet expects. */
function toTestingUser(u: DemoFleetUser): TestingUser & { hasRealGitHub: boolean; fleetName?: string } {
  return {
    email: u.email,
    user_id: u.user_id,
    private_profile_name: u.private_profile_name,
    public_profile_name: u.public_profile_name,
    password: u.password,
    private_profile_id: "", // filled in by enrollExistingUserInClass
    public_profile_id: "",
    class_id: -1,
    hasRealGitHub: u.hasRealGitHub,
    fleetName: u.fleetName
  };
}

/**
 * Ensure each --instructor email maps to a TestingUser ready to enroll.
 * Looks up existing auth users by email; creates them if missing. Profiles
 * are created at enrollment time by enrollExistingUserInClass.
 */
async function ensureInstructorUsers(emails: string[]): Promise<TestingUser[]> {
  const out: TestingUser[] = [];
  for (const email of emails) {
    const { data: existing } = await supabase.from("users").select("user_id, name").eq("email", email).maybeSingle();
    let userId: string;
    let name: string;
    if (existing) {
      userId = existing.user_id;
      name = existing.name ?? email;
    } else {
      console.log(`Creating instructor auth user: ${email}`);
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);
      if (error || !data.user) {
        throw new Error(`Failed to invite instructor ${email}: ${error?.message ?? "unknown"}`);
      }
      userId = data.user.id;
      name = email;
      // Mirror to public.users so RPCs that read it pick the row up. Upsert
      // rather than insert: a DB trigger on auth.users may already have created
      // the public.users row, which would make a plain insert fail on the
      // user_id unique constraint.
      await supabase.from("users").upsert({ user_id: userId, email, name }, { onConflict: "user_id" });
    }
    out.push({
      email,
      user_id: userId,
      private_profile_name: name,
      public_profile_name: name,
      password: process.env.TEST_PASSWORD || "change-it",
      private_profile_id: "",
      public_profile_id: "",
      class_id: -1
    });
  }
  return out;
}

/**
 * PHASE A — runs in `withOnAfterAssignmentsCreated`. For each assignment:
 *   1. Invoke the platform's `assignment-create-handout-repo` edge function. The
 *      platform creates an empty repo from its default template and writes
 *      `assignments.template_repo` itself.
 *   2. Wait for the new GitHub repo to be visible, then clone it, overlay the
 *      canned source handout content on top, and push a normal commit.
 *   3. Same for `assignment-create-solution-repo` + `autograder.grader_repo`.
 *
 * `release_date` is still in the future (seeder withFutureReleaseDate=true), so
 * `check_assignment_for_repo_creation` has NOT fanned out per-student repos yet.
 */
async function phaseA_createAndPushHandoutsAndSolutions(
  classId: number,
  archetype: CannedArchetype,
  strategy: HandoutStrategy,
  fleet: DemoFleet
): Promise<void> {
  if (strategy === "fake-repos") {
    console.log(`📦 strategy=fake-repos — skipping Phase A`);
    return;
  }
  console.log(`📦 Phase A: creating handout + solution repos via platform edge functions…`);

  // The real fleet is already in the demo GitHub org, but the platform doesn't
  // know that until autograder-create-repos-for-student probes the org. Mark
  // their user_roles.github_org_confirmed=true up front so the Phase-B trigger
  // (assignment-create-all-repos) actually fans out per-student repos for them.
  // Without this, the platform silently skips ripley/orion/paws (see
  // assignment-create-all-repos/index.ts:318,323).
  const fleetUserIds = fleet.realStudents.map((s) => s.user_id);
  if (fleetUserIds.length > 0) {
    const { error: confirmErr, count } = await supabase
      .from("user_roles")
      .update({ github_org_confirmed: true }, { count: "exact" })
      .eq("class_id", classId)
      .in("user_id", fleetUserIds);
    if (confirmErr) {
      console.warn(`   ⚠ Failed to set github_org_confirmed for fleet: ${confirmErr.message}`);
    } else {
      console.log(`   ✓ Marked github_org_confirmed=true on ${count ?? "?"} fleet user_roles rows`);
    }
  }

  // Build a {slug → {assignmentId, canned, demoHandout, demoSolution}} map by joining
  // canned manifest against the freshly inserted assignments rows.
  const { data: dbAssignments, error: aErr } = await supabase
    .from("assignments")
    .select("id, slug")
    .eq("class_id", classId);
  if (aErr || !dbAssignments) throw new Error(`Failed to fetch assignments: ${aErr?.message}`);

  type Plan = { assignmentId: number; canned: CannedArchetype["assignments"][number] };
  const plans: Plan[] = [];
  for (const a of dbAssignments) {
    const canned = archetype.assignments.find((c) => c.slug === a.slug);
    if (!canned) {
      console.warn(`  ⚠ ${a.slug}: no canned entry; skipping`);
      continue;
    }
    plans.push({ assignmentId: a.id, canned });
  }

  // 1. Ask the platform to create each handout + solution. This writes
  //    assignments.template_repo / autograder.grader_repo as a side-effect.
  //    NOTE: the edge function often returns 500 from a post-create step
  //    (updateAutograderWorkflowHash trying to read grade.yml that isn't there
  //    yet, syncRepoPermissions when the team doesn't exist yet, etc.). The
  //    GitHub repo and the template_repo / grader_repo column update both
  //    happen BEFORE those late steps, so we treat the 500 as a soft failure
  //    and let the re-fetch below tell us whether we have a push target.
  console.log(`   • invoking assignment-create-handout-repo / -solution-repo for ${plans.length} assignments`);
  for (const { assignmentId, canned } of plans) {
    try {
      const handout = await assignmentCreateHandoutRepo({ assignment_id: assignmentId, class_id: classId }, supabase);
      console.log(`     ✓ ${canned.slug} handout: ${handout.org_name}/${handout.repo_name}`);
    } catch (e) {
      console.warn(`     ⚠ ${canned.slug} handout edge-fn errored (repo may still exist): ${(e as Error).message}`);
    }
    try {
      const solution = await assignmentCreateSolutionRepo({ assignment_id: assignmentId, class_id: classId }, supabase);
      console.log(`     ✓ ${canned.slug} solution: ${solution.org_name}/${solution.repo_name}`);
    } catch (e) {
      console.warn(`     ⚠ ${canned.slug} solution edge-fn errored (repo may still exist): ${(e as Error).message}`);
    }
  }

  // 2. Re-fetch template_repo / grader_repo so we know where to push content.
  const { data: enriched, error: enrichErr } = await supabase
    .from("assignments")
    .select("id, slug, template_repo, autograder(grader_repo)")
    .eq("class_id", classId);
  if (enrichErr || !enriched) throw new Error(`Failed to re-fetch assignments after creation: ${enrichErr?.message}`);

  // 3. Push canned source content into each newly-created repo, up to MIRROR_CONCURRENCY in flight.
  const tasks: Array<() => Promise<void>> = [];
  for (const a of enriched) {
    const canned = archetype.assignments.find((c) => c.slug === a.slug);
    if (!canned) continue;
    const ag = Array.isArray(a.autograder) ? a.autograder[0] : a.autograder;

    if (canned.handoutRepo && a.template_repo) {
      const source = canned.handoutRepo;
      const target = a.template_repo;
      tasks.push(async () => {
        try {
          const { noChanges, headSha } = await pushSourceContent(source, target, {
            commitMessage: `Seed demo handout for ${canned.slug} from ${source}`
          });
          console.log(
            `     ✓ ${canned.slug} handout content pushed → ${target} ${noChanges ? "(no-op)" : `@ ${headSha.slice(0, 7)}`}`
          );
        } catch (e) {
          console.warn(`     ⚠ ${canned.slug} handout push failed: ${(e as Error).message}`);
        }
      });
    }

    if (canned.solutionRepo && ag?.grader_repo) {
      const source = canned.solutionRepo;
      const target = ag.grader_repo;
      tasks.push(async () => {
        try {
          const { noChanges, headSha } = await pushSourceContent(source, target, {
            commitMessage: `Seed demo solution for ${canned.slug} from ${source}`
          });
          console.log(
            `     ✓ ${canned.slug} solution content pushed → ${target} ${noChanges ? "(no-op)" : `@ ${headSha.slice(0, 7)}`}`
          );
        } catch (e) {
          console.warn(`     ⚠ ${canned.slug} solution push failed: ${(e as Error).message}`);
        }
      });
    }
  }
  console.log(`   • pushing source content into ${tasks.length} repos (concurrency ${MIRROR_CONCURRENCY})`);
  if (tasks.length > 0) await runWithConcurrency(tasks, MIRROR_CONCURRENCY);
  console.log(`📦 Phase A complete`);
}

/**
 * PHASE B — flip release_date from future to past. The platform's
 * `check_assignment_for_repo_creation` trigger fires per row and calls
 * `create_all_repos_for_assignment` → `assignment-create-all-repos`, which fans
 * out per-student GitHub repos asynchronously. We then poll `repositories` for
 * those rows to materialize.
 *
 * PHASE C — for each platform-created student `repositories` row, choose the
 * canned source (per-fleet override if the student is ripley/orion/paws, else
 * the assignment's genericStudentSubmission), then clone the platform-created
 * repo, overlay source files, commit, push.
 */
async function phaseBC_releaseAndPushStudentRepos(
  classId: number,
  archetype: CannedArchetype,
  strategy: HandoutStrategy,
  fleet: DemoFleet
): Promise<void> {
  if (strategy !== "real-everything") return;
  console.log(`📦 Phase B+C: releasing assignments and pushing student-repo content (class_id=${classId})`);

  // ---- Phase B: flip release_date to past ----------------------------------
  const releaseDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago, safely past the trigger's 1-min check
  const { data: dbAssignments, error: aErr } = await supabase
    .from("assignments")
    .select("id, slug, group_config")
    .eq("class_id", classId);
  if (aErr || !dbAssignments) throw new Error(`Failed to fetch assignments: ${aErr?.message}`);

  console.log(`   • flipping release_date to past on ${dbAssignments.length} assignments`);
  for (const a of dbAssignments) {
    const { error: upErr } = await supabase.from("assignments").update({ release_date: releaseDate }).eq("id", a.id);
    if (upErr) console.warn(`     ⚠ ${a.slug}: update release_date failed: ${upErr.message}`);
  }

  // fleet private_profile_id → persona, for individual assignments + grading.
  const realFleetProfileToUser = new Map<string, DemoFleetUser>();
  for (const s of fleet.realStudents) {
    const { data: ur } = await supabase
      .from("user_roles")
      .select("private_profile_id")
      .eq("user_id", s.user_id)
      .eq("class_id", classId)
      .maybeSingle();
    if (ur?.private_profile_id) realFleetProfileToUser.set(ur.private_profile_id, s);
  }
  const fleetUserIds = fleet.realStudents.map((s) => s.user_id);

  // ---- Build the expected repo targets (GROUP-AWARE) -----------------------
  // A group assignment produces ONE platform repo per group (repositories row
  // with assignment_group_id set, profile_id null), NOT one per student. An
  // individual assignment produces one repo per enrolled fleet student. The
  // poll/push/submission-wait below all key off this target list so we don't
  // wait for per-student repos that the platform will never create for a group
  // assignment.
  type RepoTarget =
    | { kind: "individual"; assignmentId: number; slug: string; profileId: string; fleet?: DemoFleetUser }
    | { kind: "group"; assignmentId: number; slug: string; groupId: number; groupName: string };
  const targets: RepoTarget[] = [];
  for (const a of dbAssignments) {
    if (!a.slug) continue; // every seeded assignment has a slug; skip the impossible null
    const isGroup = a.group_config === "groups" || a.group_config === "both";
    if (isGroup) {
      const { data: groups, error: gErr } = await supabase
        .from("assignment_groups")
        .select("id, name")
        .eq("assignment_id", a.id)
        .eq("class_id", classId);
      if (gErr) throw new Error(`fetch assignment_groups for ${a.slug}: ${gErr.message}`);
      for (const g of groups ?? []) {
        targets.push({ kind: "group", assignmentId: a.id, slug: a.slug, groupId: g.id, groupName: g.name });
      }
    } else {
      for (const [profileId, fleetUser] of realFleetProfileToUser) {
        targets.push({ kind: "individual", assignmentId: a.id, slug: a.slug, profileId, fleet: fleetUser });
      }
    }
  }
  const expected = targets.length;
  const groupCount = targets.filter((t) => t.kind === "group").length;
  console.log(
    `   • waiting for ${expected} repo targets to become is_github_ready (${expected - groupCount} individual + ${groupCount} group)…`
  );

  // Self-heal: assignment-create-all-repos sets a group repo is_github_ready=false
  // when no member is github_org_confirmed. The fleet IS in the org, so re-assert
  // the flag each poll iteration in case a trigger reset it to the enroll default.
  const reassertConfirmed = async () => {
    if (fleetUserIds.length === 0) return;
    await supabase
      .from("user_roles")
      .update({ github_org_confirmed: true })
      .eq("class_id", classId)
      .in("user_id", fleetUserIds);
  };

  // Count targets whose repository row exists AND is_github_ready=true.
  const countReady = (
    rows: Array<{ assignment_id: number | null; profile_id: string | null; assignment_group_id: number | null }>
  ): number =>
    targets.filter((t) =>
      t.kind === "group"
        ? rows.some((r) => r.assignment_group_id === t.groupId)
        : rows.some((r) => r.assignment_id === t.assignmentId && r.profile_id === t.profileId)
    ).length;

  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  while (true) {
    await reassertConfirmed();
    const { data: rows, error: countErr } = await supabase
      .from("repositories")
      .select("assignment_id, profile_id, assignment_group_id, is_github_ready")
      .eq("class_id", classId)
      .eq("is_github_ready", true);
    if (countErr) throw new Error(`poll repositories count failed: ${countErr.message}`);
    const got = countReady(rows ?? []);
    process.stdout.write(
      `     [${Math.floor((Date.now() - pollStart) / 1000)}s] ${got} / ${expected} (is_github_ready)\r`
    );
    if (got >= expected) {
      console.log(`\n   ✓ ${got} repo targets marked is_github_ready=true`);
      break;
    }
    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      console.warn(`\n   ⚠ Timed out after ${POLL_TIMEOUT_MS / 1000}s — proceeding with what we have (${got})`);
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // ---- Phase C: push canned source content into each target repo -----------
  const { data: allRepos, error: rErr } = await supabase
    .from("repositories")
    .select("id, repository, assignment_id, profile_id, assignment_group_id")
    .eq("class_id", classId);
  if (rErr || !allRepos) throw new Error(`fetch repositories: ${rErr?.message}`);

  // Pick the canned source repo + (optional) historical sha for a given fleet
  // persona. jon-bell's captured submissions are sorted ascending by ordinal:
  // paws → earliest, orion → middle, ripley → newest. Group repos use the
  // "ripley" (newest) slot as the group's single submission.
  const FLEET_SUBMISSION_INDEX: Record<"ripley" | "orion" | "paws", (n: number) => number> = {
    paws: () => 0,
    orion: (n) => Math.floor((n - 1) / 2),
    ripley: (n) => n - 1
  };
  const pickSource = (
    canned: CannedArchetype["assignments"][number],
    fleetName: "ripley" | "orion" | "paws" | undefined
  ): { source?: string; sourceRef?: string; label: string } => {
    const source = (fleetName && canned.studentSubmissions?.[fleetName]) ?? canned.genericStudentSubmission;
    const subs = canned.sourceSubmissions ?? [];
    if (subs.length > 0 && fleetName && fleetName in FLEET_SUBMISSION_INDEX) {
      const idx = FLEET_SUBMISSION_INDEX[fleetName](subs.length);
      const chosen = subs[Math.max(0, Math.min(idx, subs.length - 1))];
      return { source, sourceRef: chosen.sha, label: `${chosen.sha.slice(0, 7)} (ordinal ${chosen.ordinal ?? "?"})` };
    }
    return { source, label: "HEAD" };
  };

  const tasks: Array<() => Promise<void>> = [];
  for (const t of targets) {
    const canned = archetype.assignments.find((c) => c.slug === t.slug);
    if (!canned) continue;

    let repoRow: (typeof allRepos)[number] | undefined;
    let who: string;
    let fleetName: "ripley" | "orion" | "paws" | undefined;
    if (t.kind === "group") {
      repoRow = allRepos.find((r) => r.assignment_group_id === t.groupId);
      who = `group ${t.groupName}`;
      fleetName = "ripley"; // group submission = the newest/representative submission
    } else {
      repoRow = allRepos.find((r) => r.assignment_id === t.assignmentId && r.profile_id === t.profileId);
      who = t.fleet?.fleetName ?? `profile:${t.profileId.slice(0, 8)}`;
      fleetName = t.fleet?.fleetName as "ripley" | "orion" | "paws" | undefined;
    }
    if (!repoRow?.repository) {
      console.warn(`  ⚠ ${t.slug}/${who}: no repository row found; skipping`);
      continue;
    }
    const { source, sourceRef, label } = pickSource(canned, fleetName);
    // No canned source for this target (common for group assignments where the
    // init script captured no jon-bell repo): push fallback stub files only, so a
    // non-empty submission still lands instead of skipping the target entirely.
    const effectiveSource = source ?? null;
    const effectiveLabel = source ? label : "fallback-only";
    const target = repoRow.repository;
    tasks.push(async () => {
      try {
        await waitForRepo(target);
        // #submit triggers the platform's grade.yml webhook (github-repo-webhook:432);
        // without it the push records a commit but never creates a submission row.
        const { noChanges, headSha, usedFallback } = await pushSourceContent(effectiveSource, target, {
          commitMessage: `Demo submission for ${t.slug}${source ? ` from ${source}` : " (fallback stub)"}`,
          sourceRef,
          fallbackFiles: demoFallbackFiles(t.slug)
        });
        const note = noChanges
          ? "(no-op — STILL EMPTY)"
          : usedFallback
            ? `→ ${headSha.slice(0, 7)} (fallback files)`
            : `→ ${headSha.slice(0, 7)}`;
        console.log(`     ✓ ${t.slug}/${who}: ${target} ← ${effectiveLabel} ${note}`);
      } catch (e) {
        console.warn(`     ⚠ ${t.slug}/${who} push failed: ${(e as Error).message}`);
      }
    });
  }
  console.log(`   • pushing source content into ${tasks.length} repos (concurrency ${MIRROR_CONCURRENCY})`);
  if (tasks.length > 0) await runWithConcurrency(tasks, MIRROR_CONCURRENCY);

  // ---- Phase D: wait for submissions to land, THEN open for grading --------
  // One submission per target (group submissions carry assignment_group_id, not
  // profile_id), so count by target the same way we counted ready repos.
  const countSubs = (
    rows: Array<{ assignment_id: number | null; profile_id: string | null; assignment_group_id: number | null }>
  ): number =>
    targets.filter((t) =>
      t.kind === "group"
        ? rows.some((s) => s.assignment_group_id === t.groupId)
        : rows.some((s) => s.assignment_id === t.assignmentId && s.profile_id === t.profileId)
    ).length;

  console.log(`📦 Phase D: waiting for ${expected} submissions to materialize before opening for grading…`);
  const subPollStart = Date.now();
  const SUB_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  while (true) {
    const { data: subRows, error: subErr } = await supabase
      .from("submissions")
      .select("id, profile_id, assignment_id, assignment_group_id")
      .eq("class_id", classId);
    if (subErr) throw new Error(`poll submissions failed: ${subErr.message}`);
    const got = countSubs(subRows ?? []);
    process.stdout.write(`     [${Math.floor((Date.now() - subPollStart) / 1000)}s] ${got} / ${expected}\r`);
    if (got >= expected) {
      console.log(`\n   ✓ ${got} submissions present`);
      break;
    }
    if (Date.now() - subPollStart > SUB_POLL_TIMEOUT_MS) {
      console.warn(`\n   ⚠ Timed out after ${SUB_POLL_TIMEOUT_MS / 1000}s — proceeding with ${got} of ${expected}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // Flip due_date (+ group_formation_deadline) to the past. Hand-grading UI
  // unlocks immediately on this update.
  const dueDatePast = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const groupDeadlinePast = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 1w ago
  console.log(`   • flipping due_date → 1h ago, group_formation_deadline → 1w ago`);
  const { error: dueErr, count: dueCount } = await supabase
    .from("assignments")
    .update({ due_date: dueDatePast, group_formation_deadline: groupDeadlinePast }, { count: "exact" })
    .eq("class_id", classId);
  if (dueErr) {
    console.warn(`   ⚠ Failed to flip due_date: ${dueErr.message}`);
  } else {
    console.log(`   ✓ Opened ${dueCount ?? "?"} assignments for grading`);
  }

  console.log(`📦 Phase B+C+D complete`);
}

async function main() {
  const args = parseArgs();
  const manifest = loadManifest();
  const fullArchetype = manifest[args.archetype];
  if (!fullArchetype) {
    throw new Error(`Unknown archetype '${args.archetype}'. Available: ${Object.keys(manifest).join(", ")}`);
  }

  // --assignment-slugs filters first, then --max-assignments truncates. The
  // resulting list is what the seeder, rubric copy, fixture wiring, and repo
  // mirror all operate on.
  let filteredAssignments = fullArchetype.assignments;
  if (args.assignmentSlugs && args.assignmentSlugs.length > 0) {
    const wanted = new Set(args.assignmentSlugs);
    filteredAssignments = fullArchetype.assignments.filter((a) => wanted.has(a.slug));
    const found = filteredAssignments.map((a) => a.slug);
    const missing = args.assignmentSlugs.filter((s) => !found.includes(s));
    if (missing.length > 0) {
      console.warn(`   ⚠ --assignment-slugs: ${missing.length} slug(s) not in manifest: ${missing.join(", ")}`);
    }
    if (filteredAssignments.length === 0) {
      throw new Error(`--assignment-slugs matched 0 canned assignments. Wanted: ${args.assignmentSlugs.join(", ")}`);
    }
  }
  if (args.maxAssignments !== undefined && args.maxAssignments < filteredAssignments.length) {
    filteredAssignments = filteredAssignments.slice(0, args.maxAssignments);
  }
  const archetype: CannedArchetype =
    filteredAssignments.length !== fullArchetype.assignments.length
      ? { ...fullArchetype, assignments: filteredAssignments }
      : fullArchetype;

  console.log(`🎬 Provisioning demo class: ${archetype.courseTitle}`);
  console.log(`   Handout strategy: ${args.handoutStrategy}`);
  console.log(`   Instructors: ${args.instructors.join(", ")}`);
  if (filteredAssignments.length !== fullArchetype.assignments.length) {
    const flagSummary = [
      args.assignmentSlugs ? `--assignment-slugs ${args.assignmentSlugs.join(",")}` : null,
      args.maxAssignments !== undefined ? `--max-assignments ${args.maxAssignments}` : null
    ]
      .filter(Boolean)
      .join(" + ");
    console.log(
      `   ${flagSummary} → provisioning ${archetype.assignments.length} of ${fullArchetype.assignments.length} canned assignments (${archetype.assignments.map((a) => a.slug).join(", ")})`
    );
  }

  const fixtures = loadFixtures(args.archetype);
  console.log(
    `📚 Loaded fixtures: ${fixtures.discussions.length} discussions, ${fixtures.privatePosts.length} private posts, ${fixtures.helpRequests.length} help requests, ${fixtures.surveyFreeform.length} survey freeform`
  );

  const fleet = await ensureDemoFleet({ numGraders: args.graders });
  const instructors = await ensureInstructorUsers(args.instructors);

  // Build the seeder. We piggyback on DatabaseSeeder.seed() for everything
  // except the canned per-assignment overrides + the demo fixtures.
  const seeder = new DatabaseSeeder();
  const className = args.className ?? archetype.courseTitle;
  seeder
    .withClassName(className)
    .withSharedFleet({
      instructors,
      graders: fleet.graders.map(toTestingUser),
      students: fleet.realStudents.map(toTestingUser)
    })
    .withPerAssignmentRepos(archetype.assignments)
    .withHandoutStrategy(args.handoutStrategy)
    .withDemoFixtures(fixtures)
    // demo- (not e2e-ignore-) so the slug — which gets baked into every mirrored
    // repo name AND any trigger-created student repo at user-enroll time —
    // doesn't carry the cleanup marker. Must be set before .seed().
    .withClassSlugPrefix("demo-");
  if (archetype.sourceClassId) seeder.withSourceClassId(archetype.sourceClassId);

  // For real-everything we let pawtograder's own async workflow own every repo
  // creation. The orchestrator:
  //   1. assignments are inserted with release_date = now+30d so the
  //      check_assignment_for_repo_creation trigger doesn't fan out student
  //      repos before we've staged the handouts (withFutureReleaseDate).
  //   2. Phase A (onAfterAssignmentsCreated) calls assignment-create-handout-repo /
  //      -solution-repo via the platform, then pushes canned source content into
  //      the empty repos with a normal commit (no force-push).
  //   3. Phase B (onAfterSubmissions) flips release_date → past, which triggers
  //      assignment-create-all-repos to materialize per-student repos. We poll
  //      until those rows appear.
  //   4. Phase C overlays per-fleet (ripley/orion/paws → studentSubmissions[name])
  //      or generic (everyone else → genericStudentSubmission) content into each
  //      newly-created student repo and commits.
  // The seeder skips its fake-repo submissions loop entirely (withSkipSubmissions)
  // so the real submissions land via the platform's webhook on each Phase-C push.
  if (args.handoutStrategy === "real-everything") {
    seeder.withFutureReleaseDate(true).withSkipSubmissions(true);
    seeder.withOnAfterAssignmentsCreated(async ({ classId }) => {
      await phaseA_createAndPushHandoutsAndSolutions(classId, archetype, args.handoutStrategy, fleet);
    });
    seeder.withOnAfterSubmissions(async (classId) => {
      await phaseBC_releaseAndPushStudentRepos(classId, archetype, args.handoutStrategy, fleet);
      // Phase E: hand-grading marks + regrades on the platform-created real
      // submissions. The seeder's protected gradeSubmissions / createExtensions…
      // run inside the new public wrapper, so the demo gets the same rubric
      // coverage + extension/regrade noise as the canned test path.
      console.log(`\n📊 Phase E: hand-grading + regrades on platform-created submissions`);
      await seeder.gradeRealSubmissionsForDemo(classId);
      console.log(`📊 Phase E complete`);
    });
  } else if (args.handoutStrategy === "real-handouts") {
    seeder.withFutureReleaseDate(true);
    seeder.withOnAfterAssignmentsCreated(async ({ classId }) => {
      await phaseA_createAndPushHandoutsAndSolutions(classId, archetype, args.handoutStrategy, fleet);
    });
  }
  seeder
    .withGradingScheme("specification")
    .withAssignmentDateRange(new Date(), new Date()) // values ignored when perAssignmentRepos is set
    .withRubricConfig({
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 3,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    })
    .withSectionsAndTags({ numClassSections: 2, numLabSections: 2, numStudentTags: 2, numGraderTags: 2 })
    .withLabAssignments({ numLabAssignments: 0, minutesDueAfterLab: 60 })
    .withGroupAssignments({ numGroupAssignments: 0, numLabGroupAssignments: 0 })
    .withManualGradedColumns(3)
    .withSurveys({
      numSurveys: 5,
      numTemplates: 3,
      responseRate: 0.8,
      submissionRate: 0.85,
      // Link the TCRS to the demo's group assignments (copied from the source
      // class) so its analytics GROUP view is populated — group analytics need
      // group-linked responses. The seeder's linked path creates the TCRS series
      // + per-group surveys with the canonical analytics config.
      linkToGroupAssignments: true,
      includeTeamCollaboration: true
    })
    .withDiscussions({ postsPerTopic: 0, maxRepliesPerPost: 0, numAdditionalTopics: 12 })
    .withHelpRequests({
      numHelpRequests: fixtures.helpRequests.length,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 8,
      maxMembersPerRequest: 3
    });

  const latestClass = await seeder.seed();
  console.log(`✓ Demo class ready: id=${latestClass.id} name="${latestClass.name}"`);

  // The slug rewrite and mirror pass run INSIDE the seeder via
  // withOnAfterSubmissions, so by the time we get here grading already used the
  // mirrored content. Nothing left to do but report.
  void enrollExistingUserInClass;
  void new RateLimitManager(DEFAULT_RATE_LIMITS);

  console.log("");
  console.log("🎉 Demo provisioning complete.");
  console.log(`   Log in as one of the demo instructors: ${args.instructors.join(", ")}`);
  console.log(`   Real-fleet student logins: ripley@ripley.cloud / orion@ripley.cloud / paws@ripley.cloud`);
  console.log(`   Demo graders: password 'change-it'`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ Demo provisioning failed:", e);
    process.exit(1);
  });
}
