/**
 * Persist the durable state captured from a validated LTI launch:
 *  - the deployment (platform install)
 *  - the context link (LMS course -> Pawtograder class) with NRPS/AGS endpoints
 *  - the LTI user identity mapping
 *
 * The context link is the anchor for later roster/grade sync, so we refresh its
 * service endpoints on every launch (they can rotate).
 */
import "server-only";
import type { LtiLaunchContext } from "./types";
import { ltiAdminClient, type LtiDb } from "./db";

export type PersistedLaunch = {
  contextLinkId?: number;
  classId?: number | null;
};

export async function persistLaunch(launch: LtiLaunchContext, db: LtiDb = ltiAdminClient()): Promise<PersistedLaunch> {
  // Deployment (idempotent).
  await db
    .from("lti_deployments")
    .upsert(
      { platform_id: launch.platformId, deployment_id: launch.deploymentId },
      { onConflict: "platform_id,deployment_id", ignoreDuplicates: true }
    );

  let result: PersistedLaunch = {};

  if (launch.context?.id) {
    // Preserve an existing class link + sync toggles if the context is already linked.
    const { data: existing } = await db
      .from("lti_context_links")
      .select("id, class_id, roster_sync_enabled, grade_sync_enabled, nrps_url, ags_lineitems_url, ags_scopes")
      .eq("platform_id", launch.platformId)
      .eq("deployment_id", launch.deploymentId)
      .eq("context_id", launch.context.id)
      .maybeSingle();

    // Refresh service endpoints when this launch supplies them, but never clobber
    // a previously-captured URL/scope with NULL: not every launch (e.g. a
    // deep-link or lineitem-only placement) carries the NRPS/AGS-collection
    // claims, and a NULL'd endpoint silently halts roster/grade sync for the
    // context (getGradeContext filters out null ags_lineitems_url).
    const row = {
      platform_id: launch.platformId,
      deployment_id: launch.deploymentId,
      context_id: launch.context.id,
      context_label: launch.context.label ?? null,
      context_title: launch.context.title ?? null,
      nrps_url: launch.nrpsUrl ?? existing?.nrps_url ?? null,
      ags_lineitems_url: launch.ags?.lineItemsUrl ?? existing?.ags_lineitems_url ?? null,
      ags_scopes: launch.ags?.scopes ?? existing?.ags_scopes ?? []
    };

    const { data: upserted, error } = await db
      .from("lti_context_links")
      .upsert(row, { onConflict: "platform_id,deployment_id,context_id" })
      .select("id, class_id")
      .single();
    if (error) throw error;
    result = { contextLinkId: upserted.id, classId: existing?.class_id ?? upserted.class_id ?? null };
  }

  // User identity mapping (user_id is filled in by the session bridge).
  await db.from("lti_users").upsert(
    {
      platform_id: launch.platformId,
      sub: launch.sub,
      email: launch.email ?? null,
      name: launch.name ?? null,
      lis_person_sourcedid: launch.lisPersonSourcedId ?? null
    },
    { onConflict: "platform_id,sub" }
  );

  return result;
}
