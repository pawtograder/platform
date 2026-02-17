import { createAdminClient } from "@/utils/supabase/client";
import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Page } from "@playwright/test";
import { addDays, format } from "date-fns";
import dotenv from "dotenv";
import { DEFAULT_RATE_LIMITS, RateLimitManager } from "../generator/GenerationUtils";
import { createClient } from "@supabase/supabase-js";
dotenv.config({ path: ".env.local" });

const DEFAULT_RATE_LIMIT_MANAGER = new RateLimitManager(DEFAULT_RATE_LIMITS);
export const supabase = createAdminClient<Database>();
// export const TEST_HANDOUT_REPO = "pawtograder-playground/test-e2e-java-handout-prod"; //TODO use env variable?
export const TEST_HANDOUT_REPO = "pawtograder-playground/test-e2e-java-handout"; //TODO use env variable?
export function getTestRunPrefix(randomSuffix?: string) {
  const suffix = randomSuffix ?? Math.random().toString(36).substring(2, 6);
  const test_run_batch = format(new Date(), "dd/MM/yy HH:mm:ss") + "#" + suffix;
  const workerIndex = process.env.TEST_WORKER_INDEX || "";
  return `e2e-${test_run_batch}-${workerIndex}`;
}
export type TestingUser = {
  private_profile_name: string;
  public_profile_name: string;
  email: string;
  user_id: string;
  private_profile_id: string;
  public_profile_id: string;
  class_id: number;
  password: string;
};

export async function createClass({
  name,
  rateLimitManager
}: { name?: string; rateLimitManager?: RateLimitManager } = {}) {
  const className = name ?? `E2E Test Class`;
  const { data: classDataList, error: classError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("classes", () =>
    supabase
      .from("classes")
      .insert({
        name: className,
        slug: "e2e-ignore-" + className.toLowerCase().replace(/ /g, "-"),
        github_org: "pawtograder-playground",
        start_date: addDays(new Date(), -30).toISOString(),
        end_date: addDays(new Date(), 180).toISOString(),
        late_tokens_per_student: 10,
        time_zone: "America/New_York"
      })
      .select("*")
  );
  if (classError) {
    throw new Error(`Failed to create class: ${classError.message}`);
  }
  const classData = classDataList[0];
  if (!classData) {
    throw new Error("Failed to create class");
  }
  //Update slug to include class_id
  const { error: classError2 } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("classes", () =>
    supabase
      .from("classes")
      .update({ slug: `${classData.slug}-${classData.id}` })
      .eq("id", classData.id)
      .select("id")
  );
  if (classError2) {
    throw new Error(`Failed to update class slug: ${classError2.message}`);
  }
  return classData;
}
let sectionIdx = 1;
export async function createClassSection({
  class_id,
  rateLimitManager,
  name
}: {
  class_id: number;
  rateLimitManager?: RateLimitManager;
  name?: string;
}) {
  const { data: sectionDataList, error: sectionError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("class_sections", () =>
    supabase
      .from("class_sections")
      .insert({
        class_id: class_id,
        name: name ?? `Section #${sectionIdx}Test`
      })
      .select("*")
  );
  sectionIdx++;
  if (sectionError) {
    throw new Error(`Failed to create class section: ${sectionError.message}`);
  }
  const sectionData = sectionDataList[0];
  if (!sectionData) {
    throw new Error("Failed to create class section");
  }
  return sectionData;
}

export async function createClassWithSISSections({
  class_id,
  class_section_crns,
  lab_section_crns
}: {
  class_id: number;
  class_section_crns: number[];
  lab_section_crns: number[];
}): Promise<{
  classSections: Array<{ id: number; sis_crn: number; name: string }>;
  labSections: Array<{ id: number; sis_crn: number; name: string }>;
}> {
  const classSections: Array<{ id: number; sis_crn: number; name: string }> = [];
  const labSections: Array<{ id: number; sis_crn: number; name: string }> = [];

  for (const crn of class_section_crns) {
    const { data, error } = await supabase
      .from("class_sections")
      .insert({
        class_id,
        name: `SIS Class Section ${crn}`,
        sis_crn: crn
      })
      .select("id, sis_crn, name")
      .single();
    if (error) throw new Error(`Failed to create SIS class section ${crn}: ${error.message}`);
    classSections.push({ id: data.id, sis_crn: data.sis_crn!, name: data.name });
  }

  for (const crn of lab_section_crns) {
    const { data, error } = await supabase
      .from("lab_sections")
      .insert({
        class_id,
        name: `SIS Lab Section ${crn}`,
        sis_crn: crn
      })
      .select("id, sis_crn, name")
      .single();
    if (error) throw new Error(`Failed to create SIS lab section ${crn}: ${error.message}`);
    labSections.push({ id: data.id, sis_crn: data.sis_crn!, name: data.name });
  }

  return { classSections, labSections };
}

export type SimulatedSISRosterEntry = {
  sis_user_id: number;
  name?: string;
  role: "student" | "grader" | "instructor";
  class_section_crn?: number | null;
  lab_section_crn?: number | null;
};

export type SISSyncEnrollmentResult = {
  success: boolean;
  class_id: number;
  expire_missing: boolean;
  counts: {
    invitations_created: number;
    invitations_updated: number;
    invitations_expired: number;
    invitations_reactivated: number;
    enrollments_created: number;
    enrollments_updated: number;
    enrollments_disabled: number;
    enrollments_reenabled: number;
    enrollments_adopted: number;
  };
};

export async function simulateSISSync({
  class_id,
  roster,
  expire_missing = true,
  section_updates
}: {
  class_id: number;
  roster: SimulatedSISRosterEntry[];
  expire_missing?: boolean;
  section_updates?: Array<{
    section_type: "class" | "lab";
    sis_crn: number;
    meeting_location?: string | null;
    meeting_times?: string | null;
    campus?: string | null;
    day_of_week?: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | null;
    start_time?: string | null;
    end_time?: string | null;
  }>;
}): Promise<SISSyncEnrollmentResult> {
  const { data, error } = await supabase.rpc("sis_sync_enrollment", {
    p_class_id: class_id,
    p_roster_data: roster,
    p_sync_options: {
      expire_missing,
      section_updates: section_updates ?? []
    }
  });

  if (error) throw new Error(`sis_sync_enrollment failed: ${error.message}`);
  if (!data) throw new Error("sis_sync_enrollment returned null");
  return data as SISSyncEnrollmentResult;
}

export async function getEnrollmentState(
  class_id: number,
  sis_user_id: number
): Promise<{
  user?: { user_id: string; sis_user_id: number | null };
  user_role?: {
    id: number;
    role: "student" | "grader" | "instructor" | "admin";
    disabled: boolean;
    canvas_id: number | null;
    class_section_id: number | null;
    lab_section_id: number | null;
    sis_sync_opt_out?: boolean;
  } | null;
  invitation?: {
    id: number;
    status: string;
    role: string;
    sis_managed: boolean;
    class_section_id: number | null;
    lab_section_id: number | null;
  } | null;
}> {
  const { data: user } = await supabase
    .from("users")
    .select("user_id, sis_user_id")
    .eq("sis_user_id", sis_user_id)
    .maybeSingle();

  const { data: invitation } = await supabase
    .from("invitations")
    .select("id, status, role, sis_managed, class_section_id, lab_section_id")
    .eq("class_id", class_id)
    .eq("sis_user_id", sis_user_id)
    .maybeSingle();

  let user_role = null;
  if (user?.user_id) {
    const { data: ur } = await supabase
      .from("user_roles")
      .select("id, role, disabled, canvas_id, class_section_id, lab_section_id, sis_sync_opt_out")
      .eq("class_id", class_id)
      .eq("user_id", user.user_id)
      .maybeSingle();
    user_role = ur ?? null;
  }

  return { user: user ?? undefined, user_role, invitation: invitation ?? null };
}

export async function setUserSisId(user_id: string, sis_user_id: number) {
  const { error } = await supabase.from("users").update({ sis_user_id }).eq("user_id", user_id);
  if (error) throw new Error(`Failed to set users.sis_user_id=${sis_user_id} for user_id=${user_id}: ${error.message}`);
}
export async function updateClassSettings({
  class_id,
  start_date,
  end_date,
  late_tokens_per_student,
  rateLimitManager
}: {
  class_id: number;
  start_date: string;
  end_date: string;
  late_tokens_per_student?: number;
  rateLimitManager?: RateLimitManager;
}) {
  await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("classes", () =>
    supabase
      .from("classes")
      .update({ start_date: start_date, end_date: end_date, late_tokens_per_student: late_tokens_per_student })
      .eq("id", class_id)
      .select("id")
  );
}

// Helper function to get auth token for a user
export async function getAuthTokenForUser(testingUser: TestingUser): Promise<string> {
  // Create a separate Supabase client for the user (using anon key)
  const userSupabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

  // Generate magic link using admin client (same as TestingUtils.ts does)
  const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
    email: testingUser.email,
    type: "magiclink"
  });

  if (magicLinkError || !magicLinkData.properties?.hashed_token) {
    throw new Error(`Failed to generate magic link for ${testingUser.email}: ${magicLinkError?.message}`);
  }

  // Verify the OTP to get a session
  const { data, error } = await userSupabase.auth.verifyOtp({
    token_hash: magicLinkData.properties.hashed_token,
    type: "magiclink"
  });

  if (error || !data.session) {
    throw new Error(`Failed to verify magic link for ${testingUser.email}: ${error?.message}`);
  }

  return data.session.access_token;
}

import type { SupabaseClient } from "@supabase/supabase-js";

// Helper function to create a Supabase client authenticated as a specific user
export async function createAuthenticatedClient(testingUser: TestingUser): Promise<SupabaseClient<Database>> {
  // Create a separate Supabase client for the user (using anon key)
  const userSupabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

  // Generate magic link using admin client
  const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
    email: testingUser.email,
    type: "magiclink"
  });

  if (magicLinkError || !magicLinkData.properties?.hashed_token) {
    throw new Error(`Failed to generate magic link for ${testingUser.email}: ${magicLinkError?.message}`);
  }

  // Verify the OTP to get a session
  const { data, error } = await userSupabase.auth.verifyOtp({
    token_hash: magicLinkData.properties.hashed_token,
    type: "magiclink"
  });

  if (error || !data.session) {
    throw new Error(`Failed to verify magic link for ${testingUser.email}: ${error?.message}`);
  }

  await userSupabase.auth.setSession(data.session);

  return userSupabase;
}

async function signInWithMagicLinkAndRetry(page: Page, testingUser: TestingUser, retriesRemaining: number = 3) {
  try {
    // Generate magic link on-demand for authentication
    const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
      email: testingUser.email,
      type: "magiclink"
    });
    if (magicLinkError) {
      throw new Error(`Failed to generate magic link: ${magicLinkError.message}`);
    }

    const magicLink = `/auth/magic-link?token_hash=${magicLinkData.properties?.hashed_token}`;

    // Use magic link for login
    await page.goto(magicLink);
    await page.getByRole("button", { name: "Sign in with magic link" }).click();
    await page.waitForLoadState("networkidle");

    const currentUrl = page.url();
    const isSuccessful = currentUrl.includes("/course");
    // Check to see if we got the magic link expired notice
    if (!isSuccessful) {
      // Magic link expired, retry if we have retries remaining
      if (retriesRemaining > 0) {
        return await signInWithMagicLinkAndRetry(page, testingUser, retriesRemaining - 1);
      } else {
        throw new Error("Magic link expired and no retries remaining");
      }
    }

    if (!isSuccessful) {
      throw new Error("Failed to sign in - neither success nor expired state detected");
    }
  } catch (error) {
    if (retriesRemaining > 0 && (error as Error).message.includes("Failed to sign in")) {
      console.log(`Sign in failed, retrying... (${retriesRemaining} retries remaining)`);
      return await signInWithMagicLinkAndRetry(page, testingUser, retriesRemaining - 1);
    }
    throw new Error(`Failed to sign in with magic link: ${(error as Error).message}`);
  }
}
export async function loginAsUser(page: Page, testingUser: TestingUser, course?: Course) {
  await page.goto("/");
  await signInWithMagicLinkAndRetry(page, testingUser);

  if (course) {
    await page.waitForLoadState("networkidle");
    await page.goto(`/course/${course.id}`);
    await page.waitForLoadState("networkidle");
  }
}

const userIdx = {
  student: 1,
  instructor: 1,
  grader: 1
};
export async function createUserInClass({
  role,
  class_id,
  section_id,
  lab_section_id,
  randomSuffix,
  name,
  email,
  rateLimitManager,
  useMagicLink = false
}: {
  role: "student" | "instructor" | "grader";
  class_id: number;
  section_id?: number;
  lab_section_id?: number;
  randomSuffix?: string;
  name?: string;
  email?: string;
  rateLimitManager?: RateLimitManager;
  useMagicLink?: boolean;
}): Promise<TestingUser> {
  const extra_randomness = randomSuffix ?? Math.random().toString(36).substring(2, 20);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
  const resolvedEmail = email ?? `${role}-${workerIndex}-${extra_randomness}-${userIdx[role]}@pawtograder.net`;
  const resolvedName = name ? name : `${role.charAt(0).toUpperCase()}${role.slice(1)} #${userIdx[role]}Test`;
  const public_profile_name = name
    ? `Pseudonym #${userIdx[role]}`
    : `Pseudonym #${userIdx[role]} ${role.charAt(0).toUpperCase()}${role.slice(1)}`;
  const private_profile_name = `${resolvedName}`;
  userIdx[role]++;
  // Try to create user, if it fails due to existing email, try to get the existing user
  let userId: string | undefined = undefined;
  const tempPassword = useMagicLink
    ? Math.random().toString(36).substring(2, 34)
    : process.env.TEST_PASSWORD || "change-it";
  try {
    const { data: newUserData, error: userError } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).createUser({
      email: resolvedEmail,
      password: tempPassword,
      email_confirm: true
    });
    userId = newUserData?.user?.id;

    if (userError) {
      // Check if error is due to user already existing
      if (userError.message.includes("already exists") || userError.message.includes("already registered")) {
        // Try to get the user by email using getUserByEmail (if available)
        try {
          const { data: existingUserData, error: getUserError } = await supabase
            .from("users")
            .select("*")
            .eq("email", resolvedEmail)
            .single();
          if (getUserError) {
            throw new Error(`Failed to get existing user: ${getUserError.message}`);
          }
          userId = existingUserData.user_id;
        } catch {
          // If getUserByEmail doesn't work, fall back to listing users
          const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();
          if (listError) {
            throw new Error(`Failed to list users and retrieve existing user: ${listError.message}`);
          }
          const existingUser = existingUsers.users.find((user) => user.email === resolvedEmail);
          if (existingUser) {
            userId = existingUser.id;
          } else {
            throw new Error(`User creation failed and couldn't find existing user: ${userError.message}`);
          }
        }
      } else {
        // eslint-disable-next-line no-console
        console.error(userError);
        throw new Error(`Failed to create user: ${userError.message}`);
      }
    }
  } catch (e) {
    const error = e as Error;
    if (error.message.includes("A user with this email address has already been registered")) {
      //Refetch, we had a race
      const { data: existingUserData, error: getUserError } = await supabase
        .from("users")
        .select("*")
        .eq("email", resolvedEmail)
        .single();
      if (getUserError) {
        throw new Error(`Failed to get existing user: ${getUserError.message}`);
      }
      userId = existingUserData.user_id;
    } else {
      throw e;
    }
  }
  if (!userId) {
    throw new Error("Failed to create user");
  }
  // Check if user already has a role in this class
  const { data: existingRole, error: roleCheckError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("user_roles", () =>
    supabase
      .from("user_roles")
      .select("private_profile_id, public_profile_id")
      .eq("user_id", userId)
      .eq("class_id", class_id)
  );

  let publicProfileData: { id: string }, privateProfileData: { id: string };

  if (existingRole.length > 0 && !roleCheckError) {
    // User already enrolled in class, get existing profile data
    publicProfileData = { id: existingRole[0].public_profile_id };
    privateProfileData = { id: existingRole[0].private_profile_id };
  } else if (class_id !== 1) {
    // User not enrolled or new class, create profiles and enrollment
    const { data: newPublicProfileDataList, error: publicProfileError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("profiles", () =>
      supabase
        .from("profiles")
        .insert({
          name: public_profile_name,
          avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${"test-user"}`,
          class_id: class_id,
          is_private_profile: false
        })
        .select("id")
    );
    if (publicProfileError) {
      throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
    }
    const newPublicProfileData = newPublicProfileDataList[0];

    const { data: newPrivateProfileDataList, error: privateProfileError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("profiles", () =>
      supabase
        .from("profiles")
        .insert({
          name: private_profile_name,
          avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${"test-private-user"}`,
          class_id: class_id,
          is_private_profile: true
        })
        .select("id")
    );
    if (privateProfileError) {
      throw new Error(`Failed to create private profile: ${privateProfileError.message}`);
    }
    const newPrivateProfileData = newPrivateProfileDataList[0];

    if (!newPublicProfileData || !newPrivateProfileData) {
      throw new Error("Failed to create public or private profile");
    }

    publicProfileData = newPublicProfileData;
    privateProfileData = newPrivateProfileData;

    await supabase.from("user_roles").insert({
      user_id: userId,
      class_id: class_id,
      private_profile_id: privateProfileData.id,
      public_profile_id: publicProfileData.id,
      role: role,
      class_section_id: section_id,
      lab_section_id: lab_section_id
    });
  } else if (section_id || lab_section_id) {
    await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("user_roles", () =>
      supabase
        .from("user_roles")
        .update({
          class_section_id: section_id,
          lab_section_id: lab_section_id
        })
        .eq("user_id", userId)
        .eq("class_id", class_id)
        .select("id")
    );
  }
  const { data: profileData, error: profileError } = await supabase
    .from("user_roles")
    .select("private_profile_id, public_profile_id")
    .eq("user_id", userId)
    .eq("class_id", class_id)
    .single();
  if (!profileData || profileError) {
    throw new Error(`Failed to get profile: ${profileError?.message}`);
  }

  // Always return password, magic links will be generated by loginAsUser when needed
  const password = process.env.TEST_PASSWORD || "change-it";

  return {
    private_profile_name: private_profile_name,
    public_profile_name: public_profile_name,
    email: resolvedEmail,
    user_id: userId,
    private_profile_id: profileData.private_profile_id,
    public_profile_id: profileData.public_profile_id,
    password: password,
    class_id: class_id
  };
}

// New wrapper function for batch user creation with existing user detection
export async function createUsersInClass(
  userRequests: Array<{
    role: "student" | "instructor" | "grader";
    class_id: number;
    section_id?: number;
    lab_section_id?: number;
    randomSuffix?: string;
    name?: string;
    email?: string;
    rateLimitManager?: RateLimitManager;
    useMagicLink?: boolean;
  }>,
  rateLimitManager?: RateLimitManager
): Promise<TestingUser[]> {
  // Resolve all emails first
  const resolvedRequests = userRequests.map((req) => {
    const extra_randomness = req.randomSuffix ?? Math.random().toString(36).substring(2, 20);
    const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
    const resolvedEmail =
      req.email ?? `${req.role}-${workerIndex}-${extra_randomness}-${userIdx[req.role]}@pawtograder.net`;
    const resolvedName = req.name
      ? req.name
      : `${req.role.charAt(0).toUpperCase()}${req.role.slice(1)} #${userIdx[req.role]}Test`;
    userIdx[req.role]++;

    return {
      ...req,
      resolvedEmail,
      resolvedName
    };
  });

  // Get all resolved emails
  const emails = resolvedRequests.map((req) => req.resolvedEmail);

  // Check for existing users in one database query
  const { data: existingUsers, error: existingUsersError } = await supabase
    .from("users")
    .select("user_id, email")
    .in("email", emails);

  if (existingUsersError) {
    throw new Error(`Failed to check for existing users: ${existingUsersError.message}`);
  }

  // Create a map of existing users by email
  const existingUsersMap = new Map(existingUsers.map((user) => [user.email, user.user_id]));

  // Process each request
  const results: TestingUser[] = [];

  for (const request of resolvedRequests) {
    const { role, class_id, section_id, lab_section_id, resolvedEmail, resolvedName, useMagicLink = false } = request;

    const public_profile_name = request.name
      ? `Pseudonym #${userIdx[role] - 1}`
      : `Pseudonym #${userIdx[role] - 1} ${role.charAt(0).toUpperCase()}${role.slice(1)}`;
    const private_profile_name = resolvedName;

    let userId: string;

    // Check if user already exists
    if (existingUsersMap.has(resolvedEmail)) {
      userId = existingUsersMap.get(resolvedEmail)!;
    } else {
      // Create new user
      const tempPassword = useMagicLink
        ? Math.random().toString(36).substring(2, 34)
        : process.env.TEST_PASSWORD || "change-it";
      try {
        const { data: newUserData, error: userError } = await (
          rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
        ).createUser({
          email: resolvedEmail,
          password: tempPassword,
          email_confirm: true
        });

        if (userError) {
          throw new Error(`Failed to create user ${resolvedEmail}: ${userError.message}`);
        }

        // Handle both possible return structures from createUser
        if (newUserData && "user" in newUserData && newUserData.user) {
          userId = newUserData.user.id;
        } else if (newUserData && "id" in newUserData) {
          userId = (newUserData as unknown as { id: string }).id;
        } else {
          throw new Error("Failed to extract user ID from created user data");
        }
      } catch (e) {
        if ((e as Error).message.includes("email address has already")) {
          //Refetch, we had a race
          const { data: existingUserData, error: getUserError } = await supabase
            .from("users")
            .select("*")
            .eq("email", resolvedEmail)
            .single();
          if (getUserError) {
            throw new Error(`Failed to get existing user: ${getUserError.message}`);
          }
          userId = existingUserData.user_id;
        } else {
          throw new Error(`Failed to create user ${resolvedEmail}: ${(e as Error).message}`);
        }
      }
    }

    // Check if user already has a role in this class
    const { data: existingRole, error: roleCheckError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("user_roles", () =>
      supabase
        .from("user_roles")
        .select("private_profile_id, public_profile_id")
        .eq("user_id", userId)
        .eq("class_id", class_id)
    );

    let publicProfileData: { id: string }, privateProfileData: { id: string };

    if (existingRole.length > 0 && !roleCheckError) {
      // User already enrolled in class, get existing profile data
      publicProfileData = { id: existingRole[0].public_profile_id };
      privateProfileData = { id: existingRole[0].private_profile_id };
    } else if (class_id !== 1) {
      // User not enrolled or new class, create profiles and enrollment
      const { data: newPublicProfileDataList, error: publicProfileError } = await (
        rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
      ).trackAndLimit("profiles", () =>
        supabase
          .from("profiles")
          .insert({
            name: public_profile_name,
            avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${"test-user"}`,
            class_id: class_id,
            is_private_profile: false
          })
          .select("id")
      );
      if (publicProfileError) {
        throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
      }
      const newPublicProfileData = newPublicProfileDataList[0];

      const { data: newPrivateProfileDataList, error: privateProfileError } = await (
        rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
      ).trackAndLimit("profiles", () =>
        supabase
          .from("profiles")
          .insert({
            name: private_profile_name,
            avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${"test-private-user"}`,
            class_id: class_id,
            is_private_profile: true
          })
          .select("id")
      );
      if (privateProfileError) {
        throw new Error(`Failed to create private profile: ${privateProfileError.message}`);
      }
      const newPrivateProfileData = newPrivateProfileDataList[0];

      if (!newPublicProfileData || !newPrivateProfileData) {
        throw new Error("Failed to create public or private profile");
      }

      publicProfileData = newPublicProfileData;
      privateProfileData = newPrivateProfileData;

      await supabase.from("user_roles").insert({
        user_id: userId,
        class_id: class_id,
        private_profile_id: privateProfileData.id,
        public_profile_id: publicProfileData.id,
        role: role,
        class_section_id: section_id,
        lab_section_id: lab_section_id
      });
    } else if (section_id || lab_section_id) {
      await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("user_roles", () =>
        supabase
          .from("user_roles")
          .update({
            class_section_id: section_id,
            lab_section_id: lab_section_id
          })
          .eq("user_id", userId)
          .eq("class_id", class_id)
          .select("id")
      );
    }

    const { data: profileData, error: profileError } = await supabase
      .from("user_roles")
      .select("private_profile_id, public_profile_id")
      .eq("user_id", userId)
      .eq("class_id", class_id)
      .single();
    if (!profileData || profileError) {
      throw new Error(`Failed to get profile: ${profileError?.message}`);
    }

    // Always return password, magic links will be generated by loginAsUser when needed
    const password = process.env.TEST_PASSWORD || "change-it";

    results.push({
      private_profile_name: private_profile_name,
      public_profile_name: public_profile_name,
      email: resolvedEmail,
      user_id: userId,
      private_profile_id: profileData.private_profile_id,
      public_profile_id: profileData.public_profile_id,
      password: password,
      class_id: class_id
    });
  }

  return results;
}

let repoCounter = 0;
export async function insertPreBakedSubmission({
  student_profile_id,
  assignment_group_id,
  assignment_id,
  class_id,
  repositorySuffix,
  rateLimitManager
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  assignment_id: number;
  class_id: number;
  repositorySuffix?: string;
  rateLimitManager?: RateLimitManager;
}): Promise<{
  submission_id: number;
  repository_name: string;
  grading_review_id: number;
}> {
  const test_run_prefix = repositorySuffix ?? getTestRunPrefix();
  const repository = `not-actually/repository-${test_run_prefix}-${repoCounter}`;
  repoCounter++;
  const { data: repositoryDataList, error: repositoryError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("repositories", () =>
    supabase
      .from("repositories")
      .insert({
        assignment_id: assignment_id,
        repository: repository,
        class_id: class_id,
        assignment_group_id,
        profile_id: student_profile_id,
        synced_handout_sha: "none"
      })
      .select("id")
  );
  if (repositoryError) {
    throw new Error(`Failed to create repository: ${repositoryError.message}`);
  }
  const repositoryData = repositoryDataList[0];
  const repository_id = repositoryData?.id;

  const { data: checkRunDataList, error: checkRunError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("repository_check_runs", () =>
    supabase
      .from("repository_check_runs")
      .insert({
        class_id: class_id,
        repository_id: repository_id,
        check_run_id: 1,
        status: "{}",
        sha: "none",
        commit_message: "none"
      })
      .select("id")
  );
  if (checkRunError) {
    // eslint-disable-next-line no-console
    console.error(checkRunError);
    throw new Error("Failed to create check run");
  }
  const checkRunData = checkRunDataList[0];
  const check_run_id = checkRunData?.id;
  const { data: submissionDataList, error: submissionError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("submissions", () =>
    supabase
      .from("submissions")
      .insert({
        assignment_id: assignment_id,
        profile_id: student_profile_id,
        assignment_group_id: assignment_group_id,
        sha: "none",
        repository: repository,
        run_attempt: 1,
        run_number: 1,
        class_id: class_id,
        repository_check_run_id: check_run_id,
        repository_id: repository_id
      })
      .select("*")
  );
  if (submissionError) {
    // eslint-disable-next-line no-console
    console.error(submissionError);
    throw new Error("Failed to create submission");
  }
  const submissionData = submissionDataList[0];
  const submission_id = submissionData?.id;
  const { error: submissionFileError } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
    "submission_files",
    () =>
      supabase
        .from("submission_files")
        .insert({
          name: "sample.java",
          contents: `package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

  /*
   * This method takes two integers and returns their sum.
   * 
   * @param a the first integer
   * @param b the second integer
   * @return the sum of a and b
   */
  public int doMath(int a, int b) {
      return a+b;
  }

  /**
   * This method returns a message, "Hello, World!"
   * @return
   */
  public String getMessage() {
      
      return "Hello, World!";
  }
}`,
          class_id: class_id,
          submission_id: submission_id,
          profile_id: student_profile_id,
          assignment_group_id: assignment_group_id
        })
        .select("id")
  );
  if (submissionFileError) {
    // eslint-disable-next-line no-console
    console.error(submissionFileError);
    throw new Error("Failed to create submission file");
  }
  const { data: graderResultDataList, error: graderResultError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("grader_results", () =>
    supabase
      .from("grader_results")
      .insert({
        submission_id: submission_id,
        score: 5,
        class_id: class_id,
        profile_id: student_profile_id,
        assignment_group_id: assignment_group_id,
        lint_passed: true,
        lint_output: "no lint output",
        lint_output_format: "markdown",
        max_score: 10
      })
      .select("id")
  );
  if (graderResultError) {
    // eslint-disable-next-line no-console
    console.error(graderResultError);
    throw new Error("Failed to create grader result");
  }
  const graderResultData = graderResultDataList[0];
  const { error: graderResultTestError } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
    "grader_result_tests",
    () =>
      supabase
        .from("grader_result_tests")
        .insert([
          {
            score: 5,
            max_score: 5,
            name: "test 1",
            name_format: "text",
            output: "here is a bunch of output\n**wow**",
            output_format: "markdown",
            class_id: class_id,
            student_id: student_profile_id,
            assignment_group_id,
            grader_result_id: graderResultData.id,
            is_released: true
          },
          {
            score: 5,
            max_score: 5,
            name: "test 2",
            name_format: "text",
            output: "here is a bunch of output\n**wow**",
            output_format: "markdown",
            class_id: class_id,
            student_id: student_profile_id,
            assignment_group_id,
            grader_result_id: graderResultData.id,
            is_released: true
          }
        ])
        .select("id")
  );
  if (graderResultTestError) {
    // eslint-disable-next-line no-console
    console.error(graderResultTestError);
    throw new Error("Failed to create grader result test");
  }
  //We add review id's in an AFTER trigger :/
  const { data: submissionWithReviewId, error: submissionWithReviewIdError } = await supabase
    .from("submissions")
    .select("grading_review_id")
    .eq("id", submission_id)
    .single();
  if (submissionWithReviewIdError) {
    // eslint-disable-next-line no-console
    console.error(submissionWithReviewIdError);
    throw new Error("Failed to get submission with review id");
  }
  return {
    submission_id: submission_id,
    repository_name: repository,
    grading_review_id: submissionWithReviewId?.grading_review_id || 0
  };
}

let labSectionIdx = 1;
export async function createLabSectionWithStudents({
  class_id,
  lab_leader,
  lab_leaders,
  day_of_week,
  students,
  start_time,
  end_time,
  name
}: {
  class_id?: number;
  lab_leader?: TestingUser; // Deprecated, use lab_leaders instead
  lab_leaders?: TestingUser[];
  day_of_week: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  students: TestingUser[];
  start_time?: string;
  end_time?: string;
  name?: string;
}) {
  const lab_section_name = name ?? `Lab #${labSectionIdx} (${day_of_week})`;
  labSectionIdx++;

  // Support both old lab_leader and new lab_leaders for backwards compatibility
  const leaders = lab_leaders || (lab_leader ? [lab_leader] : []);
  if (leaders.length === 0) {
    throw new Error("At least one lab leader is required");
  }

  const { data: labSectionData, error: labSectionError } = await supabase
    .from("lab_sections")
    .insert({
      name: lab_section_name,
      day_of_week: day_of_week,
      class_id: class_id || 1,
      start_time: start_time ?? "10:00",
      end_time: end_time ?? "11:00"
    })
    .select("*")
    .single();
  if (labSectionError) {
    throw new Error(`Failed to create lab section: ${labSectionError.message}`);
  }
  const lab_section_id = labSectionData.id;

  // Insert lab section leaders into junction table
  if (leaders.length > 0) {
    const { error: leadersError } = await supabase.from("lab_section_leaders").insert(
      leaders.map((leader) => ({
        lab_section_id: lab_section_id,
        profile_id: leader.private_profile_id,
        class_id: class_id || 1
      }))
    );
    if (leadersError) {
      throw new Error(`Failed to create lab section leaders: ${leadersError.message}`);
    }
  }

  for (const student of students) {
    await supabase
      .from("user_roles")
      .update({
        lab_section_id: lab_section_id
      })
      .eq("private_profile_id", student.private_profile_id);
  }
  return labSectionData;
}

export async function insertOfficeHoursQueue({ class_id, name }: { class_id: number; name: string }) {
  const { data: officeHoursQueueData, error: officeHoursQueueError } = await supabase
    .from("help_queues")
    .insert({
      class_id: class_id,
      name: name,
      description: "This is a test office hours queue for E2E testing",
      depth: 1,
      available: true,
      queue_type: "video"
    })
    .select("id")
    .single();
  if (officeHoursQueueError) {
    throw new Error(`Failed to create office hours queue: ${officeHoursQueueError.message}`);
  }
  return officeHoursQueueData;
}
const assignmentIdx = {
  lab: 1,
  assignment: 1
};
export async function insertAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions,
  class_id,
  rateLimitManager,
  name,
  regrade_deadline,
  release_date,
  grader_pseudonymous_mode,
  show_leaderboard
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
  class_id: number;
  rateLimitManager?: RateLimitManager;
  name?: string;
  regrade_deadline?: string | null;
  release_date?: string;
  grader_pseudonymous_mode?: boolean;
  show_leaderboard?: boolean;
}): Promise<Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }> {
  const currentAssignmentIdx = assignmentIdx.assignment;
  const title = name ?? `Assignment #${currentAssignmentIdx}Test`;
  assignmentIdx.assignment++;
  const { data: selfReviewSettingDataList, error: selfReviewSettingError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("assignment_self_review_settings", () =>
    supabase
      .from("assignment_self_review_settings")
      .insert({
        class_id: class_id,
        enabled: true,
        deadline_offset: 2,
        allow_early: true
      })
      .select("id")
  );
  if (selfReviewSettingError) {
    throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
  }
  const selfReviewSettingData = selfReviewSettingDataList[0];
  const self_review_setting_id = selfReviewSettingData.id;
  const { data: insertedAssignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is a test assignment for E2E testing",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: TEST_HANDOUT_REPO,
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: release_date ?? addDays(new Date(), -1).toUTCString(),
      class_id: class_id,
      slug: `assignment-${currentAssignmentIdx}`,
      group_config: "individual",
      allow_not_graded_submissions: allow_not_graded_submissions || false,
      self_review_setting_id: self_review_setting_id,
      regrade_deadline: regrade_deadline,
      grader_pseudonymous_mode: grader_pseudonymous_mode || false,
      show_leaderboard: show_leaderboard || false
    })
    .select("id")
    .single();
  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }
  const { data: assignmentDataList } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
    "assignments",
    () => supabase.from("assignments").select("*").eq("id", insertedAssignmentData.id)
  );
  const assignmentData = assignmentDataList[0];
  if (!assignmentData) {
    throw new Error("Failed to get assignment");
  }
  await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("autograder", () =>
    supabase
      .from("autograder")
      .update({
        config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
      })
      .eq("id", assignmentData.id)
      .select("id")
  );

  const partsData = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("rubric_parts", () =>
    supabase
      .from("rubric_parts")
      .insert([
        {
          class_id: class_id,
          name: "Self Review",
          description: "Self review rubric",
          ordinal: 0,
          rubric_id: assignmentData.self_review_rubric_id || 0,
          assignment_id: assignmentData.id
        },
        {
          class_id: class_id,
          name: "Grading Review Part 1",
          description: "Grading review rubric, part 1",
          ordinal: 1,
          rubric_id: assignmentData.grading_rubric_id || 0,
          assignment_id: assignmentData.id
        },
        {
          class_id: class_id,
          name: "Grading Review Part 2",
          description: "Grading review rubric, part 2",
          ordinal: 2,
          rubric_id: assignmentData.grading_rubric_id || 0,
          assignment_id: assignmentData.id
        }
      ])
      .select("*")
  );
  if (partsData.error) {
    throw new Error(`Failed to create rubric parts: ${partsData.error.message}`);
  }
  const self_review_part = partsData.data?.find((p) => p.name === "Self Review");
  const grading_review_part = partsData.data?.find((p) => p.name === "Grading Review Part 1");
  const grading_review_part_2 = partsData.data?.find((p) => p.name === "Grading Review Part 2");

  if (!self_review_part) {
    throw new Error("Failed to find 'Self Review' rubric part");
  }
  if (!grading_review_part) {
    throw new Error("Failed to find 'Grading Review Part 1' rubric part");
  }
  if (!grading_review_part_2) {
    throw new Error("Failed to find 'Grading Review Part 2' rubric part");
  }

  const self_review_part_id = self_review_part.id;
  const grading_review_part_id = grading_review_part.id;
  const grading_review_part_2_id = grading_review_part_2.id;
  const criteriaData = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("rubric_criteria", () =>
    supabase
      .from("rubric_criteria")
      .insert([
        {
          class_id: class_id,
          name: "Self Review Criteria",
          description: "Criteria for self review evaluation",
          ordinal: 0,
          total_points: 10,
          is_additive: true,
          rubric_part_id: self_review_part_id || 0,
          rubric_id: assignmentData.self_review_rubric_id || 0,
          assignment_id: assignmentData.id
        },
        {
          class_id: class_id,
          name: "Grading Review Criteria",
          description: "Criteria for grading review evaluation",
          ordinal: 0,
          total_points: 20,
          is_additive: true,
          rubric_part_id: grading_review_part_id || 0,
          rubric_id: assignmentData.grading_rubric_id || 0,
          assignment_id: assignmentData.id
        },
        {
          class_id: class_id,
          name: "Grading Review Criteria 2",
          description: "Criteria for grading review evaluation, part 2",
          ordinal: 1,
          total_points: 20,
          is_additive: true,
          rubric_part_id: grading_review_part_2_id || 0,
          rubric_id: assignmentData.grading_rubric_id || 0,
          assignment_id: assignmentData.id
        }
      ])
      .select("id, name")
  );
  if (criteriaData.error) {
    throw new Error(`Failed to create rubric criteria: ${criteriaData.error.message}`);
  }

  // Create a lookup map from criterion name to ID for robust, order-independent access
  const criteriaByName = (criteriaData.data || []).reduce(
    (acc, criterion) => {
      acc[criterion.name] = criterion.id;
      return acc;
    },
    {} as Record<string, number>
  );

  const selfReviewCriteriaId = criteriaByName["Self Review Criteria"];
  const gradingReviewCriteriaId = criteriaByName["Grading Review Criteria"];
  const gradingReviewCriteriaId2 = criteriaByName["Grading Review Criteria 2"];

  // Validate that all expected criteria were found
  if (!selfReviewCriteriaId) {
    throw new Error("Failed to find 'Self Review Criteria' criterion");
  }
  if (!gradingReviewCriteriaId) {
    throw new Error("Failed to find 'Grading Review Criteria' criterion");
  }
  if (!gradingReviewCriteriaId2) {
    throw new Error("Failed to find 'Grading Review Criteria 2' criterion");
  }
  const { data: rubricChecksData, error: rubricChecksError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("rubric_checks", () =>
    supabase
      .from("rubric_checks")
      .insert([
        {
          rubric_criteria_id: selfReviewCriteriaId || 0,
          name: "Self Review Check 1",
          description: "First check for self review",
          ordinal: 0,
          points: 5,
          is_annotation: true,
          is_comment_required: false,
          class_id: class_id,
          is_required: true,
          assignment_id: assignmentData.id,
          rubric_id: assignmentData.self_review_rubric_id || 0
        },
        {
          rubric_criteria_id: selfReviewCriteriaId || 0,
          name: "Self Review Check 2",
          description: "Second check for self review",
          ordinal: 1,
          points: 5,
          is_annotation: false,
          is_comment_required: false,
          class_id: class_id,
          is_required: true,
          assignment_id: assignmentData.id,
          rubric_id: assignmentData.self_review_rubric_id || 0
        },
        {
          rubric_criteria_id: gradingReviewCriteriaId || 0,
          name: "Grading Review Check 1",
          description: "First check for grading review",
          ordinal: 0,
          points: 10,
          is_annotation: true,
          is_comment_required: false,
          class_id: class_id,
          is_required: true,
          assignment_id: assignmentData.id,
          rubric_id: assignmentData.grading_rubric_id || 0
        },
        {
          rubric_criteria_id: gradingReviewCriteriaId || 0,
          name: "Grading Review Check 2",
          description: "Second check for grading review",
          ordinal: 1,
          points: 10,
          is_annotation: false,
          is_comment_required: false,
          class_id: class_id,
          is_required: true,
          assignment_id: assignmentData.id,
          rubric_id: assignmentData.grading_rubric_id || 0
        },
        {
          rubric_criteria_id: gradingReviewCriteriaId2 || 0,
          name: "Grading Review Check 3",
          description: "Third check for grading review",
          ordinal: 2,
          points: 10,
          is_annotation: false,
          is_comment_required: false,
          class_id: class_id,
          is_required: true,
          assignment_id: assignmentData.id,
          rubric_id: assignmentData.grading_rubric_id || 0
        }
      ])
      .select("*")
  );
  if (rubricChecksError) {
    throw new Error(`Failed to create rubric checks: ${rubricChecksError.message}`);
  }

  return { ...assignmentData, rubricParts: partsData.data, rubricChecks: rubricChecksData };
}

export async function insertSubmissionViaAPI({
  student_profile_id,
  assignment_group_id,
  sha,
  commit_message,
  assignment_id = 1,
  class_id,
  repositorySuffix,
  timestampOverride,
  rateLimitManager
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  sha?: string;
  commit_message?: string;
  assignment_id?: number;
  class_id: number;
  repositorySuffix?: string;
  timestampOverride?: number;
  rateLimitManager?: RateLimitManager;
}): Promise<{
  submission_id: number;
  repository_name: string;
}> {
  const test_run_batch = repositorySuffix ?? "abcd" + Math.random().toString(36).substring(2, 15);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
  const timestamp = timestampOverride ?? Date.now();
  const studentId = student_profile_id?.slice(0, 8) || "no-student";
  const assignmentStr = assignment_id || 1;
  const repository = `pawtograder-playground/test-e2e-student-repo-java--${test_run_batch}-${workerIndex}-${assignmentStr}-${studentId}-${timestamp}`;
  const { data: repositoryDataList, error: repositoryError } = await (
    rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
  ).trackAndLimit("repositories", () =>
    supabase
      .from("repositories")
      .insert({
        assignment_id: assignment_id,
        repository: repository,
        class_id: class_id,
        assignment_group_id,
        profile_id: student_profile_id,
        synced_handout_sha: "none"
      })
      .select("id")
  );
  if (repositoryError) {
    throw new Error(`Failed to create repository: ${repositoryError.message}`);
  }
  const repositoryData = repositoryDataList[0];
  const repository_id = repositoryData?.id;

  const { error: checkRunError } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
    "repository_check_runs",
    () =>
      supabase
        .from("repository_check_runs")
        .insert({
          class_id: class_id,
          repository_id: repository_id,
          check_run_id: 1,
          status: "{}",
          sha: sha || "HEAD",
          commit_message: commit_message || "none"
        })
        .select("id")
  );
  if (checkRunError) {
    // eslint-disable-next-line no-console
    console.error(checkRunError);
    throw new Error("Failed to create check run");
  }
  // Prepare a JWT token to invoke the edge function
  const payload = {
    repository: repository,
    sha: sha || "HEAD",
    workflow_ref: ".github/workflows/grade.yml-e2e-test",
    run_id: 1,
    run_attempt: 1
  };
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: process.env.END_TO_END_SECRET || "not-a-secret"
  };
  const token_str =
    Buffer.from(JSON.stringify(header)).toString("base64") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64") +
    ".";
  const { data } = await supabase.functions.invoke("autograder-create-submission", {
    headers: {
      Authorization: token_str
    }
  });
  if (data == null) {
    throw new Error("Failed to create submission, no data returned");
  }
  if ("error" in data) {
    if (typeof data.error === "object" && data.error && "details" in data.error) {
      throw new Error(String((data.error as { details: string }).details));
    }
    throw new Error("Failed to create submission");
  }
  return {
    repository_name: repository,
    submission_id: (data as { submission_id: number }).submission_id
  };
}

export type GradingScriptResult = {
  ret_code: number;
  output: string;
  execution_time: number;
  feedback: {
    score?: number;
    max_score?: number;
    output: {
      hidden?: { output: string; output_format?: "text" | "markdown" | "ansi" };
      visible?: { output: string; output_format?: "text" | "markdown" | "ansi" };
      after_due_date?: { output: string; output_format?: "text" | "markdown" | "ansi" };
      after_published?: { output: string; output_format?: "text" | "markdown" | "ansi" };
    };
    lint: {
      status: "pass" | "fail";
      output: string;
      output_format?: "text" | "markdown" | "ansi";
    };
    tests: {
      score?: number;
      max_score?: number;
      name: string;
      name_format?: "text" | "markdown" | "ansi";
      output: string;
      output_format?: "text" | "markdown" | "ansi";
      hidden_output?: string;
      hidden_output_format?: "text" | "markdown" | "ansi";
      part?: string;
      hide_until_released?: boolean;
    }[];
  };
  grader_sha: string;
  action_ref: string;
  action_repository: string;
};

export type GradeResponse = {
  is_ok: boolean;
  message: string;
  details_url: string;
  artifacts?: {
    name: string;
    path: string;
    token: string;
  }[];
  supabase_url: string;
  supabase_anon_key: string;
};

/**
 * Submits feedback for a submission via the autograder-submit-feedback edge function.
 * This simulates what the grading script does after grading completes.
 */
export async function submitFeedbackViaAPI({
  repository,
  sha,
  run_id = 1,
  run_attempt = 1,
  feedback
}: {
  repository: string;
  sha: string;
  run_id?: number;
  run_attempt?: number;
  feedback: GradingScriptResult;
}): Promise<GradeResponse> {
  // Prepare a JWT token to invoke the edge function (same format as insertSubmissionViaAPI)
  const payload = {
    repository: repository,
    sha: sha,
    workflow_ref: ".github/workflows/grade.yml-e2e-test",
    run_id: run_id,
    run_attempt: run_attempt
  };
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: process.env.END_TO_END_SECRET || "not-a-secret"
  };
  const token_str =
    Buffer.from(JSON.stringify(header)).toString("base64") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64") +
    ".";

  const { data, error } = await supabase.functions.invoke("autograder-submit-feedback", {
    headers: {
      Authorization: token_str
    },
    body: feedback
  });

  if (error) {
    throw new Error(`Failed to submit feedback: ${error.message}`);
  }

  if (data == null) {
    throw new Error("Failed to submit feedback, no data returned");
  }

  if ("error" in data) {
    if (typeof data.error === "object" && data.error && "details" in data.error) {
      console.trace(data);
      throw new Error(String((data.error as { details: string }).details));
    }
    throw new Error(`Failed to submit feedback: ${JSON.stringify(data.error)}`);
  }

  return data as GradeResponse;
}

/**
 * Creates a sample GradingScriptResult with reasonable test data
 */
export function createSampleGradingResult(overrides?: Partial<GradingScriptResult>): GradingScriptResult {
  return {
    ret_code: 0,
    output: "Grading completed successfully",
    execution_time: 5000,
    grader_sha: "abc123gradersha",
    action_ref: "main",
    action_repository: "pawtograder/assignment-action",
    feedback: {
      score: 85,
      max_score: 100,
      output: {
        visible: {
          output: "All visible tests passed!",
          output_format: "text"
        },
        hidden: {
          output: "Hidden test details here",
          output_format: "text"
        }
      },
      lint: {
        status: "pass",
        output: "No linting errors found",
        output_format: "text"
      },
      tests: [
        {
          name: "Test 1 - Basic functionality",
          score: 25,
          max_score: 25,
          output: "Test passed successfully",
          output_format: "text",
          part: "Part A"
        },
        {
          name: "Test 2 - Edge cases",
          score: 20,
          max_score: 25,
          output: "Partial credit: missed one edge case",
          output_format: "text",
          part: "Part A"
        },
        {
          name: "Test 3 - Performance",
          score: 25,
          max_score: 25,
          output: "Performance within acceptable limits",
          output_format: "text",
          part: "Part B"
        },
        {
          name: "Test 4 - Hidden test",
          score: 15,
          max_score: 25,
          output: "Hidden test result",
          output_format: "text",
          hidden_output: "Detailed hidden output for instructors",
          hidden_output_format: "text",
          hide_until_released: true,
          part: "Part B"
        }
      ]
    },
    ...overrides
  };
}

export async function createDueDateException(
  assignment_id: number,
  student_profile_id: string,
  class_id: number,
  hoursExtension: number
) {
  const { data: exceptionData, error: exceptionError } = await supabase
    .from("assignment_due_date_exceptions")
    .insert({
      class_id: class_id,
      assignment_id: assignment_id,
      student_id: student_profile_id,
      creator_id: student_profile_id,
      hours: hoursExtension,
      minutes: 0,
      tokens_consumed: Math.ceil(hoursExtension / 24)
    })
    .select("*")
    .single();

  if (exceptionError) {
    throw new Error(`Failed to create due date exception: ${exceptionError.message}`);
  }
  return exceptionData;
}

export async function createRegradeRequest(
  submission_id: number,
  assignment_id: number,
  student_profile_id: string,
  grader_profile_id: string,
  rubric_check_id: number,
  class_id: number,
  status: "opened" | "resolved" | "closed",
  options?: {
    commentPoints?: number;
    initialPoints?: number;
    resolvedPoints?: number;
    closedPoints?: number;
  }
) {
  // First create a submission comment to reference
  const { data: commentData, error: commentError } = await supabase
    .from("submission_comments")
    .insert({
      submission_id: submission_id,
      author: grader_profile_id,
      comment: "Test comment for regrade request",
      points: options?.commentPoints ?? Math.floor(Math.random() * 10),
      class_id: class_id,
      rubric_check_id,
      released: true
    })
    .select("*")
    .single();

  if (commentError) {
    throw new Error(`Failed to create submission comment: ${commentError.message}`);
  }

  const { data: regradeData, error: regradeError } = await supabase
    .from("submission_regrade_requests")
    .insert({
      submission_id: submission_id,
      class_id: class_id,
      assignment_id: assignment_id,
      opened_at: new Date().toISOString(),
      created_by: student_profile_id,
      assignee: grader_profile_id,
      closed_by: status === "closed" ? grader_profile_id : null,
      closed_at: status === "closed" ? new Date().toISOString() : null,
      status: status,
      resolved_by: status === "resolved" || status === "closed" ? grader_profile_id : null,
      resolved_at: status === "resolved" || status === "closed" ? new Date().toISOString() : null,
      submission_comment_id: commentData.id, // Reference the comment we just created
      initial_points: options?.initialPoints ?? Math.floor(Math.random() * 100),
      resolved_points:
        status === "resolved" || status === "closed"
          ? (options?.resolvedPoints ?? Math.floor(Math.random() * 100))
          : null,
      closed_points: status === "closed" ? (options?.closedPoints ?? Math.floor(Math.random() * 100)) : null,
      last_updated_at: new Date().toISOString()
    })
    .select("*")
    .single();

  if (regradeError) {
    throw new Error(`Failed to create regrade request: ${regradeError.message}`);
  }
  //Update the comment to reference the regrade request
  const { error: commentUpdateError } = await supabase
    .from("submission_comments")
    .update({ regrade_request_id: regradeData.id })
    .eq("id", commentData.id);
  if (commentUpdateError) {
    throw new Error(`Failed to update submission comment: ${commentUpdateError.message}`);
  }

  return regradeData;
}

export async function gradeSubmission(
  grading_review_id: number,
  grader_profile_id: string,
  isCompleted: boolean,
  options?: {
    checkApplyChance?: number; // Probability (0-1) that non-required checks are applied
    pointsRandomizer?: () => number; // Function to generate random points (0-1)
    fileSelectionRandomizer?: () => number; // Function to select file index (0-1)
    lineNumberRandomizer?: () => number; // Function to generate line numbers (returns 1-5)
    totalScoreOverride?: number;
    totalAutogradeScoreOverride?: number;
    rateLimitManager?: RateLimitManager;
  }
) {
  // Get the submission review details to find the rubric and submission
  const { data: reviewInfo, error: reviewError } = await supabase
    .from("submission_reviews")
    .select("id, submission_id, rubric_id, class_id")
    .eq("id", grading_review_id)
    .single();

  if (reviewError || !reviewInfo) {
    throw new Error(`Failed to get submission review: ${reviewError?.message}`);
  }

  if (isCompleted) {
    // Get all rubric checks for this rubric
    const { data: rubricChecks, error: checksError } = await supabase
      .from("rubric_checks")
      .select(
        `
        id, name, is_annotation, points, is_required, file,
        rubric_criteria!inner(id, rubric_id)
      `
      )
      .eq("rubric_criteria.rubric_id", reviewInfo.rubric_id);

    if (checksError) {
      throw new Error(`Failed to get rubric checks: ${checksError.message}`);
    }

    // Get submission files for annotation comments
    const { data: submissionFiles } = await supabase
      .from("submission_files")
      .select("id, name")
      .eq("submission_id", reviewInfo.submission_id);

    // Create comments for each rubric check
    for (const check of rubricChecks || []) {
      // Use provided chance or default 80% chance to apply non-required checks, 100% for required ones
      const applyChance = options?.checkApplyChance ?? 0.8;
      const shouldApply = check.is_required || Math.random() < applyChance;

      if (shouldApply) {
        const randomValue = options?.pointsRandomizer?.() ?? Math.random();
        const pointsAwarded = Math.floor(randomValue * (check.points + 1)); // 0 to max points

        if (check.is_annotation) {
          // Create submission file comment (annotation)
          let file_id = null;

          if (check.file && submissionFiles) {
            const matchingFile = submissionFiles.find((f) => f.name === check.file);
            file_id = matchingFile?.id || submissionFiles[0]?.id; // Use specified file or first available
          } else if (submissionFiles && submissionFiles.length > 0) {
            const fileRandomValue = options?.fileSelectionRandomizer?.() ?? Math.random();
            file_id = submissionFiles[Math.floor(fileRandomValue * submissionFiles.length)].id;
          }

          if (file_id) {
            const lineRandomValue = options?.lineNumberRandomizer?.() ?? Math.random();
            const lineNumber = Math.floor(lineRandomValue * 5) + 1; // Random line number 1-5

            await (options?.rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
              "submission_file_comments",
              () =>
                supabase
                  .from("submission_file_comments")
                  .insert({
                    submission_id: reviewInfo.submission_id,
                    submission_file_id: file_id,
                    author: grader_profile_id,
                    comment: `${check.name}: Grading comment for this check`,
                    points: pointsAwarded,
                    line: lineNumber,
                    class_id: reviewInfo.class_id,
                    released: true,
                    rubric_check_id: check.id,
                    submission_review_id: grading_review_id
                  })
                  .select("id")
            );
          }
        } else {
          // Create submission comment (general comment)
          await (options?.rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("submission_comments", () =>
            supabase
              .from("submission_comments")
              .insert({
                submission_id: reviewInfo.submission_id,
                author: grader_profile_id,
                comment: `${check.name}: ${pointsAwarded}/${check.points} points - ${check.name.includes("quality") ? "Good work on this aspect!" : "Applied this grading criteria"}`,
                points: pointsAwarded,
                class_id: reviewInfo.class_id,
                released: true,
                rubric_check_id: check.id,
                submission_review_id: grading_review_id
              })
              .select("id")
          );
        }
      }
    }
  }

  // Update the submission review
  const totalScore = options?.totalScoreOverride ?? (isCompleted ? Math.floor(Math.random() * 100) : 0);
  const totalAutogradeScore = options?.totalAutogradeScoreOverride ?? Math.floor(Math.random() * 100);

  const updateData = {
    grader: grader_profile_id,
    total_score: totalScore,
    released: isCompleted,
    completed_by: isCompleted ? grader_profile_id : null,
    completed_at: isCompleted ? new Date().toISOString() : null,
    total_autograde_score: totalAutogradeScore
  };

  const { data: reviewResult, error: updateError } = await supabase
    .from("submission_reviews")
    .update(updateData)
    .eq("id", grading_review_id)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Failed to update submission review: ${updateError.message}`);
  }

  return reviewResult;
}

/**
 * Creates assignments and gradebook columns for testing purposes
 * @param options Configuration options for creating assignments and gradebook columns
 * @returns Object containing created assignments, gradebook columns, and other relevant data
 */
export async function createAssignmentsAndGradebookColumns({
  class_id,
  numAssignments = 5,
  numManualGradedColumns = 2,
  manualGradedColumnSlugs = [],
  assignmentDateRange = { start: new Date(), end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  rubricConfig = {
    minPartsPerAssignment: 2,
    maxPartsPerAssignment: 3,
    minCriteriaPerPart: 1,
    maxCriteriaPerPart: 2,
    minChecksPerCriteria: 2,
    maxChecksPerCriteria: 3
  },
  groupConfig = "individual" as "individual" | "groups" | "both"
}: {
  class_id: number;
  numAssignments?: number;
  numManualGradedColumns?: number;
  manualGradedColumnSlugs?: string[];
  assignmentDateRange?: { start: Date; end: Date };
  rubricConfig?: {
    minPartsPerAssignment: number;
    maxPartsPerAssignment: number;
    minCriteriaPerPart: number;
    maxCriteriaPerPart: number;
    minChecksPerCriteria: number;
    maxChecksPerCriteria: number;
  };
  groupConfig?: "individual" | "groups" | "both";
}): Promise<{
  assignments: Array<{
    id: number;
    title: string;
    slug: string;
    due_date: string;
    group_config: string;
    rubricChecks: Array<{ id: number; name: string; points: number; [key: string]: unknown }>;
    rubricParts: Array<{ id: number; name: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  gradebookColumns: Array<{
    id: number;
    name: string;
    slug: string;
    max_score: number | null;
    score_expression: string | null;
    sort_order: number | null;
  }>;
  manualGradedColumns: Array<{
    id: number;
    name: string;
    slug: string;
    max_score: number | null;
    score_expression: string | null;
    sort_order: number | null;
  }>;
}> {
  // Import required dependencies
  const { addDays } = await import("date-fns");
  const { all, create } = await import("mathjs");
  const { minimatch } = await import("minimatch");

  // Define interfaces for mathjs node types to avoid using 'any'
  interface MathJSNode {
    type: string;
    traverse: (callback: (node: MathJSNode) => void) => void;
  }

  interface FunctionNode extends MathJSNode {
    type: "FunctionNode";
    fn: { name: string };
    args: MathJSNode[];
  }

  interface ConstantNode extends MathJSNode {
    type: "ConstantNode";
    value: unknown;
  }

  // Helper function to extract dependencies from score expressions
  function extractDependenciesFromExpression(
    expr: string,
    availableAssignments: Array<{ id: number; slug: string }>,
    availableColumns: Array<{ id: number; slug: string }>
  ): { assignments?: number[]; gradebook_columns?: number[] } | null {
    if (!expr) return null;

    const math = create(all);
    const dependencies: Record<string, Set<number>> = {};
    const errors: string[] = [];

    try {
      const exprNode = math.parse(expr) as MathJSNode;
      const availableDependencies = {
        assignments: availableAssignments,
        gradebook_columns: availableColumns
      };

      exprNode.traverse((node: MathJSNode) => {
        if (node.type === "FunctionNode") {
          const functionNode = node as FunctionNode;
          const functionName = functionNode.fn.name;
          if (functionName in availableDependencies) {
            const args = functionNode.args;
            const firstArg = args[0];
            if (firstArg && firstArg.type === "ConstantNode") {
              const constantNode = firstArg as ConstantNode;
              const argName = constantNode.value;
              if (typeof argName === "string") {
                const matching = availableDependencies[functionName as keyof typeof availableDependencies].filter((d) =>
                  minimatch(d.slug!, argName)
                );
                if (matching.length > 0) {
                  if (!(functionName in dependencies)) {
                    dependencies[functionName] = new Set();
                  }
                  matching.forEach((d) => dependencies[functionName].add(d.id));
                } else {
                  errors.push(`Invalid dependency: ${argName} for function ${functionName}`);
                }
              }
            }
          }
        }
      });

      if (errors.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`Dependency extraction warnings for expression "${expr}": ${errors.join(", ")}`);
      }

      // Flatten the dependencies
      const flattenedDependencies: Record<string, number[]> = {};
      for (const [functionName, ids] of Object.entries(dependencies)) {
        flattenedDependencies[functionName] = Array.from(ids);
      }

      if (Object.keys(flattenedDependencies).length === 0) {
        return null;
      }
      return flattenedDependencies;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to parse expression "${expr}": ${error}`);
      throw error;
    }
  }

  // Helper function to create gradebook column
  async function createGradebookColumn({
    class_id,
    name,
    description,
    slug,
    max_score,
    score_expression,
    dependencies,
    released = false,
    sort_order,
    rateLimitManager
  }: {
    class_id: number;
    name: string;
    description?: string;
    slug: string;
    max_score?: number;
    score_expression?: string;
    dependencies?: { assignments?: number[]; gradebook_columns?: number[] };
    released?: boolean;
    sort_order?: number;
    rateLimitManager?: RateLimitManager;
  }): Promise<{
    id: number;
    name: string;
    slug: string;
    max_score: number | null;
    score_expression: string | null;
    sort_order: number | null;
  }> {
    // Get the gradebook for this class
    const { data: gradebookList, error: gradebookError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("gradebooks", () => supabase.from("gradebooks").select("id").eq("class_id", class_id));

    const gradebook = gradebookList[0];
    if (gradebookError || !gradebook) {
      throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
    }

    // Get available assignments and columns for dependency extraction
    const { data: assignments } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
      "assignments",
      () => supabase.from("assignments").select("id, slug").eq("class_id", class_id)
    );

    const { data: existingColumns } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
      "gradebook_columns",
      () => supabase.from("gradebook_columns").select("id, slug").eq("class_id", class_id)
    );

    // Filter out items with null slugs and cast to proper types
    const validAssignments = (assignments || []).filter((a: { slug: string | null }) => a.slug !== null) as Array<{
      id: number;
      slug: string;
    }>;
    const validColumns = (existingColumns || []).filter((c: { slug: string | null }) => c.slug !== null) as Array<{
      id: number;
      slug: string;
    }>;

    // Extract dependencies from score expression if not provided
    let finalDependencies = dependencies;
    if (score_expression && !dependencies) {
      const extractedDeps = extractDependenciesFromExpression(score_expression, validAssignments, validColumns);
      if (extractedDeps) {
        finalDependencies = extractedDeps;
      }
    }

    // Create the gradebook column
    const { data: columnList, error: columnError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("gradebook_columns", () =>
      supabase
        .from("gradebook_columns")
        .insert({
          class_id,
          gradebook_id: gradebook.id,
          name,
          description,
          slug,
          max_score,
          score_expression,
          dependencies: finalDependencies ? finalDependencies : null,
          released,
          sort_order
        })
        .select("id, name, slug, max_score, score_expression, sort_order")
    );

    if (columnError) {
      throw new Error(`Failed to create gradebook column ${name}: ${columnError.message}`);
    }

    const column = columnList[0];
    return column;
  }

  // Rubric part templates for generating diverse rubrics
  const RUBRIC_PART_TEMPLATES = [
    {
      name: "Code Quality",
      description: "Assessment of code structure, style, and best practices",
      criteria: [
        {
          name: "Code Style & Formatting",
          description: "Proper indentation, naming conventions, and formatting",
          points: [3, 5, 8],
          checks: [
            { name: "Consistent Indentation", points: [1, 2], isAnnotation: true },
            { name: "Meaningful Variable Names", points: [2, 3], isAnnotation: true },
            { name: "Proper Code Comments", points: [1, 2, 3], isAnnotation: false }
          ]
        },
        {
          name: "Code Organization",
          description: "Logical structure and separation of concerns",
          points: [5, 8, 10],
          checks: [
            { name: "Function Decomposition", points: [2, 3, 4], isAnnotation: true },
            { name: "Class Structure", points: [2, 3], isAnnotation: true },
            { name: "Code Modularity", points: [1, 2, 3], isAnnotation: false }
          ]
        }
      ]
    },
    {
      name: "Algorithm Implementation",
      description: "Correctness and efficiency of algorithmic solutions",
      criteria: [
        {
          name: "Correctness",
          description: "Implementation correctly solves the problem",
          points: [15, 20, 25],
          checks: [
            { name: "Handles Base Cases", points: [3, 5], isAnnotation: true },
            { name: "Correct Logic Flow", points: [5, 8, 10], isAnnotation: true },
            { name: "Edge Case Handling", points: [2, 4, 5], isAnnotation: false }
          ]
        },
        {
          name: "Efficiency",
          description: "Time and space complexity considerations",
          points: [8, 12, 15],
          checks: [
            { name: "Optimal Time Complexity", points: [3, 5, 7], isAnnotation: false },
            { name: "Memory Usage", points: [2, 3, 4], isAnnotation: true },
            { name: "Algorithm Choice", points: [2, 3, 4], isAnnotation: false }
          ]
        }
      ]
    },
    {
      name: "Testing & Documentation",
      description: "Quality of tests and documentation provided",
      criteria: [
        {
          name: "Test Coverage",
          description: "Comprehensive testing of functionality",
          points: [10, 15],
          checks: [
            { name: "Unit Tests Present", points: [3, 5], isAnnotation: false },
            { name: "Test Edge Cases", points: [2, 4], isAnnotation: true },
            { name: "Test Documentation", points: [2, 3], isAnnotation: false }
          ]
        },
        {
          name: "Documentation Quality",
          description: "Clear and comprehensive documentation",
          points: [8, 12],
          checks: [
            { name: "README Completeness", points: [2, 4], isAnnotation: false },
            { name: "API Documentation", points: [2, 3, 4], isAnnotation: true },
            { name: "Usage Examples", points: [1, 2, 3], isAnnotation: false }
          ]
        }
      ]
    }
  ];

  // Helper function to generate random rubric structure (deterministic based on assignment index)
  function generateRubricStructure(assignmentIndex: number, config: typeof rubricConfig) {
    // Use assignment index to seed a deterministic random number generator
    let seed = assignmentIndex * 12345 + 67890;
    const random = (min: number, max: number) => {
      const x = Math.sin(seed++) * 10000;
      return Math.floor((x - Math.floor(x)) * (max - min + 1)) + min;
    };

    const numParts = random(config.minPartsPerAssignment, config.maxPartsPerAssignment);

    // Shuffle and select random rubric parts deterministically
    const shuffledTemplates = [...RUBRIC_PART_TEMPLATES].sort((a, b) => {
      const aHash = a.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const bHash = b.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return (
        ((aHash + assignmentIndex) % RUBRIC_PART_TEMPLATES.length) -
        ((bHash + assignmentIndex) % RUBRIC_PART_TEMPLATES.length)
      );
    });
    const selectedParts = shuffledTemplates.slice(0, Math.min(numParts, RUBRIC_PART_TEMPLATES.length));

    return selectedParts.map((partTemplate, partIndex) => {
      const numCriteria = random(config.minCriteriaPerPart, config.maxCriteriaPerPart);
      const selectedCriteria = partTemplate.criteria.slice(0, Math.min(numCriteria, partTemplate.criteria.length));

      return {
        ...partTemplate,
        ordinal: partIndex,
        criteria: selectedCriteria.map((criteriaTemplate, criteriaIndex) => {
          const numChecks = random(config.minChecksPerCriteria, config.maxChecksPerCriteria);
          const selectedChecks = criteriaTemplate.checks.slice(0, Math.min(numChecks, criteriaTemplate.checks.length));

          // Deterministically select points from the available options
          const criteriaPoints = criteriaTemplate.points[assignmentIndex % criteriaTemplate.points.length];

          return {
            ...criteriaTemplate,
            ordinal: criteriaIndex,
            total_points: criteriaPoints,
            checks: selectedChecks.map((checkTemplate, checkIndex) => {
              const checkPoints = checkTemplate.points[(assignmentIndex + checkIndex) % checkTemplate.points.length];
              return {
                ...checkTemplate,
                ordinal: checkIndex,
                points: checkPoints,
                is_annotation: checkTemplate.isAnnotation,
                is_comment_required: (assignmentIndex + checkIndex) % 3 === 0, // 33% chance
                is_required: (assignmentIndex + checkIndex) % 3 !== 0 // 67% chance
              };
            })
          };
        })
      };
    });
  }

  // Helper function to create assignment with rubric
  async function createAssignmentWithRubric({
    assignmentIndex,
    due_date,
    class_id,
    groupConfig,
    rateLimitManager
  }: {
    assignmentIndex: number;
    due_date: string;
    class_id: number;
    groupConfig: "individual" | "groups" | "both";
    rateLimitManager?: RateLimitManager;
  }): Promise<{
    id: number;
    title: string;
    slug: string;
    due_date: string;
    group_config: string;
    rubricChecks: Array<{ id: number; name: string; points: number; is_annotation: boolean; [key: string]: unknown }>;
    rubricParts: Array<{ id: number; name: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }> {
    const title = `Test Assignment ${assignmentIndex + 1}${groupConfig !== "individual" ? " (Group)" : ""}`;
    const slug = `assignment-${assignmentIndex + 1}`;

    // Create self review setting
    const { data: selfReviewSettingData, error: selfReviewSettingError } = await supabase
      .from("assignment_self_review_settings")
      .insert({
        class_id: class_id,
        enabled: true,
        deadline_offset: 2,
        allow_early: true
      })
      .select("id")
      .single();

    if (selfReviewSettingError) {
      throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
    }

    const self_review_setting_id = selfReviewSettingData.id;

    // Create assignment
    const { data: insertedAssignmentDataList, error: assignmentError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("assignments", () =>
      supabase
        .from("assignments")
        .insert({
          title: title,
          description: `Test assignment ${assignmentIndex + 1} with rubric`,
          due_date: due_date,
          template_repo: "pawtograder-playground/test-e2e-java-handout",
          autograder_points: 100,
          total_points: 100,
          max_late_tokens: 10,
          release_date: addDays(new Date(), -1).toUTCString(),
          class_id: class_id,
          slug: slug,
          group_config: groupConfig,
          allow_not_graded_submissions: false,
          self_review_setting_id: self_review_setting_id,
          max_group_size: 6,
          group_formation_deadline: addDays(new Date(), -1).toUTCString()
        })
        .select("id")
    );

    if (assignmentError) {
      throw new Error(`Failed to create assignment: ${assignmentError.message}`);
    }

    const insertedAssignmentData = insertedAssignmentDataList[0];
    // Get assignment data
    const { data: assignmentDataList } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
      "assignments",
      () => supabase.from("assignments").select("*").eq("id", insertedAssignmentData.id)
    );

    const assignmentData = assignmentDataList[0];
    if (!assignmentData) {
      throw new Error("Failed to get assignment");
    }

    // Update autograder config
    await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit("autograder", () =>
      supabase
        .from("autograder")
        .update({
          config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
        })
        .eq("id", assignmentData.id)
        .select("id")
    );

    // Generate rubric structure deterministically
    const rubricStructure = generateRubricStructure(assignmentIndex, rubricConfig);

    // Create self-review rubric parts
    const selfReviewPart = {
      name: "Self Review",
      description: "Student self-assessment of their work",
      ordinal: 0,
      criteria: [
        {
          name: "Self Reflection",
          description: "Quality of self-assessment and reflection",
          ordinal: 0,
          total_points: 10,
          checks: [
            {
              name: "Completeness of Self Review",
              ordinal: 0,
              points: 5,
              is_annotation: false,
              is_comment_required: false,
              is_required: true
            },
            {
              name: "Depth of Reflection",
              ordinal: 1,
              points: 5,
              is_annotation: false,
              is_comment_required: true,
              is_required: true
            }
          ]
        }
      ]
    };

    // Combine self-review with generated structure for grading rubric
    const allParts = [selfReviewPart, ...rubricStructure.map((part) => ({ ...part, ordinal: part.ordinal + 1 }))];

    // Create rubric parts
    const createdParts = [];
    const allRubricChecks = [];

    for (const partTemplate of allParts) {
      const isGradingPart = partTemplate.name !== "Self Review";
      const rubricId = isGradingPart ? assignmentData.grading_rubric_id : assignmentData.self_review_rubric_id;

      const { data: partDataList, error: partError } = await (
        rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
      ).trackAndLimit("rubric_parts", () =>
        supabase
          .from("rubric_parts")
          .insert({
            class_id: class_id,
            name: partTemplate.name,
            description: partTemplate.description,
            ordinal: partTemplate.ordinal,
            rubric_id: rubricId || 0,
            assignment_id: assignmentData.id
          })
          .select("id")
      );

      if (partError) {
        throw new Error(`Failed to create rubric part: ${partError.message}`);
      }

      const partData = partDataList[0];
      createdParts.push({ ...partTemplate, id: partData.id, rubric_id: rubricId });

      // Create criteria for this part
      for (const criteriaTemplate of partTemplate.criteria) {
        const { data: criteriaDataList, error: criteriaError } = await (
          rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
        ).trackAndLimit("rubric_criteria", () =>
          supabase
            .from("rubric_criteria")
            .insert({
              class_id: class_id,
              name: criteriaTemplate.name,
              description: criteriaTemplate.description,
              ordinal: criteriaTemplate.ordinal,
              total_points: criteriaTemplate.total_points,
              is_additive: true,
              rubric_part_id: partData.id,
              rubric_id: rubricId || 0,
              assignment_id: assignmentData.id
            })
            .select("id")
        );

        if (criteriaError) {
          throw new Error(`Failed to create rubric criteria: ${criteriaError.message}`);
        }

        const criteriaData = criteriaDataList[0];
        // Create checks for this criteria
        for (const checkTemplate of criteriaTemplate.checks) {
          const { data: checkDataList, error: checkError } = await (
            rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
          ).trackAndLimit("rubric_checks", () =>
            supabase
              .from("rubric_checks")
              .insert({
                rubric_criteria_id: criteriaData.id,
                name: checkTemplate.name,
                description: `${checkTemplate.name} evaluation`,
                ordinal: checkTemplate.ordinal,
                points: checkTemplate.points,
                is_annotation: checkTemplate.is_annotation,
                is_comment_required: checkTemplate.is_comment_required,
                class_id: class_id,
                is_required: checkTemplate.is_required,
                assignment_id: assignmentData.id,
                rubric_id: rubricId || 0
              })
              .select("*")
          );

          if (checkError) {
            throw new Error(`Failed to create rubric check: ${checkError.message}`);
          }

          const checkData = checkDataList[0];
          allRubricChecks.push(checkData);
        }
      }
    }

    return {
      ...assignmentData,
      rubricChecks: allRubricChecks,
      rubricParts: createdParts,
      due_date: assignmentData.due_date,
      slug: assignmentData.slug || `assignment-${assignmentIndex + 1}`
    } as {
      id: number;
      title: string;
      slug: string;
      due_date: string;
      group_config: string;
      rubricChecks: Array<{ id: number; name: string; points: number; is_annotation: boolean; [key: string]: unknown }>;
      rubricParts: Array<{ id: number; name: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
  }

  // Helper function to set deterministic scores for gradebook columns
  async function setGradebookColumnScores({
    class_id,
    gradebook_column_id,
    students,
    baseScore,
    variation = 10,
    rateLimitManager
  }: {
    class_id: number;
    gradebook_column_id: number;
    students: TestingUser[];
    baseScore: number;
    variation?: number;
    rateLimitManager?: RateLimitManager;
  }): Promise<void> {
    // Get the gradebook_id for this class
    const { data: gradebookList, error: gradebookError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("gradebooks", () => supabase.from("gradebooks").select("id").eq("class_id", class_id));

    const gradebook = gradebookList[0];
    if (gradebookError || !gradebook) {
      throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
    }

    // Get existing gradebook column student records
    const { data: existingRecords, error: fetchError } = await (
      rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER
    ).trackAndLimit("gradebook_column_students", () =>
      supabase
        .from("gradebook_column_students")
        .select("id, student_id")
        .eq("gradebook_column_id", gradebook_column_id)
        .eq("is_private", true)
    );

    if (fetchError) {
      throw new Error(`Failed to fetch existing gradebook column students: ${fetchError.message}`);
    }

    if (!existingRecords || existingRecords.length === 0) {
      throw new Error(`No existing gradebook column student records found for column ${gradebook_column_id}`);
    }

    // Generate deterministic scores for each student
    const updatePromises = students.map(async (student, index) => {
      const existingRecord = existingRecords.find(
        (record: { student_id: string }) => record.student_id === student.private_profile_id
      );
      if (!existingRecord) {
        // eslint-disable-next-line no-console
        console.warn(`No gradebook column student record found for student ${student.email}`);
        return;
      }

      // Generate deterministic score based on student index and base score
      const score = Math.max(0, Math.min(100, baseScore + (index % variation) - variation / 2));

      const { error: updateError } = await (rateLimitManager ?? DEFAULT_RATE_LIMIT_MANAGER).trackAndLimit(
        "gradebook_column_students",
        () =>
          supabase.from("gradebook_column_students").update({ score: score }).eq("id", existingRecord.id).select("id")
      );

      if (updateError) {
        throw new Error(`Failed to update score for student ${student.email}: ${updateError.message}`);
      }
    });

    await Promise.all(updatePromises);
  }

  // Calculate evenly spaced dates between start and end
  const timeDiff = assignmentDateRange.end.getTime() - assignmentDateRange.start.getTime();
  const timeStep = timeDiff / (numAssignments - 1);

  // Create assignments
  const assignments = [];
  for (let i = 0; i < numAssignments; i++) {
    const assignmentDate = new Date(assignmentDateRange.start.getTime() + timeStep * i);

    const assignment = await createAssignmentWithRubric({
      assignmentIndex: i,
      due_date: assignmentDate.toISOString(),
      class_id,
      groupConfig,
      rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
    });

    assignments.push(assignment);
  }

  // Create gradebook columns
  const gradebookColumns = [];
  const manualGradedColumns = [];

  // Create manual graded columns
  for (let i = 1; i <= numManualGradedColumns; i++) {
    const columnName = `Manual Grade ${i}`;
    const columnSlug = `manual-grade-${i}`;

    const manualColumn = await createGradebookColumn({
      class_id,
      name: columnName,
      description: `Manual grading column ${i}`,
      slug: columnSlug,
      max_score: 100,
      sort_order: 1000 + i,
      rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
    });

    manualGradedColumns.push(manualColumn);
    gradebookColumns.push(manualColumn);
  }

  // Create standard gradebook columns
  const participationColumn = await createGradebookColumn({
    class_id,
    name: "Participation",
    description: "Overall class participation score",
    slug: "participation",
    max_score: 100,
    sort_order: 1000,
    rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
  });

  const averageAssignmentsColumn = await createGradebookColumn({
    class_id,
    name: "Average Assignments",
    description: "Average of all assignments",
    slug: "average-assignments",
    score_expression: "mean(gradebook_columns('assignment-assignment-*'))",
    max_score: 100,
    sort_order: 2,
    rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
  });

  // const averageLabAssignmentsColumn = await createGradebookColumn({
  //   class_id,
  //   name: "Average Lab Assignments",
  //   description: "Average of all lab assignments",
  //   slug: "average-lab-assignments",
  //   score_expression: "mean(gradebook_columns('assignment-lab-*'))",
  //   max_score: 100,
  //   sort_order: 3,
  //   rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
  // });

  const finalGradeColumn = await createGradebookColumn({
    class_id,
    name: "Final Grade",
    description: "Calculated final grade",
    slug: "final-grade",
    score_expression: "gradebook_columns('average-assignments') * 0.9 + gradebook_columns('participation') * 0.1",
    max_score: 100,
    sort_order: 999,
    rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
  });

  gradebookColumns.push(participationColumn, averageAssignmentsColumn, finalGradeColumn);

  // Get students for manual grading
  const { data: students } = await supabase
    .from("user_roles")
    .select(
      "private_profile_id, public_profile_id, user_id, profiles_private:profiles!private_profile_id(name), profiles_public:profiles!public_profile_id(name), users(email)"
    )
    .eq("class_id", class_id)
    .eq("role", "student")
    .order("users(email)", { ascending: true });

  if (students && students.length > 0) {
    // Transform the data to match TestingUser structure
    const transformedStudents: TestingUser[] = students.map((student) => ({
      private_profile_name: student.profiles_private?.name || `Student ${student.user_id}`,
      public_profile_name: student.profiles_public?.name || `Pseudonym ${student.user_id}`,
      email: student.users?.email || `student-${student.user_id}@pawtograder.net`,
      password: process.env.TEST_PASSWORD || "change-it",
      user_id: student.user_id,
      private_profile_id: student.private_profile_id,
      public_profile_id: student.public_profile_id,
      class_id: class_id
    }));

    // Set scores for columns that should have manual grades
    const columnsToGrade = gradebookColumns.filter((col) => manualGradedColumnSlugs.includes(col.slug));

    for (const column of columnsToGrade) {
      // Generate deterministic base score based on column slug
      const baseScore = (column.slug.split("-").reduce((acc, part) => acc + part.charCodeAt(0), 0) % 40) + 60; // 60-100 range

      await setGradebookColumnScores({
        class_id,
        gradebook_column_id: column.id,
        students: transformedStudents,
        baseScore,
        variation: 15,
        rateLimitManager: DEFAULT_RATE_LIMIT_MANAGER
      });
    }
  }

  return {
    assignments,
    gradebookColumns,
    manualGradedColumns
  };
}
