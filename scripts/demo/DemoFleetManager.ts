/* eslint-disable no-console */
/**
 * DemoFleetManager — ensures the shared pool of demo users exists, returns
 * them in a form ready to enroll into a freshly provisioned demo class.
 *
 * Three tiers:
 *  - Real fleet (Ripley / Orion / Paws) — fixed emails, already exist and are
 *    linked to real GitHub accounts. We refuse to bootstrap these silently.
 *  - Filler students — stable synthetic emails, created if missing. DB-only.
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
  fillerStudents: DemoFleetUser[];
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

/**
 * Stable filler-student persona names. The list is ordered — fleet member N
 * always gets the same name so demo classes remain consistent across runs.
 */
const FILLER_STUDENT_NAMES: ReadonlyArray<{ private: string; public: string }> = [
  { private: "Alice Chen", public: "demo-otter-01" },
  { private: "Ben Rodriguez", public: "demo-otter-02" },
  { private: "Chloe Park", public: "demo-otter-03" },
  { private: "Daniel Okafor", public: "demo-otter-04" },
  { private: "Emma Liu", public: "demo-otter-05" },
  { private: "Felipe Costa", public: "demo-otter-06" },
  { private: "Grace Nakamura", public: "demo-otter-07" },
  { private: "Hassan Karimi", public: "demo-otter-08" },
  { private: "Isla Andersen", public: "demo-otter-09" },
  { private: "Jamal Washington", public: "demo-otter-10" },
  { private: "Kira Volkov", public: "demo-otter-11" },
  { private: "Liam Murphy", public: "demo-otter-12" },
  { private: "Maya Patel", public: "demo-otter-13" },
  { private: "Noah Schmidt", public: "demo-otter-14" },
  { private: "Olivia Brooks", public: "demo-otter-15" },
  { private: "Priya Reddy", public: "demo-otter-16" },
  { private: "Quentin Lefebvre", public: "demo-otter-17" },
  { private: "Riya Kapoor", public: "demo-otter-18" },
  { private: "Sven Eriksson", public: "demo-otter-19" },
  { private: "Tara Mehta", public: "demo-otter-20" },
  { private: "Umar Hassan", public: "demo-otter-21" },
  { private: "Vera Volkov", public: "demo-otter-22" },
  { private: "Wei Zhang", public: "demo-otter-23" },
  { private: "Xochi Mendoza", public: "demo-otter-24" },
  { private: "Yara Khoury", public: "demo-otter-25" },
  { private: "Zane Park", public: "demo-otter-26" },
  { private: "Anya Petrov", public: "demo-otter-27" }
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

export async function ensureDemoFleet(
  opts: { numFillerStudents?: number; numGraders?: number } = {}
): Promise<DemoFleet> {
  const numFillerStudents = Math.min(opts.numFillerStudents ?? 27, FILLER_STUDENT_NAMES.length);
  const numGraders = Math.min(opts.numGraders ?? 4, GRADER_NAMES.length);

  const realStudents = await loadRealFleet();
  console.log(`✓ Real fleet present: ${realStudents.map((u) => u.fleetName).join(", ")}`);

  const fillerStudents: DemoFleetUser[] = [];
  for (let i = 0; i < numFillerStudents; i++) {
    const email = `demo-fleet-student-${i + 1}@pawtograder.net`;
    const userId = await ensureSyntheticUser(email, DEFAULT_PASSWORD);
    fillerStudents.push({
      email,
      user_id: userId,
      private_profile_name: FILLER_STUDENT_NAMES[i].private,
      public_profile_name: FILLER_STUDENT_NAMES[i].public,
      password: DEFAULT_PASSWORD,
      role: "student",
      hasRealGitHub: false
    });
  }
  console.log(`✓ Filler students ready: ${fillerStudents.length}`);

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

  return { realStudents, fillerStudents, graders };
}

if (require.main === module) {
  void (async () => {
    try {
      const fleet = await ensureDemoFleet({});
      console.log(
        `realStudents=${fleet.realStudents.length} fillerStudents=${fleet.fillerStudents.length} graders=${fleet.graders.length}`
      );
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
