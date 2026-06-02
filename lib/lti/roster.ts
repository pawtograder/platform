/**
 * Roster sync: pull a context's membership via NRPS and feed it into the
 * existing atomic enrollment RPC (`public.sis_sync_enrollment`), so LTI rosters
 * flow through the exact same invitation/enrollment semantics as the SIS path.
 */
import "server-only";
import { fetchMemberships, membersToRoster, type RosterEntry } from "./nrps";
import { ltiAdminClient, type LtiDb } from "./db";

export type ContextLinkRow = {
  id: number;
  platform_id: number;
  class_id: number | null;
  context_id: string;
  nrps_url: string | null;
  roster_sync_enabled: boolean;
};

export type RosterSyncResult = {
  contextLinkId: number;
  classId: number;
  memberCount: number;
  status: "success" | "error";
  message: string;
};

/** Persist LTI identity mappings for synced members, resolving user_id by email. */
async function upsertLtiUsers(platformId: number, roster: RosterEntry[], db: LtiDb): Promise<void> {
  if (roster.length === 0) return;

  const emails = roster.map((r) => r.email).filter((e): e is string => !!e);
  const emailToUserId = new Map<string, string>();
  if (emails.length > 0) {
    const { data: users } = await db.from("users").select("user_id, email").in("email", emails);
    for (const u of users ?? []) if (u.email) emailToUserId.set(u.email.toLowerCase(), u.user_id);
  }

  const rows = roster.map((r) => ({
    platform_id: platformId,
    sub: r.sub,
    email: r.email,
    name: r.name,
    lis_person_sourcedid: r.lis_person_sourcedid,
    user_id: r.email ? (emailToUserId.get(r.email.toLowerCase()) ?? null) : null
  }));
  await db.from("lti_users").upsert(rows, { onConflict: "platform_id,sub" });
}

/** Sync a single linked context. Throws only on unexpected failures; recorded
 *  errors are returned with status "error". */
export async function syncContextRoster(link: ContextLinkRow, db: LtiDb = ltiAdminClient()): Promise<RosterSyncResult> {
  const base = { contextLinkId: link.id, classId: link.class_id ?? 0 };
  if (!link.class_id) {
    return { ...base, memberCount: 0, status: "error", message: "Context is not linked to a class" };
  }
  if (!link.nrps_url) {
    return { ...base, memberCount: 0, status: "error", message: "No NRPS membership URL captured for this context" };
  }

  let result: RosterSyncResult;
  try {
    const membership = await fetchMemberships(link.platform_id, link.nrps_url, db);
    const roster = membersToRoster(membership.members);
    await upsertLtiUsers(link.platform_id, roster, db);

    const { error } = await db.rpc("sis_sync_enrollment", {
      p_class_id: link.class_id,
      p_roster_data: roster.map((r) => ({
        sis_user_id: r.sis_user_id,
        name: r.name,
        email: r.email,
        role: r.role,
        class_section_crn: r.class_section_crn,
        lab_section_crn: r.lab_section_crn
      })) as never,
      p_sync_options: { drop_missing: true } as never
    });
    if (error) throw error;

    result = {
      ...base,
      classId: link.class_id,
      memberCount: roster.length,
      status: "success",
      message: `Synced ${roster.length} members`
    };
  } catch (e) {
    result = { ...base, classId: link.class_id, memberCount: 0, status: "error", message: (e as Error).message };
  }

  await db
    .from("lti_context_links")
    .update({
      last_roster_sync_at: new Date().toISOString(),
      last_roster_sync_status: result.status,
      last_roster_sync_message: result.message.slice(0, 1000)
    })
    .eq("id", link.id);

  return result;
}

/** Sync every roster-sync-enabled, class-linked context (used by cron). */
export async function syncAllRosters(db: LtiDb = ltiAdminClient()): Promise<RosterSyncResult[]> {
  const { data, error } = await db
    .from("lti_context_links")
    .select("id, platform_id, class_id, context_id, nrps_url, roster_sync_enabled")
    .eq("roster_sync_enabled", true)
    .not("class_id", "is", null)
    .not("nrps_url", "is", null);
  if (error) throw error;
  const results: RosterSyncResult[] = [];
  for (const link of (data ?? []) as ContextLinkRow[]) {
    results.push(await syncContextRoster(link, db));
  }
  return results;
}
