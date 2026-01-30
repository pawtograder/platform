import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import * as Sentry from "@sentry/nextjs";

/**
 * MCP Token Management API - Single Token Operations
 *
 * Endpoints:
 * - DELETE: Revoke a token
 *
 * Authentication: Requires valid Supabase session (dashboard login)
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * DELETE /api/mcp-tokens/[id]
 * Revoke (soft delete) a token
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  try {
    const supabase = await createClient();

    // Get current user
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check that the token belongs to this user and revoke it
    const { data: token, error: updateError } = await supabase
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .select("id")
      .single();

    if (updateError) {
      if (updateError.code === "PGRST116") {
        // No rows returned - token doesn't exist, doesn't belong to user, or already revoked
        return NextResponse.json({ error: "Token not found or already revoked" }, { status: 404 });
      }
      Sentry.captureException(updateError, {
        tags: { endpoint: "mcp_tokens", operation: "revoke" },
        extra: { token_id: id }
      });
      return NextResponse.json({ error: "Failed to revoke token" }, { status: 500 });
    }

    if (!token) {
      return NextResponse.json({ error: "Token not found or already revoked" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Token revoked successfully" });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "mcp_tokens", operation: "revoke" },
      extra: { token_id: id }
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
