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
    if (createErr || !created.user) {
      throw new LtiSessionError(`Failed to provision account for ${email}: ${createErr?.message ?? "unknown"}`);
    }
    userId = created.user.id;
  }

  // 2. Record the LTI identity -> user mapping.
  await adminClient
    .from("lti_users")
    .update({ user_id: userId })
    .eq("platform_id", launch.platformId)
    .eq("sub", launch.sub);

  // 3. Mint a magic-link token and redeem it on the cookie-bound client.
  const { data: link, error: linkErr } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email
  });
  if (linkErr || !link.properties?.hashed_token) {
    throw new LtiSessionError(`Failed to create sign-in link: ${linkErr?.message ?? "unknown"}`);
  }

  const { error: verifyErr } = await serverClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token
  });
  if (verifyErr) {
    throw new LtiSessionError(`Failed to establish session: ${verifyErr.message}`);
  }

  return { userId };
}

/** Where to send the user after a successful launch. */
export function resolveLaunchRedirect(classId: number | null | undefined, launch: LtiLaunchContext): string {
  // Allow the platform to deep-link a specific assignment via a custom param.
  const assignmentId = launch.custom?.assignment_id || launch.custom?.pawtograder_assignment_id;
  if (classId && assignmentId && /^\d+$/.test(assignmentId)) {
    return `/course/${classId}/assignments/${assignmentId}`;
  }
  if (classId) return `/course/${classId}`;
  // Not yet linked to a class: drop the user on their course list with a hint.
  return `/?lti_unlinked=1`;
}
