/**
 * Roster sync: pull a context's membership via NRPS and feed it into the
 * existing atomic enrollment RPC (`public.sis_sync_enrollment`), so LTI rosters
 * flow through the exact same invitation/enrollment semantics as the SIS path.
 *
 * Section assignment (docs/lti-section-mapping.md): each context link declares a
 * `section_role` and either a context-level section (topology A) or a per-member
 * Canvas-section-name → Pawtograder-section map (topology B). We resolve every
 * member's lecture/lab CRNs from that config before calling the RPC, which keys
 * sections on `sis_crn`.
 */
import "server-only";
import { fetchMemberships, mapRoster, type RosterEntry, type SectionConfig } from "./nrps";
import { ltiAdminClient, type LtiDb } from "./db";

export type ContextLinkRow = {
  id: number;
  platform_id: number;
  class_id: number | null;
  context_id: string;
  nrps_url: string | null;
  roster_sync_enabled: boolean;
  section_role: "lecture" | "lab" | "course_wide";
  class_section_id: number | null;
  lab_section_id: number | null;
  split_by_member_section: boolean;
};

/** Columns selected wherever a ContextLinkRow is loaded (keep in sync with the type). */
export const CONTEXT_LINK_COLUMNS =
  "id, platform_id, class_id, context_id, nrps_url, roster_sync_enabled, section_role, class_section_id, lab_section_id, split_by_member_section";

export type RosterSyncResult = {
  contextLinkId: number;
  classId: number;
  memberCount: number;
  status: "success" | "error";
  message: string;
  /** Canvas section names seen on members but not mapped to a Pawtograder section. */
  unmappedSections?: string[];
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

/** Resolve a context link's section configuration into CRNs the RPC understands.
 *  A mapped Pawtograder section is only usable if it has a non-null `sis_crn`. */
export async function buildSectionConfig(link: ContextLinkRow, db: LtiDb): Promise<SectionConfig> {
  const crnForClassSection = async (id: number | null): Promise<number | null> => {
    if (!id) return null;
    const { data } = await db.from("class_sections").select("sis_crn").eq("id", id).maybeSingle();
    return data?.sis_crn ?? null;
  };
  const crnForLabSection = async (id: number | null): Promise<number | null> => {
    if (!id) return null;
    const { data } = await db.from("lab_sections").select("sis_crn").eq("id", id).maybeSingle();
    return data?.sis_crn ?? null;
  };

  const nameMap: SectionConfig["nameMap"] = new Map();
  if (link.split_by_member_section) {
    const { data: rows } = await db
      .from("lti_context_section_map")
      .select("canvas_section_name, class_section_id, lab_section_id")
      .eq("context_link_id", link.id);
    for (const r of rows ?? []) {
      nameMap.set(r.canvas_section_name, {
        classSectionCrn: await crnForClassSection(r.class_section_id),
        labSectionCrn: await crnForLabSection(r.lab_section_id)
      });
    }
  }

  return {
    sectionRole: link.section_role,
    classSectionCrn: await crnForClassSection(link.class_section_id),
    labSectionCrn: await crnForLabSection(link.lab_section_id),
    splitByMemberSection: link.split_by_member_section,
    nameMap
  };
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
    const cfg = await buildSectionConfig(link, db);
    const membership = await fetchMemberships(link.platform_id, link.nrps_url, db);
    const { roster, unmapped } = mapRoster(membership.members, cfg);
    await upsertLtiUsers(link.platform_id, roster, db);

    // Cross-drop guard (docs §7.2): a `course_wide` context in a class with >1
    // linked context can't safely drop — its sync set spans the whole class,
    // incl. members owned by sibling contexts. Disable dropping for that case.
    let dropMissing = true;
    if (cfg.sectionRole === "course_wide") {
      const { count } = await db
        .from("lti_context_links")
        .select("id", { count: "exact", head: true })
        .eq("class_id", link.class_id);
      if ((count ?? 1) > 1) dropMissing = false;
    }

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
      p_sync_options: { drop_missing: dropMissing } as never
    });
    if (error) throw error;

    const unmappedNote =
      unmapped.length > 0 ? `; ${unmapped.length} unmapped Canvas section(s): ${unmapped.join(", ")}` : "";
    result = {
      ...base,
      classId: link.class_id,
      memberCount: roster.length,
      status: "success",
      message: `Synced ${roster.length} members${unmappedNote}`,
      unmappedSections: unmapped.length > 0 ? unmapped : undefined
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
    .select(CONTEXT_LINK_COLUMNS)
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
