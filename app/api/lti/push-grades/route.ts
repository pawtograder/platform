/**
 * Push an assignment's grades (and its line item) to the LMS gradebook via AGS.
 * POST { class_id, assignment_id }. Authorized either as an instructor of the
 * class (cookie session, from the UI) or via the cron shared secret (automated
 * grade sync), mirroring /api/lti/sync-roster.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { isCronAuthorized, isInstructorOfClass } from "@/lib/lti/auth";
import { pushAssignmentGrades } from "@/lib/lti/grades";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { class_id?: number; assignment_id?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const classId = Number(body.class_id);
  const assignmentId = Number(body.assignment_id);
  if (!classId || !assignmentId || Number.isNaN(classId) || Number.isNaN(assignmentId)) {
    return NextResponse.json({ error: "class_id and assignment_id are required" }, { status: 400 });
  }

  try {
    if (!isCronAuthorized(request)) {
      const serverClient = await createClient();
      if (!(await isInstructorOfClass(serverClient, classId))) {
        return NextResponse.json({ error: "Not authorized for this class" }, { status: 403 });
      }
    }
    const result = await pushAssignmentGrades(classId, assignmentId, ltiAdminClient());
    return NextResponse.json(result);
  } catch (e) {
    Sentry.captureException(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
