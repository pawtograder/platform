import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createHmac, randomUUID } from "crypto";
import * as Sentry from "@sentry/nextjs";

/**
 * MCP Token Management API
 *
 * Endpoints:
 * - GET: List all tokens for the current user
 * - POST: Create a new API token
 *
 * Authentication: Requires valid Supabase session (dashboard login)
 */

const MCP_TOKEN_PREFIX = "mcp_";
const MCP_JWT_SECRET = process.env.MCP_JWT_SECRET;
const DEFAULT_EXPIRY_DAYS = 90;

// Scopes available for MCP tokens
type MCPScope = "mcp:read" | "mcp:write";
const VALID_SCOPES: MCPScope[] = ["mcp:read", "mcp:write"];

interface CreateTokenRequest {
  name: string;
  scopes?: MCPScope[];
  expires_in_days?: number;
}

/**
 * Base64url encode a buffer
 */
function base64UrlEncode(buffer: Buffer | string): string {
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString("base64") : Buffer.from(buffer).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create a signed MCP API token using HMAC-SHA256
 */
function createApiToken(userId: string, scopes: MCPScope[], tokenId: string, expiresInDays: number): string {
  if (!MCP_JWT_SECRET || MCP_JWT_SECRET.length < 32) {
    throw new Error("MCP_JWT_SECRET not configured or too short");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInDays * 24 * 60 * 60;

  // JWT Header
  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  // JWT Payload
  const payload = {
    sub: userId,
    scopes,
    jti: tokenId,
    iss: "pawtograder",
    aud: "mcp",
    iat: now,
    exp: expiresAt
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  // Create signature
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", MCP_JWT_SECRET).update(signatureInput).digest();
  const encodedSignature = base64UrlEncode(signature);

  // Return complete JWT
  return MCP_TOKEN_PREFIX + `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * GET /api/mcp-tokens
 * List all tokens for the current user
 */
export async function GET(): Promise<NextResponse> {
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

    // Check if user has instructor/grader role
    const { data: roles } = await supabase
      .from("user_roles")
      .select("class_id, role")
      .eq("user_id", user.id)
      .eq("disabled", false)
      .in("role", ["instructor", "grader"]);

    if (!roles || roles.length === 0) {
      return NextResponse.json({ error: "MCP tokens are only available to instructors and graders" }, { status: 403 });
    }

    // Get user's tokens
    const { data: tokens, error: tokensError } = await supabase
      .from("api_tokens")
      .select("id, name, scopes, expires_at, revoked_at, created_at, last_used_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (tokensError) {
      Sentry.captureException(tokensError, {
        tags: { endpoint: "mcp_tokens", operation: "list" }
      });
      return NextResponse.json({ error: "Failed to fetch tokens" }, { status: 500 });
    }

    return NextResponse.json({ tokens: tokens || [] });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "mcp_tokens", operation: "list" }
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/mcp-tokens
 * Create a new API token
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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

    // Check if user has instructor/grader role
    const { data: roles } = await supabase
      .from("user_roles")
      .select("class_id, role")
      .eq("user_id", user.id)
      .eq("disabled", false)
      .in("role", ["instructor", "grader"]);

    if (!roles || roles.length === 0) {
      return NextResponse.json({ error: "MCP tokens are only available to instructors and graders" }, { status: 403 });
    }

    // Parse request body
    let body: CreateTokenRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Validate name
    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json({ error: "Token name is required" }, { status: 400 });
    }

    if (body.name.length > 100) {
      return NextResponse.json({ error: "Token name too long" }, { status: 400 });
    }

    // Validate scopes
    const scopes: MCPScope[] = body.scopes || ["mcp:read"];
    if (!Array.isArray(scopes) || !scopes.every((s) => VALID_SCOPES.includes(s))) {
      return NextResponse.json(
        { error: `Invalid scopes. Valid scopes are: ${VALID_SCOPES.join(", ")}` },
        { status: 400 }
      );
    }

    // Validate expiry
    const expiresInDays = body.expires_in_days || DEFAULT_EXPIRY_DAYS;
    if (typeof expiresInDays !== "number" || expiresInDays < 1 || expiresInDays > 365) {
      return NextResponse.json({ error: "expires_in_days must be between 1 and 365" }, { status: 400 });
    }

    // Generate token ID
    const tokenId = randomUUID();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    // Create the JWT token
    const token = createApiToken(user.id, scopes, tokenId, expiresInDays);

    // Store token metadata in database
    const { data: tokenRecord, error: insertError } = await supabase
      .from("api_tokens")
      .insert({
        user_id: user.id,
        name: body.name.trim(),
        token_id: tokenId,
        scopes,
        expires_at: expiresAt.toISOString()
      })
      .select("id, name, scopes, expires_at, created_at")
      .single();

    if (insertError) {
      Sentry.captureException(insertError, {
        tags: { endpoint: "mcp_tokens", operation: "create" }
      });
      return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
    }

    // Return the token (only shown once!)
    return NextResponse.json({
      token,
      metadata: tokenRecord,
      message: "Token created successfully. Save this token - it will only be shown once!"
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "mcp_tokens", operation: "create" }
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
