import { courseDerivedDataTags } from "@/lib/next-cache-tags";
import { createClient } from "@/utils/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import * as Sentry from "@sentry/nextjs";

/**
 * Revalidate Next.js `unstable_cache` tags for a course after client-side mutations
 * (e.g. Refine assignment update). Requires an authenticated staff session for the class.
 */
export async function POST(request: NextRequest) {
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

    let body: { classId?: number };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const classId = body.classId;
    if (typeof classId !== "number" || !Number.isFinite(classId)) {
      return NextResponse.json({ error: "classId must be a number" }, { status: 400 });
    }

    const { data: roleRow, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("class_id", classId)
      .eq("user_id", user.id)
      .eq("disabled", false)
      .maybeSingle();

    if (roleError) {
      Sentry.captureException(roleError);
      return NextResponse.json({ error: "Unable to verify course role" }, { status: 500 });
    }

    const r = roleRow?.role;
    const allowed = r === "instructor" || r === "grader" || r === "admin";
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    for (const tag of courseDerivedDataTags(classId)) {
      revalidateTag(tag);
    }

    return NextResponse.json({ success: true, revalidated: courseDerivedDataTags(classId).length });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
