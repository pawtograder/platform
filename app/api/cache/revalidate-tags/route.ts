import { CLASS_SCOPED_CACHED_TABLES, courseSsrTags, type ClassScopedCachedTable } from "@/lib/next-cache-tags";
import { createClient } from "@/utils/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { withRouteMetrics } from "@/lib/routeMetrics";

/**
 * Revalidate Next.js cache tags for a course after client-side mutations
 * (e.g. Refine assignment update). Requires an authenticated staff session for the class.
 */
async function postHandler(request: NextRequest) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "cache_revalidate_tags");

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { classId?: number; tables?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const classId = body.classId;
    if (typeof classId !== "number" || !Number.isFinite(classId)) {
      return NextResponse.json({ error: "classId must be a number" }, { status: 400 });
    }

    // Only revalidate the tables the caller actually wrote. An unknown or absent list falls
    // back to the whole class-scoped set: correct, but it evicts bundles the write did not
    // touch, so callers should name their tables.
    const requestedTables = Array.isArray(body.tables)
      ? body.tables.filter((t): t is ClassScopedCachedTable =>
          (CLASS_SCOPED_CACHED_TABLES as readonly string[]).includes(t as string)
        )
      : undefined;
    const tables = requestedTables?.length ? requestedTables : CLASS_SCOPED_CACHED_TABLES;

    // A user may hold more than one non-disabled role in a class — the unique index is on
    // (user_id, role, class_id), not (user_id, class_id). `.maybeSingle()` 406s on >1 row and
    // would 500 a legitimate student+grader, so read every row and check for any staff role.
    // Same hazard `getUserRolesForCourse` works around in lib/ssrUtils.ts.
    const { data: roleRows, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("class_id", classId)
      .eq("user_id", user.id)
      .eq("disabled", false);

    if (roleError) {
      Sentry.captureException(roleError);
      return NextResponse.json({ error: "Unable to verify course role" }, { status: 500 });
    }

    const allowed = (roleRows ?? []).some(({ role }) => role === "instructor" || role === "grader" || role === "admin");
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tags = courseSsrTags(classId, tables);
    for (const tag of tags) {
      revalidateTag(tag);
    }

    return NextResponse.json({ success: true, revalidated: tags.length });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// web_http_* instrumentation. The `route` label is the hardcoded parameterized
// pattern, never the request path — see lib/routeMetrics.ts.
export const POST = withRouteMetrics("/api/cache/revalidate-tags", postHandler);
