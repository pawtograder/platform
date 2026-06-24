/**
 * Pure, dependency-free LTI helpers (no DB / no network / no `server-only`),
 * so they can be unit-tested and shared by the service modules.
 */
import { LTI_CLAIM, ltiRolesToAppRole, type NrpsMember } from "./types";

// ---- JWT (decode only; verification lives in jwt.ts) ----
export type DecodedJwt = Record<string, unknown>;

export function decodeJwtPayload(jwt: string): DecodedJwt {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as DecodedJwt;
}

// ---- RFC5988 Link header (NRPS pagination) ----
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return undefined;
}

// ---- AGS line item URL → scores URL ----
export function appendPath(lineItemUrl: string, segment: string): string {
  const url = new URL(lineItemUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + segment;
  return url.toString();
}

// ---- Roster mapping (NRPS members → sis_sync_enrollment shape) ----
export type RosterEntry = {
  sis_user_id: number;
  name: string | null;
  role: "instructor" | "grader" | "student";
  email: string | null;
  sub: string;
  lis_person_sourcedid: string | null;
  class_section_crn: number | null;
  lab_section_crn: number | null;
};

/**
 * Deterministic positive 31-bit integer from the LTI `sub` (FNV-1a), used as a
 * surrogate `sis_user_id` when the platform provides no numeric SIS id.
 */
export function surrogateSisId(sub: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sub.length; i++) {
    hash ^= sub.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) % 2_000_000_000;
}

/** Base projection of an Active NRPS member, sans section CRNs. */
function baseRosterEntry(m: NrpsMember): Omit<RosterEntry, "class_section_crn" | "lab_section_crn"> {
  const sourced = m.lis_person_sourcedid?.trim();
  const numericSourced = sourced && /^\d+$/.test(sourced) ? Number(sourced) : undefined;
  const name =
    m.name?.trim() || [m.given_name, m.family_name].filter(Boolean).join(" ").trim() || m.email?.trim() || null;
  return {
    sis_user_id: numericSourced ?? surrogateSisId(m.user_id),
    name: name || null,
    role: ltiRolesToAppRole(m.roles),
    email: m.email?.trim() || null,
    sub: m.user_id,
    lis_person_sourcedid: sourced || null
  };
}

// ---- Per-member section resolution (NRPS sectionNames → Pawtograder CRNs) ----

/** Parse a `$com.instructure.User.sectionNames` value into trimmed names.
 *  Canvas emits this either as a JSON-array string (`'["L05","L06"]'`), a real
 *  array, or a comma-joined string — handle all three. */
function parseSectionNamesValue(value: unknown): string[] {
  const out = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      /* fall through to comma-split */
    }
  }
  return out(trimmed);
}

/** Extract the per-member Canvas section names from the NRPS `message[]` custom
 *  claim (populated when `section_names=$com.instructure.User.sectionNames` is set
 *  as a custom field on the tool). Returns [] when the claim is absent. */
export function extractSectionNames(member: NrpsMember): string[] {
  const names: string[] = [];
  for (const msg of member.message ?? []) {
    const custom = msg?.[LTI_CLAIM.custom];
    if (custom && typeof custom === "object") {
      const v = (custom as Record<string, unknown>).section_names;
      names.push(...parseSectionNamesValue(v));
    }
  }
  // De-dup while preserving order.
  return [...new Set(names)];
}

/** How a context link maps members onto Pawtograder section CRNs. */
export type SectionConfig = {
  sectionRole: "lecture" | "lab" | "course_wide";
  /** Context-level CRNs (topology A); null when not designated. */
  classSectionCrn: number | null;
  labSectionCrn: number | null;
  /** Topology B: split members by their Canvas section name. */
  splitByMemberSection: boolean;
  /** canvas_section_name → resolved CRNs (topology B). */
  nameMap: Map<string, { classSectionCrn: number | null; labSectionCrn: number | null }>;
};

export const COURSE_WIDE_CONFIG: SectionConfig = {
  sectionRole: "course_wide",
  classSectionCrn: null,
  labSectionCrn: null,
  splitByMemberSection: false,
  nameMap: new Map()
};

/** Resolve one member's section CRNs per the context config. `unmappedNames` lists
 *  Canvas section names with no map entry (surfaced, never silently dropped). */
export function resolveMemberSections(
  member: NrpsMember,
  cfg: SectionConfig
): { class_section_crn: number | null; lab_section_crn: number | null; unmappedNames: string[] } {
  if (cfg.splitByMemberSection) {
    let classCrn: number | null = null;
    let labCrn: number | null = null;
    const unmappedNames: string[] = [];
    for (const name of extractSectionNames(member)) {
      const hit = cfg.nameMap.get(name);
      if (!hit) {
        unmappedNames.push(name);
        continue;
      }
      if (classCrn === null && hit.classSectionCrn !== null) classCrn = hit.classSectionCrn;
      if (labCrn === null && hit.labSectionCrn !== null) labCrn = hit.labSectionCrn;
    }
    return { class_section_crn: classCrn, lab_section_crn: labCrn, unmappedNames };
  }
  // Topology A / course_wide: the whole context maps to one section (or none).
  if (cfg.sectionRole === "lecture") {
    return { class_section_crn: cfg.classSectionCrn, lab_section_crn: null, unmappedNames: [] };
  }
  if (cfg.sectionRole === "lab") {
    return { class_section_crn: null, lab_section_crn: cfg.labSectionCrn, unmappedNames: [] };
  }
  return { class_section_crn: null, lab_section_crn: null, unmappedNames: [] };
}

/** Project Active NRPS members into roster entries with section CRNs resolved per
 *  `cfg`, plus the set of unmapped Canvas section names encountered (topology B). */
export function mapRoster(members: NrpsMember[], cfg: SectionConfig): { roster: RosterEntry[]; unmapped: string[] } {
  const roster: RosterEntry[] = [];
  const unmapped = new Set<string>();
  for (const m of members) {
    if (m.status && m.status !== "Active") continue;
    const { class_section_crn, lab_section_crn, unmappedNames } = resolveMemberSections(m, cfg);
    for (const n of unmappedNames) unmapped.add(n);
    roster.push({ ...baseRosterEntry(m), class_section_crn, lab_section_crn });
  }
  return { roster, unmapped: [...unmapped] };
}

/** Legacy course-wide projection (no section assignment). Kept for callers/tests
 *  that don't need section resolution. */
export function membersToRoster(members: NrpsMember[]): RosterEntry[] {
  return mapRoster(members, COURSE_WIDE_CONFIG).roster;
}
