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

  // 1. Resolve the user. Prefer the authoritative per-platform identity binding
  //    (platform_id, sub) -> user_id, recorded by a prior verified launch. This
  //    lets returning users sign in WITHOUT ever touching the email-matching
  //    path below, so the email-adoption guard only applies to first-time links.
  let userId: string | undefined;
  const { data: binding } = await adminClient
    .from("lti_users")
    .select("user_id")
    .eq("platform_id", launch.platformId)
    .eq("sub", launch.sub)
    .maybeSingle();
  if (binding?.user_id) userId = binding.user_id;

  // 2. No binding yet (first launch for this identity). Match an existing account
  //    by email — but only ADOPT a pre-existing account with positive evidence the
  //    launcher actually owns it. The `email` claim is asserted by a (possibly
  //    user-configurable or self-hosted) LMS, so signing into a pre-existing
  //    account on email alone is account takeover. Guard the adoption:
  //      - refuse if the launch explicitly marks the email unverified, and
  //      - require the target account to have a CONFIRMED email, so an attacker
  //        can't squat a victim's address via an unconfirmed self-signup and then
  //        get silently signed into it by launching.
  //    Match case-insensitively but LITERALLY via `.in()` (exact match), NOT
  //    `.ilike()`, whose LIKE metacharacters (e.g. `_`, valid in local-parts)
  //    would match a different account.
  if (!userId) {
    const emailVariants = [...new Set([email, launch.email!.trim()])];
    const { data: existingUsers } = await adminClient.from("users").select("user_id, email").in("email", emailVariants);
    const candidate =
      (existingUsers ?? []).find((u) => u.email?.toLowerCase() === email)?.user_id ?? existingUsers?.[0]?.user_id;
    if (candidate) {
      if (launch.emailVerified === false) {
        throw new LtiSessionError(
          "Your LMS reported your email address as unverified, so Pawtograder can't sign you into the existing " +
            "account with this email. Ask your administrator to enable verified email release for the Pawtograder LTI tool."
        );
      }
      const { data: authUser } = await adminClient.auth.admin.getUserById(candidate);
      if (!authUser?.user?.email_confirmed_at) {
        throw new LtiSessionError(
          "An account with your email address already exists but its email has not been confirmed, so Pawtograder " +
            "can't safely sign you into it from an LMS launch. Confirm that account's email, or contact your administrator."
        );
      }
      userId = candidate;
    }
  }

  // 3. Still no match: provision a fresh auth user for this email.
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

  // 4. Mint a magic-link token. For an existing user this also returns the user,
  //    which lets us resolve the id when createUser hit a duplicate email.
  const { data: link, error: linkErr } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email
  });
  if (linkErr || !link.properties?.hashed_token) {
    throw new LtiSessionError(`Failed to create sign-in link: ${linkErr?.message ?? "unknown"}`);
  }
  // The session is established AS the auth user this magic link belongs to, so
  // that id is authoritative for the returned userId (which the caller uses for
  // the enrollment check). Prefer it over any earlier-resolved id, which could be
  // a stale/duplicate public.users row whose user_id diverges from auth.users.
  userId = link.user?.id ?? userId;
  if (!userId) {
    throw new LtiSessionError(`Failed to provision account for ${email}: could not resolve user`);
  }

  // 5. Record the LTI identity -> user mapping.
  await adminClient
    .from("lti_users")
    .update({ user_id: userId })
    .eq("platform_id", launch.platformId)
    .eq("sub", launch.sub);

  // 6. Redeem the magic link on the cookie-bound client to write the session.
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
  enrolled = true,
  deepLinkAssignmentId?: number | null
): string {
  if (classId && enrolled) {
    // Deep-link a specific assignment when the caller resolved one. The id MUST be
    // validated against `classId` by the caller (it comes from a platform-controlled
    // custom claim), so we never redirect into another class's assignment here.
    if (deepLinkAssignmentId != null) {
      return `/course/${classId}/assignments/${deepLinkAssignmentId}`;
    }
    return `/course/${classId}`;
  }
  // Not linked to a class, or launched before a roster sync enrolled this user:
  // drop them on the home page with a hint rather than a course that bounces.
  return `/?lti_unlinked=1`;
}
