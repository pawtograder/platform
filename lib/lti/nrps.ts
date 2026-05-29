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

/** Fetch every member of a context, transparently following pagination. */
export async function fetchMemberships(
  platformId: number,
  membershipsUrl: string,
  db: LtiDb = ltiAdminClient()
): Promise<NrpsMembershipResponse> {
  let url: string | undefined = membershipsUrl;
  let context: NrpsMembershipResponse["context"] | undefined;
  let id = membershipsUrl;
  const members: NrpsMember[] = [];
  let guard = 0;

  while (url && guard < 100) {
    guard += 1;
    const token = await getServiceAccessToken(platformId, [NRPS_SCOPE], db);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: MEMBERSHIP_MEDIA }
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
export { membersToRoster, surrogateSisId, type RosterEntry } from "./util";
