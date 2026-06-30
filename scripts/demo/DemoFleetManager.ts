/* eslint-disable no-console */
/**
 * DemoFleetManager — ensures the shared pool of demo users exists, returns
 * them in a form ready to enroll into a freshly provisioned demo class.
 *
 * Three tiers:
 *  - Real fleet (Ripley / Orion / Paws) — fixed emails, already exist and are
 *    linked to real GitHub accounts. We refuse to bootstrap these silently.
 *  - (filler tier removed — every student in a demo class is a real-fleet member)
 *  - Grader fleet — stable synthetic emails, created if missing. DB-only.
 *
 * The returned objects match the TestingUser shape from tests/e2e/TestingUtils
 * but carry no class_id (set when enrolled by enrollExistingUserInClass).
 * `hasRealGitHub` is true only for the three real personas.
 */
import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";

export interface DemoFleetUser {
  email: string;
  user_id: string;
  /** Stable display name used in the class's private profile. */
  private_profile_name: string;
  /** Pseudonym used for the class's public profile. */
  public_profile_name: string;
  password: string;
  role: "student" | "grader";
  /** True only for ripley/orion/paws — they have real GitHub identities and
   * can be the targets of real per-student repo provisioning. */
  hasRealGitHub: boolean;
  /** Stable short name used to look up per-student-submission repos in
   * canned-repos.json. Only set for the real fleet. */
  fleetName?: "ripley" | "orion" | "paws";
}

export interface DemoFleet {
  realStudents: DemoFleetUser[];
  graders: DemoFleetUser[];
}

/** Real-fleet personas — must already exist (linked to GitHub). */
const REAL_FLEET: ReadonlyArray<{
  email: string;
  fleetName: "ripley" | "orion" | "paws";
  private_profile_name: string;
  public_profile_name: string;
}> = [
  {
    email: "ripley@ripley.cloud",
    fleetName: "ripley",
    private_profile_name: "Ripley",
    public_profile_name: "demo-falcon-77"
  },
  {
    email: "orion@ripley.cloud",
    fleetName: "orion",
    private_profile_name: "Orion",
    public_profile_name: "demo-sparrow-42"
  },
  {
    email: "paws@ripley.cloud",
    fleetName: "paws",
    private_profile_name: "Paws",
    public_profile_name: "demo-hawk-13"
  }
];

const GRADER_NAMES: ReadonlyArray<{ private: string; public: string }> = [
  { private: "Grader Sam", public: "demo-grader-aurora" },
  { private: "Grader Jordan", public: "demo-grader-borealis" },
  { private: "Grader Casey", public: "demo-grader-comet" },
  { private: "Grader Robin", public: "demo-grader-meteor" }
];

const DEFAULT_PASSWORD = process.env.TEST_PASSWORD || "change-it";

const supabase = createAdminClient<Database>();

async function lookupUserIdByEmail(email: string): Promise<string | null> {
  // Try the public mirror first (cheap).
  const { data: row } = await supabase.from("users").select("user_id").eq("email", email).maybeSingle();
  if (row?.user_id) return row.user_id;

  // Fall back to scanning auth admin pages — only used the first time a
  // filler user is created in this database.
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
    page++;
  }
}

async function ensureSyntheticUser(email: string, password: string): Promise<string> {
  const existing = await lookupUserIdByEmail(email);
  if (existing) return existing;

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (error || !data.user) {
    throw new Error(`Failed to create demo fleet user ${email}: ${error?.message ?? "unknown"}`);
  }
  return data.user.id;
}

/**
 * Look up all three real-fleet users. If any are missing, fail loudly with
 * actionable instructions — silently provisioning an unlinked auth row would
 * defeat the point (these are supposed to be GitHub-linked).
 */
async function loadRealFleet(): Promise<DemoFleetUser[]> {
  const out: DemoFleetUser[] = [];
  const missing: string[] = [];
  for (const persona of REAL_FLEET) {
    const userId = await lookupUserIdByEmail(persona.email);
    if (!userId) {
      missing.push(persona.email);
      continue;
    }
    out.push({
      email: persona.email,
      user_id: userId,
      private_profile_name: persona.private_profile_name,
      public_profile_name: persona.public_profile_name,
      password: DEFAULT_PASSWORD,
      role: "student",
      hasRealGitHub: true,
      fleetName: persona.fleetName
    });
  }
  if (missing.length > 0) {
    throw new Error(
      [
        `Real demo-fleet users do not exist: ${missing.join(", ")}.`,
        `These accounts must be created and linked to real GitHub identities before provisioning demo classes.`,
        `Bootstrap them via the normal signup + GitHub-link flow, then re-run.`
      ].join(" ")
    );
  }
  return out;
}

export async function ensureDemoFleet(opts: { numGraders?: number } = {}): Promise<DemoFleet> {
  const numGraders = Math.min(opts.numGraders ?? 4, GRADER_NAMES.length);

  const realStudents = await loadRealFleet();
  console.log(`✓ Real fleet present: ${realStudents.map((u) => u.fleetName).join(", ")}`);

  const graders: DemoFleetUser[] = [];
  for (let i = 0; i < numGraders; i++) {
    const email = `demo-fleet-grader-${i + 1}@pawtograder.net`;
    const userId = await ensureSyntheticUser(email, DEFAULT_PASSWORD);
    graders.push({
      email,
      user_id: userId,
      private_profile_name: GRADER_NAMES[i].private,
      public_profile_name: GRADER_NAMES[i].public,
      password: DEFAULT_PASSWORD,
      role: "grader",
      hasRealGitHub: false
    });
  }
  console.log(`✓ Grader fleet ready: ${graders.length}`);

  return { realStudents, graders };
}

if (require.main === module) {
  void (async () => {
    try {
      const fleet = await ensureDemoFleet({});
      console.log(`realStudents=${fleet.realStudents.length} graders=${fleet.graders.length}`);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
