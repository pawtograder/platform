/**
 * Names & Role Provisioning Services (NRPS) client.
 *
 * Fetches the full course membership, following RFC5988 `Link: rel="next"`
 * pagination, and projects members into the roster shape consumed by the
 * existing `public.sis_sync_enrollment` RPC.
 *
 * Spec: https://www.imsglobal.org/spec/lti-nrps/v2p0
 */
import { NRPS_SCOPE, type NrpsMember, type NrpsMembershipResponse } from "./types";
import { getServiceAccessToken } from "./oauth";
import { ltiAdminClient, type LtiDb } from "./db";
import { parseNextLink } from "./util";

const MEMBERSHIP_MEDIA = "application/vnd.ims.lti-nrps.v2.membershipcontainer+json";

/** Add the `rlid` query param to the memberships URL (pagination links keep it). */
function withRlid(membershipsUrl: string, rlid: string): string {
  const url = new URL(membershipsUrl);
  url.searchParams.set("rlid", rlid);
  return url.toString();
}

/**
 * Fetch every member of a context, transparently following pagination.
 *
 * `rlid` (a resource link id) is required for Canvas to include each member's
 * `message[]` array — which is where the per-member custom claims (e.g.
 * `section_names`) live. Without it Canvas returns the roster with no message
 * data at all, so section-aware sync/discovery silently sees zero sections. For
 * a course-navigation launch the resource link id equals the context's opaque
 * id (== our stored `context_id`), and Canvas returns the full roster for it.
 */
export async function fetchMemberships(
  platformId: number,
  membershipsUrl: string,
  db: LtiDb = ltiAdminClient(),
  rlid?: string
): Promise<NrpsMembershipResponse> {
  let url: string | undefined = rlid ? withRlid(membershipsUrl, rlid) : membershipsUrl;
  let context: NrpsMembershipResponse["context"] | undefined;
  let id = membershipsUrl;
  const members: NrpsMember[] = [];
  let guard = 0;
  // Page cap as a runaway guard. If we hit it with pages still remaining, FAIL
  // rather than return a partial roster: a roster sync with drop_missing=true
  // would treat every uncrawled member as "missing" and mass-disable them.
  const MAX_PAGES = 100;

  while (url) {
    if (guard >= MAX_PAGES) {
      throw new Error(
        `NRPS membership exceeded ${MAX_PAGES} pages; refusing to sync a partial roster (would drop real members).`
      );
    }
    guard += 1;
    const token = await getServiceAccessToken(platformId, [NRPS_SCOPE], db);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: MEMBERSHIP_MEDIA },
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) {
      throw new Error(`NRPS membership fetch failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
    const page = (await res.json()) as NrpsMembershipResponse;
    context = context ?? page.context;
    id = page.id ?? id;
    if (Array.isArray(page.members)) members.push(...page.members);
    url = parseNextLink(res.headers.get("link"));
  }

  return { id, context: context ?? { id: "" }, members };
}

// Roster mapping helpers are pure — re-exported from ./util for convenience.
export {
  membersToRoster,
  mapRoster,
  resolveMemberSections,
  extractSectionNames,
  surrogateSisId,
  COURSE_WIDE_CONFIG,
  type RosterEntry,
  type SectionConfig
} from "./util";
