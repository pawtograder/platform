import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import * as Sentry from "@sentry/nextjs";

/**
 * Cache invalidation endpoint for PostgreSQL triggers
 *
 * This endpoint is called asynchronously by PostgreSQL triggers via pg_net
 * to invalidate Vercel cache tags when data changes in the database.
 *
 * Security: Validates x-cache-invalidation-secret header against
 * CACHE_INVALIDATION_SECRET environment variable.
 */
export async function POST(request: NextRequest) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "cache_invalidate");

  try {
    // Validate secret header
    const secret = request.headers.get("x-cache-invalidation-secret");
    const expectedSecret = process.env.CACHE_INVALIDATION_SECRET;

    if (!expectedSecret) {
      scope.setTag("error_type", "missing_secret_config");
      Sentry.captureMessage("CACHE_INVALIDATION_SECRET not configured", {
        level: "error"
      });
      return NextResponse.json({ error: "Cache invalidation not configured" }, { status: 500 });
    }

    if (!secret || secret !== expectedSecret) {
      scope.setTag("error_type", "invalid_secret");
      Sentry.captureMessage("Cache invalidation request with invalid secret", {
        level: "warning"
      });
      return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
    }

    // Parse request body
    let body: { tags: string[] };
    try {
      body = await request.json();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      scope.setContext("parse_error", { error: errorMessage });
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    // Validate tags array
    if (!Array.isArray(body.tags) || body.tags.length === 0) {
      return NextResponse.json({ error: "tags must be a non-empty array" }, { status: 400 });
    }

    // Revalidate each tag
    const results: { tag: string; success: boolean }[] = [];
    for (const tag of body.tags) {
      try {
        if (typeof tag !== "string" || tag.trim().length === 0) {
          results.push({ tag, success: false });
          continue;
        }
        revalidateTag(tag);
        results.push({ tag, success: true });
      } catch (error) {
        scope.captureException(error, {
          tags: { tag },
          level: "warning"
        });
        results.push({ tag, success: false });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    scope.setContext("invalidation_result", {
      total: results.length,
      success: successCount,
      failures: failureCount
    });

    // Return results
    return NextResponse.json({
      success: true,
      invalidated: successCount,
      failed: failureCount,
      results
    });
  } catch (error) {
    scope.setTag("error_type", "unexpected_error");
    scope.captureException(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
