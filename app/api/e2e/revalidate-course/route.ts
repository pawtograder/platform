import { courseTag } from "@/lib/next-cache-tags";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

// Read E2E_ENABLE per request, never at build time.
export const dynamic = "force-dynamic";

/**
 * E2E-only stand-in for the `classes` cache-invalidation webhook. In production, updating a
 * class fires `invalidate_course_cache()`, which POSTs `course:<id>` to `/api/cache/invalidate`
 * through pg_net. The local and CI stacks have no `vercel_host` in the vault, so that call never
 * happens and `getCourse()` keeps a stale course (features included) for up to its 1-hour TTL.
 * `setCourseFeature` in `tests/e2e/TestingUtils.ts` calls this after each change instead.
 *
 * It 404s unless the server runs with `E2E_ENABLE=true`, which the Helm chart sets only for
 * preview and test deploys (`web.e2e.enabled`, never production). It only evicts the one
 * course tag, the same thing the production webhook does for that update.
 */
export async function POST(request: NextRequest) {
  if (process.env.E2E_ENABLE !== "true") {
    return new NextResponse(null, { status: 404 });
  }
  let classId: unknown;
  try {
    ({ classId } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  if (typeof classId !== "number" || !Number.isInteger(classId) || classId <= 0) {
    return NextResponse.json({ error: "classId must be a positive integer" }, { status: 400 });
  }
  revalidateTag(courseTag(classId));
  return NextResponse.json({ success: true });
}
