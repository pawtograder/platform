/**
 * Discover the distinct Canvas section names present on a linked context's roster,
 * for the instructor section-mapping UI (topology B). Does a live NRPS fetch and
 * reads each member's `$com.instructure.User.sectionNames` custom claim.
 *
 * Instructor-only: the caller must instruct the class the context is bound to.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { isInstructorOfClass } from "@/lib/lti/auth";
import { fetchMemberships, extractSectionNames } from "@/lib/lti/nrps";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  let body: { context_link_id?: number } = {};
  try {
    body = await request.json();
  } catch {
    /* empty */
  }
  const contextLinkId = Number(body.context_link_id);
  if (!contextLinkId || Number.isNaN(contextLinkId)) {
    return NextResponse.json({ error: "context_link_id is required" }, { status: 400 });
  }

  try {
    const db = ltiAdminClient();
    const { data: link, error } = await db
      .from("lti_context_links")
      .select("id, class_id, platform_id, nrps_url")
      .eq("id", contextLinkId)
      .maybeSingle();
    if (error) throw error;
    if (!link || !link.class_id) {
      return NextResponse.json({ error: "Context is not bound to a class" }, { status: 404 });
    }

    const serverClient = await createClient();
    if (!(await isInstructorOfClass(serverClient, link.class_id))) {
      return NextResponse.json({ error: "Not authorized for this class" }, { status: 403 });
    }
    if (!link.nrps_url) {
      return NextResponse.json({ error: "No NRPS membership URL captured for this context" }, { status: 400 });
    }

    const membership = await fetchMemberships(link.platform_id, link.nrps_url, db);
    const names = new Set<string>();
    for (const m of membership.members) {
      if (m.status && m.status !== "Active") continue;
      for (const n of extractSectionNames(m)) names.add(n);
    }
    return NextResponse.json({ sections: [...names].sort() });
  } catch (e) {
    Sentry.captureException(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
