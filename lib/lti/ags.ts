/**
 * Assignment & Grade Services (AGS) client.
 *
 * - Line items represent gradebook columns / assignments on the platform.
 * - Scores publish a student's result to a line item.
 *
 * Spec: https://www.imsglobal.org/spec/lti-ags/v2p0
 */
import { AGS_SCOPE, type AgsLineItem, type AgsScore } from "./types";
import { getServiceAccessToken } from "./oauth";
import { ltiAdminClient, type LtiDb } from "./db";
import { appendPath } from "./util";

const LINE_ITEM_MEDIA = "application/vnd.ims.lis.v2.lineitem+json";
const LINE_ITEM_CONTAINER_MEDIA = "application/vnd.ims.lis.v2.lineitemcontainer+json";
const SCORE_MEDIA = "application/vnd.ims.lis.v1.score+json";

async function authedFetch(
  platformId: number,
  scopes: string[],
  url: string,
  init: RequestInit & { contentType?: string; accept?: string },
  db: LtiDb
): Promise<Response> {
  const token = await getServiceAccessToken(platformId, scopes, db);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    ...(init.accept ? { Accept: init.accept } : {})
  };
  return fetch(url, {
    signal: AbortSignal.timeout(15_000), // don't hang the request handler on a stuck platform
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) }
  });
}

/**
 * Ensure a line item exists for a resource. If `resourceId` matches an existing
 * line item in the container we reuse it; otherwise we create one. Returns the
 * line item resource URL (its `id`).
 */
export async function ensureLineItem(
  platformId: number,
  lineItemsUrl: string,
  lineItem: AgsLineItem,
  db: LtiDb = ltiAdminClient()
): Promise<{ id: string; created: boolean }> {
  // Look for an existing line item by resourceId to make pushes idempotent.
  if (lineItem.resourceId) {
    const search = new URL(lineItemsUrl);
    search.searchParams.set("resource_id", lineItem.resourceId);
    const existing = await authedFetch(
      platformId,
      [AGS_SCOPE.lineItem],
      search.toString(),
      { method: "GET", accept: LINE_ITEM_CONTAINER_MEDIA },
      db
    );
    if (existing.ok) {
      const items = (await existing.json()) as AgsLineItem[];
      const found = items.find((i) => i.resourceId === lineItem.resourceId && i.id);
      if (found?.id) {
        // Keep label/max in sync.
        await updateLineItem(platformId, found.id, lineItem, db).catch(() => undefined);
        return { id: found.id, created: false };
      }
    }
  }

  const res = await authedFetch(
    platformId,
    [AGS_SCOPE.lineItem],
    lineItemsUrl,
    { method: "POST", contentType: LINE_ITEM_MEDIA, accept: LINE_ITEM_MEDIA, body: JSON.stringify(lineItem) },
    db
  );
  if (!res.ok) {
    throw new Error(`Failed to create line item (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const created = (await res.json()) as AgsLineItem;
  if (!created.id) throw new Error("Created line item response missing id/url");
  return { id: created.id, created: true };
}

export async function updateLineItem(
  platformId: number,
  lineItemUrl: string,
  lineItem: AgsLineItem,
  db: LtiDb = ltiAdminClient()
): Promise<void> {
  const res = await authedFetch(
    platformId,
    [AGS_SCOPE.lineItem],
    lineItemUrl,
    { method: "PUT", contentType: LINE_ITEM_MEDIA, accept: LINE_ITEM_MEDIA, body: JSON.stringify(lineItem) },
    db
  );
  if (!res.ok) {
    throw new Error(`Failed to update line item (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

/**
 * Publish a single score. The score endpoint is the line item URL with `/scores`
 * appended (preserving any query string), per the AGS spec.
 */
export async function publishScore(
  platformId: number,
  lineItemUrl: string,
  score: AgsScore,
  db: LtiDb = ltiAdminClient()
): Promise<void> {
  const scoresUrl = appendPath(lineItemUrl, "/scores");
  const res = await authedFetch(
    platformId,
    [AGS_SCOPE.score],
    scoresUrl,
    { method: "POST", contentType: SCORE_MEDIA, body: JSON.stringify(score) },
    db
  );
  if (!res.ok) {
    throw new Error(`Failed to publish score (${res.status}): ${await res.text().catch(() => "")}`);
  }
}
