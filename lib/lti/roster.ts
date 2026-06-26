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
    // Canvas emails can differ in case from what we stored; `.in()` is
    // case-sensitive, so look up both the raw and lowercased forms, then key the
    // map by lowercased email for a case-insensitive match.
    const lookup = [...new Set(emails.flatMap((e) => [e, e.toLowerCase()]))];
    const { data: users } = await db.from("users").select("user_id, email").in("email", lookup);
    for (const u of users ?? []) if (u.email) emailToUserId.set(u.email.toLowerCase(), u.user_id);
  }

  // Upsert identity fields WITHOUT user_id, so a previously-established link
  // (set on launch by establishSupabaseSession) is never clobbered to NULL when
  // the email lookup misses — a NULL'd link silently drops the student's grade
  // push ("No LTI identity mapped").
  const identityRows = roster.map((r) => ({
    platform_id: platformId,
    sub: r.sub,
    email: r.email,
    name: r.name,
    lis_person_sourcedid: r.lis_person_sourcedid
  }));
  await db.from("lti_users").upsert(identityRows, { onConflict: "platform_id,sub" });

  // Link only members we positively resolved to a user_id (never write NULL).
  const linkRows = roster
    .map((r) => ({
      platform_id: platformId,
      sub: r.sub,
      user_id: r.email ? (emailToUserId.get(r.email.toLowerCase()) ?? null) : null
    }))
    .filter((r): r is { platform_id: number; sub: string; user_id: string } => !!r.user_id);
  if (linkRows.length > 0) {
    await db.from("lti_users").upsert(linkRows, { onConflict: "platform_id,sub" });
  }
}

/**
 * Decide whether a single context's roster sync may drop class-wide missing
 * members. The shared `sis_sync_enrollment` RPC's drop candidates are class-wide
 * (not scoped to this context's sections), so a per-context sync may only drop
 * when it is the SOLE linked context — otherwise it would disable students owned
 * by sibling contexts. Fail safe: a count query error or a null count (we can't
 * prove sole-context) returns false (don't drop).
 */
export function canDropMissing(linkedContextCount: number | null | undefined, countError: unknown): boolean {
  if (countError) return false;
  if (linkedContextCount == null) return false;
  return linkedContextCount <= 1;
}

/** Resolve a context link's section configuration into CRNs the RPC understands.
 *  A mapped Pawtograder section is only usable if it has a non-null `sis_crn`. */
export async function buildSectionConfig(link: ContextLinkRow, db: LtiDb): Promise<SectionConfig> {
  // Load the per-member section map first (topology B) so we know every section
  // id we need to resolve, then batch the id -> sis_crn lookups into one query
  // per table instead of a serialized single-row SELECT per section.
  let mapRows: Array<{ canvas_section_name: string; class_section_id: number | null; lab_section_id: number | null }> =
    [];
  if (link.split_by_member_section) {
    const { data } = await db
      .from("lti_context_section_map")
      .select("canvas_section_name, class_section_id, lab_section_id")
      .eq("context_link_id", link.id);
    mapRows = data ?? [];
  }

  const classSectionIds = uniqueIds([link.class_section_id, ...mapRows.map((r) => r.class_section_id)]);
  const labSectionIds = uniqueIds([link.lab_section_id, ...mapRows.map((r) => r.lab_section_id)]);

  const crnByClassSection = await crnMap(db, "class_sections", classSectionIds);
  const crnByLabSection = await crnMap(db, "lab_sections", labSectionIds);
  const classCrn = (id: number | null) => (id != null ? (crnByClassSection.get(id) ?? null) : null);
  const labCrn = (id: number | null) => (id != null ? (crnByLabSection.get(id) ?? null) : null);

  const nameMap: SectionConfig["nameMap"] = new Map();
  for (const r of mapRows) {
    nameMap.set(r.canvas_section_name, {
      classSectionCrn: classCrn(r.class_section_id),
      labSectionCrn: labCrn(r.lab_section_id)
    });
  }

  return {
    sectionRole: link.section_role,
    classSectionCrn: classCrn(link.class_section_id),
    labSectionCrn: labCrn(link.lab_section_id),
    splitByMemberSection: link.split_by_member_section,
    nameMap
  };
}

/** Unique, non-null ids from a list (preserves the batched-lookup contract). */
function uniqueIds(ids: Array<number | null>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null))];
}

/** Batch-resolve section id -> sis_crn for one section table. */
async function crnMap(
  db: LtiDb,
  table: "class_sections" | "lab_sections",
  ids: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const { data } = await db.from(table).select("id, sis_crn").in("id", ids);
  for (const row of data ?? []) if (row.sis_crn != null) out.set(row.id, row.sis_crn);
  return out;
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
    // Pass context_id as the rlid so Canvas includes per-member section_names
    // (see fetchMemberships); for a nav launch the resource link id is the
    // context's opaque id, which is what we store as context_id.
    const membership = await fetchMemberships(link.platform_id, link.nrps_url, db, link.context_id);
    const { roster, unmapped } = mapRoster(membership.members, cfg);
    await upsertLtiUsers(link.platform_id, roster, db);

    // Cross-drop guard (docs §7.2): whenever a class has >1 linked context, any
    // single context's roster is only a SUBSET of the class. The RPC's drop
    // candidates are class-wide (not scoped to this context's sections), so
    // dropping here would disable students owned by sibling contexts — for ANY
    // section role, not just course_wide. Only drop when this is the sole context.
    const { count: linkedContexts, error: countErr } = await db
      .from("lti_context_links")
      .select("id", { count: "exact", head: true })
      .eq("class_id", link.class_id);
    const dropMissing = canDropMissing(linkedContexts, countErr);

    // Each context owns only the section dimension(s) its role implies; tell the
    // RPC to leave the other dimension untouched so a lecture sync can't wipe the
    // lab section a lab context assigned (and vice versa). course_wide owns none.
    const manageClassSections = cfg.sectionRole === "lecture" || cfg.splitByMemberSection;
    const manageLabSections = cfg.sectionRole === "lab" || cfg.splitByMemberSection;

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
      p_sync_options: {
        drop_missing: dropMissing,
        manage_class_sections: manageClassSections,
        manage_lab_sections: manageLabSections
      } as never
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
