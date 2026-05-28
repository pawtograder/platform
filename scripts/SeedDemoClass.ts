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
 *       --archetype intro-cs-java \
 *       --instructor jane@school.edu \
 *       [--instructor co-teacher@school.edu] \
 *       [--class-name "CS 1500 — Demo for Jane"] \
 *       [--handout-strategy fake-repos|real-handouts|real-everything] \
 *       [--filler-students 27] \
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
import { ChatAnthropic } from "@langchain/anthropic"; // ensures @langchain/anthropic stays installed
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";

import { DatabaseSeeder, enrollExistingUserInClass } from "./DatabaseSeedingUtils";
import { ensureDemoFleet, type DemoFleet, type DemoFleetUser } from "./demo/DemoFleetManager";
import type { CannedArchetype, CannedRepoManifest, FixtureBundle, HandoutStrategy } from "./demo/fixtures.types";
import { assignmentCreateHandoutRepo, autograderCreateRepoForStudentDemo } from "@/lib/edgeFunctions";
import { TestingUser } from "@/tests/e2e/TestingUtils";
import { DEFAULT_RATE_LIMITS, RateLimitManager } from "@/tests/generator/GenerationUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Silence unused-import lint while keeping the dependency edge documented.
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
  fillerStudents: number;
  graders: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: CliArgs = {
    archetype: "",
    instructors: [],
    handoutStrategy: "real-handouts",
    fillerStudents: 27,
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
      case "--filler-students":
        out.fillerStudents = parseInt(next, 10);
        i++;
        break;
      case "--graders":
        out.graders = parseInt(next, 10);
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
  --filler-students <N>       Filler student count (default 27, plus 3 real fleet = 30 total)
  --graders <N>               Grader fleet size (default 4)
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
      // Mirror to public.users so RPCs that read it pick the row up.
      await supabase.from("users").insert({ user_id: userId, email, name }).single();
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

async function maybeCreateRealHandouts(
  classId: number,
  archetype: CannedArchetype,
  strategy: HandoutStrategy,
  fleet: DemoFleet
): Promise<void> {
  if (strategy === "fake-repos") {
    console.log("📦 Handout strategy: fake-repos — skipping GitHub repo creation");
    return;
  }
  // Fetch assignments by slug so we can route each create-handout-repo call.
  const { data: assignments, error } = await supabase.from("assignments").select("id, slug").eq("class_id", classId);
  if (error || !assignments) {
    throw new Error(`Failed to fetch assignments for handout repo creation: ${error?.message}`);
  }
  console.log(`📦 Creating real handout repos for ${assignments.length} assignments…`);
  for (const a of assignments) {
    const canned = archetype.assignments.find((c) => c.slug === a.slug);
    if (!canned) {
      console.warn(`⚠ No canned entry for slug=${a.slug}; skipping handout repo`);
      continue;
    }
    try {
      const result = await assignmentCreateHandoutRepo(
        {
          assignment_id: a.id,
          class_id: classId,
          template_repo_override: canned.handoutRepo
        },
        supabase
      );
      console.log(`  ✓ ${a.slug}: created ${result.org_name}/${result.repo_name}`);
    } catch (e) {
      console.warn(`  ⚠ ${a.slug}: handout repo creation failed — ${(e as Error).message}`);
    }
  }

  if (strategy !== "real-everything") return;

  // real-everything: for each assignment × real-fleet student, create the student's
  // individual repo seeded from the canned submission template. Filler students are
  // skipped here — they keep the inline sample.java path from batchCreateSubmissions.
  console.log(`👥 Creating real per-student repos for ${fleet.realStudents.length} real fleet members…`);
  for (const a of assignments) {
    const canned = archetype.assignments.find((c) => c.slug === a.slug);
    if (!canned) continue;
    for (const student of fleet.realStudents) {
      const override =
        (student.fleetName && canned.studentSubmissions?.[student.fleetName]) ?? canned.genericStudentSubmission;
      if (!override) {
        console.warn(`  ⚠ ${a.slug}/${student.fleetName}: no studentSubmission override; skipping`);
        continue;
      }
      try {
        await autograderCreateRepoForStudentDemo(
          {
            user_id: student.user_id,
            class_id: classId,
            assignment_id: a.id,
            template_repo_override: override
          },
          supabase
        );
        console.log(`  ✓ ${a.slug}/${student.fleetName}: repo seeded from ${override}`);
      } catch (e) {
        console.warn(`  ⚠ ${a.slug}/${student.fleetName}: failed — ${(e as Error).message}`);
      }
    }
  }
}

async function main() {
  const args = parseArgs();
  const manifest = loadManifest();
  const archetype = manifest[args.archetype];
  if (!archetype) {
    throw new Error(`Unknown archetype '${args.archetype}'. Available: ${Object.keys(manifest).join(", ")}`);
  }

  console.log(`🎬 Provisioning demo class: ${archetype.courseTitle}`);
  console.log(`   Handout strategy: ${args.handoutStrategy}`);
  console.log(`   Instructors: ${args.instructors.join(", ")}`);

  const fixtures = loadFixtures(args.archetype);
  console.log(
    `📚 Loaded fixtures: ${fixtures.discussions.length} discussions, ${fixtures.privatePosts.length} private posts, ${fixtures.helpRequests.length} help requests, ${fixtures.surveyFreeform.length} survey freeform`
  );

  const fleet = await ensureDemoFleet({ numFillerStudents: args.fillerStudents, numGraders: args.graders });
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
      students: [...fleet.realStudents, ...fleet.fillerStudents].map(toTestingUser)
    })
    .withPerAssignmentRepos(archetype.assignments)
    .withHandoutStrategy(args.handoutStrategy)
    .withDemoFixtures(fixtures)
    .withDemoFlag(true);
  if (archetype.sourceClassId) seeder.withSourceClassId(archetype.sourceClassId);
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
      linkToGroupAssignments: false,
      includeTeamCollaboration: true
    })
    .withDiscussions({ postsPerTopic: 0, maxRepliesPerPost: 0, numAdditionalTopics: 12 })
    .withHelpRequests({
      numHelpRequests: fixtures.helpRequests.length,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 8,
      maxMembersPerRequest: 3
    });

  await seeder.seed();

  // Look up the freshly created class so we can wire post-seed steps to it.
  const { data: latestClass } = await supabase
    .from("classes")
    .select("id, name")
    .eq("is_demo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!latestClass) {
    throw new Error("Could not locate the newly provisioned demo class");
  }
  console.log(`✓ Demo class ready: id=${latestClass.id} name="${latestClass.name}"`);

  // Demonstrate the use of enrollExistingUserInClass beyond seed() —
  // this is the same primitive the seeder uses; importing it here keeps
  // the dependency edge explicit for future "add another instructor" flows.
  void enrollExistingUserInClass;
  void new RateLimitManager(DEFAULT_RATE_LIMITS);

  await maybeCreateRealHandouts(latestClass.id, archetype, args.handoutStrategy, fleet);

  console.log("");
  console.log("🎉 Demo provisioning complete.");
  console.log(`   Log in as one of the demo instructors: ${args.instructors.join(", ")}`);
  console.log(`   Real-fleet student logins: ripley@ripley.cloud / orion@ripley.cloud / paws@ripley.cloud`);
  console.log(`   Filler students/graders: password 'change-it'`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ Demo provisioning failed:", e);
    process.exit(1);
  });
}
