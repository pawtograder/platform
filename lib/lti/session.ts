/**
 * Bridge a validated LTI launch into a Pawtograder (Supabase) session.
 *
 * Approach: resolve/create the Supabase auth user for the launching LTI user,
 * mint a single-use magic-link token with the admin API, then redeem it on the
 * cookie-bound server client so the session cookies are written onto the
 * response. This reuses the same OTP machinery as email magic-link sign-in.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { LtiLaunchContext } from "./types";
import type { LtiDb } from "./db";

export class LtiSessionError extends Error {}

/** GoTrue reports a duplicate email via code `email_exists` or a message variant. */
function isEmailAlreadyRegistered(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "email_exists") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("already registered") || msg.includes("already been registered") || msg.includes("already exists")
  );
}

/**
 * @param serverClient cookie-bound client (utils/supabase/server) — receives the session
 * @param adminClient  service-role client — user lookup/creation + link minting
 */
export async function establishSupabaseSession(
  launch: LtiLaunchContext,
  serverClient: SupabaseClient<Database>,
  adminClient: LtiDb
): Promise<{ userId: string }> {
  const email = launch.email?.trim().toLowerCase();
  if (!email) {
    throw new LtiSessionError(
      "This LMS launch did not share an email address, which Pawtograder needs to sign you in. " +
        "Ask your administrator to enable email release for the Pawtograder LTI tool."
    );
  }

  // 1. Resolve existing Pawtograder user by email, else create an auth user.
  let userId: string | undefined;
  const { data: existingUser } = await adminClient.from("users").select("user_id").ilike("email", email).maybeSingle();
  userId = existingUser?.user_id;

  if (!userId) {
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { name: launch.name ?? null, lti_sub: launch.sub }
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (!isEmailAlreadyRegistered(createErr)) {
      throw new LtiSessionError(`Failed to provision account for ${email}: ${createErr?.message ?? "unknown"}`);
    }
    // Otherwise the auth user already exists without a matching public.users row
    // (e.g. a preview DB reset wipes `public` but not `auth`, orphaning prior
    // auth users). Resolve its id from generateLink below instead of failing.
  }

  // 2. Mint a magic-link token. For an existing user this also returns the user,
  //    which lets us resolve the id when createUser hit a duplicate email.
  const { data: link, error: linkErr } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email
  });
  if (linkErr || !link.properties?.hashed_token) {
    throw new LtiSessionError(`Failed to create sign-in link: ${linkErr?.message ?? "unknown"}`);
  }
  userId = userId ?? link.user?.id ?? undefined;
  if (!userId) {
    throw new LtiSessionError(`Failed to provision account for ${email}: could not resolve user`);
  }

  // 3. Record the LTI identity -> user mapping.
  await adminClient
    .from("lti_users")
    .update({ user_id: userId })
    .eq("platform_id", launch.platformId)
    .eq("sub", launch.sub);

  // 4. Redeem the magic link on the cookie-bound client to write the session.
  const { error: verifyErr } = await serverClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token
  });
  if (verifyErr) {
    throw new LtiSessionError(`Failed to establish session: ${verifyErr.message}`);
  }

  return { userId };
}

/** Where to send the user after a successful launch.
 *  `enrolled` guards against sending a user into /course/{classId} when they have
 *  no user_role there: the course layout redirects role-less users back to '/',
 *  so the launch would appear to work yet silently bounce. Land them on the home
 *  page with a hint instead. */
export function resolveLaunchRedirect(
  classId: number | null | undefined,
  launch: LtiLaunchContext,
  enrolled = true
): string {
  if (classId && enrolled) {
    // Allow the platform to deep-link a specific assignment via a custom param.
    const assignmentId = launch.custom?.assignment_id || launch.custom?.pawtograder_assignment_id;
    if (assignmentId && /^\d+$/.test(assignmentId)) {
      return `/course/${classId}/assignments/${assignmentId}`;
    }
    return `/course/${classId}`;
  }
  // Not linked to a class, or launched before a roster sync enrolled this user:
  // drop them on the home page with a hint rather than a course that bounces.
  return `/?lti_unlinked=1`;
}
