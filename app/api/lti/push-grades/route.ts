/**
 * Push an assignment's grades (and its line item) to the LMS gradebook via AGS.
 *
 *  - Drain mode: POST { drain: true } with the x-lti-cron-secret header → process
 *    the on-release work queue (every enqueued assignment). This is what the
 *    grade-release DB trigger and the safety-net cron call.
 *  - Single mode: POST { class_id, assignment_id } as an instructor (UI button)
 *    or with the cron secret → reconcile one assignment.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { isCronAuthorized, isInstructorOfClass } from "@/lib/lti/auth";
import { syncAssignmentGrades, drainGradeSyncQueue } from "@/lib/lti/grades";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { drain?: boolean; class_id?: number; assignment_id?: number } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const db = ltiAdminClient();

    // --- Drain mode: process the on-release queue (cron / trigger only) ---
    if (body.drain) {
      if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Not authorized" }, { status: 403 });
      }
      const results = await drainGradeSyncQueue(db);
      return NextResponse.json({ mode: "drain", count: results.length, results });
    }

    // --- Single-assignment mode ---
    const classId = Number(body.class_id);
    const assignmentId = Number(body.assignment_id);
    if (!classId || !assignmentId || Number.isNaN(classId) || Number.isNaN(assignmentId)) {
      return NextResponse.json({ error: "class_id and assignment_id are required" }, { status: 400 });
    }

    if (!isCronAuthorized(request)) {
      const serverClient = await createClient();
      if (!(await isInstructorOfClass(serverClient, classId))) {
        return NextResponse.json({ error: "Not authorized for this class" }, { status: 403 });
      }
    }
    const result = await syncAssignmentGrades(classId, assignmentId, db);
    return NextResponse.json(result);
  } catch (e) {
    Sentry.captureException(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
