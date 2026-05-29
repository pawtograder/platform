/**
 * Trigger an NRPS roster sync.
 *
 *  - Cron mode: POST { all: true } with the x-lti-cron-secret header → sync every
 *    roster-sync-enabled context.
 *  - UI mode: POST { class_id } as an instructor → sync that class's contexts.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { isCronAuthorized, isInstructorOfClass } from "@/lib/lti/auth";
import { syncAllRosters, syncContextRoster, type ContextLinkRow } from "@/lib/lti/roster";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { all?: boolean; class_id?: number } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is allowed */
  }

  try {
    const db = ltiAdminClient();

    // --- Cron mode: sync everything ---
    if (isCronAuthorized(request)) {
      const results = await syncAllRosters(db);
      return NextResponse.json({ mode: "cron", count: results.length, results });
    }

    // --- UI mode: instructor syncing a single class ---
    const classId = Number(body.class_id);
    if (!classId || Number.isNaN(classId)) {
      return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    }
    const serverClient = await createClient();
    if (!(await isInstructorOfClass(serverClient, classId))) {
      return NextResponse.json({ error: "Not authorized for this class" }, { status: 403 });
    }

    const { data: links, error } = await db
      .from("lti_context_links")
      .select("id, platform_id, class_id, context_id, nrps_url, roster_sync_enabled")
      .eq("class_id", classId);
    if (error) throw error;
    if (!links || links.length === 0) {
      return NextResponse.json({ error: "This class is not linked to an LTI context" }, { status: 404 });
    }

    const results = [];
    for (const link of links as ContextLinkRow[]) {
      results.push(await syncContextRoster(link, db));
    }
    return NextResponse.json({ mode: "manual", count: results.length, results });
  } catch (e) {
    Sentry.captureException(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
