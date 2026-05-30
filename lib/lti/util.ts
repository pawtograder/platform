/**
 * Pure, dependency-free LTI helpers (no DB / no network / no `server-only`),
 * so they can be unit-tested and shared by the service modules.
 */
import { ltiRolesToAppRole, type NrpsMember } from "./types";

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

/** Project Active NRPS members into roster entries. */
export function membersToRoster(members: NrpsMember[]): RosterEntry[] {
  const roster: RosterEntry[] = [];
  for (const m of members) {
    if (m.status && m.status !== "Active") continue;
    const sourced = m.lis_person_sourcedid?.trim();
    const numericSourced = sourced && /^\d+$/.test(sourced) ? Number(sourced) : undefined;
    const name =
      m.name?.trim() || [m.given_name, m.family_name].filter(Boolean).join(" ").trim() || m.email?.trim() || null;
    roster.push({
      sis_user_id: numericSourced ?? surrogateSisId(m.user_id),
      name: name || null,
      role: ltiRolesToAppRole(m.roles),
      email: m.email?.trim() || null,
      sub: m.user_id,
      lis_person_sourcedid: sourced || null,
      class_section_crn: null,
      lab_section_crn: null
    });
  }
  return roster;
}
