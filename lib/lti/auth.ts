/**
 * Authorization helpers for LTI sync endpoints, which are reachable two ways:
 *  - pg_cron, presenting the shared secret header (no user session), and
 *  - an instructor clicking "sync" in the management UI (cookie session).
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

export function isCronAuthorized(request: Request): boolean {
  const expected = process.env.LTI_CRON_SHARED_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-lti-cron-secret");
  if (!provided) return false;
  // Constant-time compare so we don't leak the secret via response timing on
  // this privileged full-roster-sync / grade-push path.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns true if the current cookie-session user is a site admin (admin role
 *  in any class — matches authorize_for_admin()). */
export async function isSiteAdmin(serverClient: SupabaseClient<Database>): Promise<boolean> {
  const {
    data: { user }
  } = await serverClient.auth.getUser();
  if (!user) return false;
  const { data, error } = await serverClient
    .from("user_roles")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .or("disabled.is.null,disabled.eq.false")
    .limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Returns true if the current cookie-session user is an instructor of the class
 *  (or a site admin). Delegates to the canonical authz gates the rest of the app
 *  uses — authorizeforclassinstructor()/authorize_for_admin() — rather than a
 *  hand-rolled user_roles query that can silently drift from them. */
export async function isInstructorOfClass(serverClient: SupabaseClient<Database>, classId: number): Promise<boolean> {
  const [instructor, admin] = await Promise.all([
    serverClient.rpc("authorizeforclassinstructor", { class__id: classId }),
    serverClient.rpc("authorize_for_admin", {})
  ]);
  return instructor.data === true || admin.data === true;
}
