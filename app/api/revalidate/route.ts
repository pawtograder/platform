import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

/**
 * API route for cache tag revalidation
 * Called by the cache-invalidation-worker edge function when database changes occur
 *
 * POST /api/revalidate
 * Headers:
 *   x-revalidation-secret: Secret token for authentication
 * Body:
 *   { tag: string } - Cache tag to invalidate
 *
 * Example:
 *   { "tag": "course_controller:123:staff" }
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const secret = request.headers.get("x-revalidation-secret");

    if (!process.env.REVALIDATION_SECRET) {
      return NextResponse.json({ error: "Server not configured for revalidation" }, { status: 500 });
    }

    if (secret !== process.env.REVALIDATION_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    const body = await request.json();
    const { tag } = body;

    if (!tag || typeof tag !== "string") {
      return NextResponse.json({ error: "Invalid tag parameter" }, { status: 400 });
    }

    // Validate tag format (basic safety check)
    if (tag.length > 200 || !/^[a-zA-Z0-9_:-]+$/.test(tag)) {
      return NextResponse.json({ error: "Invalid tag format" }, { status: 400 });
    }

    // Revalidate the cache tag
    revalidateTag(tag);

    return NextResponse.json({
      revalidated: true,
      tag,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Revalidation error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}

