/**
 * MCP Token Management Edge Function
 *
 * Endpoints:
 * - GET: List all tokens for the current user
 * - POST: Create a new API token
 * - DELETE: Revoke a token
 *
 * Authentication: Requires valid Supabase session (dashboard login)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { createApiToken, MCPScope, VALID_SCOPES } from "../_shared/MCPAuth.ts";

// Initialize Sentry if configured
if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA")
  });
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
};

const DEFAULT_EXPIRY_DAYS = 90;

interface CreateTokenRequest {
  name: string;
  scopes?: MCPScope[];
  expires_in_days?: number;
}

interface DeleteTokenRequest {
  token_id: string;
}

/**
 * Authenticate user from Authorization header
 */
async function authenticateUser(authHeader: string | null) {
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Error("Unauthorized");
  }

  return { supabase, user };
}

/**
 * Check if user has instructor/grader role
 */
async function assertUserIsInstructorOrGrader(
  supabase: ReturnType<typeof createClient<Database>>,
  userId: string
): Promise<void> {
  const { data: roles, error } = await supabase
    .from("user_roles")
    .select("class_id, role")
    .eq("user_id", userId)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .limit(1);

  if (error || !roles || roles.length === 0) {
    throw new Error("MCP tokens are only available to instructors and graders");
  }
}

/**
 * GET handler - List all tokens for the current user
 */
async function handleGet(authHeader: string | null): Promise<Response> {
  const { supabase, user } = await authenticateUser(authHeader);
  await assertUserIsInstructorOrGrader(supabase, user.id);

  const { data: tokens, error: tokensError } = await supabase
    .from("api_tokens")
    .select("id, token_id, name, scopes, expires_at, revoked_at, created_at, last_used_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (tokensError) {
    Sentry.captureException(tokensError, {
      tags: { endpoint: "mcp_tokens", operation: "list" }
    });
    throw new Error("Failed to fetch tokens");
  }

  return new Response(JSON.stringify({ tokens: tokens || [] }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

/**
 * POST handler - Create a new API token
 */
async function handlePost(authHeader: string | null, body: CreateTokenRequest): Promise<Response> {
  const { supabase, user } = await authenticateUser(authHeader);
  await assertUserIsInstructorOrGrader(supabase, user.id);

  // Validate name
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return new Response(JSON.stringify({ error: "Token name is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (body.name.length > 100) {
    return new Response(JSON.stringify({ error: "Token name too long" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Validate scopes
  const scopes: MCPScope[] = body.scopes || ["mcp:read"];
  if (!Array.isArray(scopes) || !scopes.every((s) => VALID_SCOPES.includes(s))) {
    return new Response(JSON.stringify({ error: `Invalid scopes. Valid scopes are: ${VALID_SCOPES.join(", ")}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Validate expiry (use nullish coalescing to properly handle 0 or invalid values)
  const rawExpiry = body.expires_in_days ?? DEFAULT_EXPIRY_DAYS;
  const expiresInDays = Number.isFinite(rawExpiry) ? rawExpiry : DEFAULT_EXPIRY_DAYS;
  if (expiresInDays < 1 || expiresInDays > 365) {
    return new Response(JSON.stringify({ error: "expires_in_days must be between 1 and 365" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Generate token ID
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // Create the JWT token
  const token = await createApiToken(user.id, scopes, tokenId, expiresInDays);

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
    throw new Error("Failed to create token");
  }

  return new Response(
    JSON.stringify({
      token,
      metadata: tokenRecord,
      message: "Token created successfully. Save this token - it will only be shown once!"
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    }
  );
}

/**
 * DELETE handler - Revoke a token
 */
async function handleDelete(authHeader: string | null, body: DeleteTokenRequest): Promise<Response> {
  const { supabase, user } = await authenticateUser(authHeader);

  if (!body.token_id || typeof body.token_id !== "string") {
    return new Response(JSON.stringify({ error: "token_id is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Get token to verify ownership
  const { data: token, error: tokenError } = await supabase
    .from("api_tokens")
    .select("id, token_id, user_id")
    .eq("token_id", body.token_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (tokenError) {
    Sentry.captureException(tokenError, {
      tags: { endpoint: "mcp_tokens", operation: "delete" }
    });
    throw new Error("Failed to find token");
  }

  if (!token) {
    return new Response(JSON.stringify({ error: "Token not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Update token to mark as revoked
  const { error: updateError } = await supabase
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", token.id);

  if (updateError) {
    Sentry.captureException(updateError, {
      tags: { endpoint: "mcp_tokens", operation: "delete" }
    });
    throw new Error("Failed to revoke token");
  }

  // Add to revoked_token_ids for fast lookup
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { error: revokeInsertError } = await adminSupabase
    .from("revoked_token_ids")
    .insert({ token_id: body.token_id });

  if (revokeInsertError) {
    // Log but don't fail - the token is already marked revoked in api_tokens
    // The revoked_token_ids table is just for fast lookup optimization
    Sentry.captureException(revokeInsertError, {
      tags: { endpoint: "mcp_tokens", operation: "revoke_insert" },
      extra: { token_id: body.token_id }
    });
  }

  return new Response(JSON.stringify({ success: true, message: "Token revoked successfully" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

/**
 * Main handler
 */
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");

  try {
    if (req.method === "GET") {
      return await handleGet(authHeader);
    }

    if (req.method === "POST") {
      const body = await req.json();
      return await handlePost(authHeader, body);
    }

    if (req.method === "DELETE") {
      const body = await req.json();
      return await handleDelete(authHeader, body);
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "mcp_tokens" }
    });

    const message = error instanceof Error ? error.message : "Internal server error";
    const status =
      message === "Unauthorized" || message === "Missing Authorization header"
        ? 401
        : message.includes("only available to")
          ? 403
          : 500;

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
