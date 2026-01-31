/**
 * MCP Authentication Utilities
 *
 * Handles:
 * - API token (long-lived JWT) verification
 * - Short-lived Supabase JWT minting for RLS
 * - Token revocation checks
 * - Scope validation
 */

import { create, verify, decode, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "./SupabaseTypes.d.ts";

// Environment variable names
const MCP_JWT_SECRET_ENV = "MCP_JWT_SECRET";
const SUPABASE_JWT_SECRET_ENV = "SUPABASE_JWT_SECRET";
const SUPABASE_URL_ENV = "SUPABASE_URL";
const SUPABASE_ANON_KEY_ENV = "SUPABASE_ANON_KEY";

// Token prefix for MCP API tokens
export const MCP_TOKEN_PREFIX = "mcp_";

// Available scopes
export type MCPScope = "mcp:read" | "mcp:write";
export const VALID_SCOPES: MCPScope[] = ["mcp:read", "mcp:write"];

// API Token payload
export interface MCPApiTokenPayload {
  sub: string; // User ID
  scopes: MCPScope[];
  jti: string; // Token ID for revocation
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

// Authenticated context passed to MCP handlers
export interface MCPAuthContext {
  userId: string;
  scopes: MCPScope[];
  tokenId: string;
  supabase: SupabaseClient<Database>;
}

// Cache for minted Supabase JWTs (per user_id)
const supabaseJwtCache = new Map<string, { jwt: string; expiresAt: number }>();

/**
 * Get the crypto key for MCP JWT signing/verification
 */
async function getMcpJwtKey(): Promise<CryptoKey> {
  const secret = Deno.env.get(MCP_JWT_SECRET_ENV);
  if (!secret || secret.length < 32) {
    throw new Error(`${MCP_JWT_SECRET_ENV} must be set and at least 32 characters`);
  }

  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Get the crypto key for Supabase JWT minting
 */
async function getSupabaseJwtKey(): Promise<CryptoKey> {
  const secret = Deno.env.get(SUPABASE_JWT_SECRET_ENV);
  if (!secret || secret.length < 32) {
    throw new Error(`${SUPABASE_JWT_SECRET_ENV} must be set and at least 32 characters`);
  }

  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Create a new MCP API token
 * This should be called from a dashboard endpoint (not the MCP server itself)
 */
export async function createApiToken(
  userId: string,
  scopes: MCPScope[],
  tokenId: string,
  expiresInDays: number = 90
): Promise<string> {
  const key = await getMcpJwtKey();
  const now = Date.now();
  const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;

  const payload: MCPApiTokenPayload = {
    sub: userId,
    scopes,
    jti: tokenId,
    iss: "pawtograder",
    aud: "mcp",
    exp: getNumericDate(new Date(expiresAt)),
    iat: getNumericDate(new Date(now))
  };

  const jwt = await create({ alg: "HS256", typ: "JWT" }, payload, key);
  return MCP_TOKEN_PREFIX + jwt;
}

/**
 * Verify and decode an MCP API token
 * Returns null if invalid or expired
 */
export async function verifyApiToken(token: string): Promise<MCPApiTokenPayload | null> {
  // Strip the mcp_ prefix if present
  if (token.startsWith(MCP_TOKEN_PREFIX)) {
    token = token.slice(MCP_TOKEN_PREFIX.length);
  }

  try {
    const key = await getMcpJwtKey();
    const payload = (await verify(token, key)) as MCPApiTokenPayload;

    // Validate required claims
    if (!payload.sub || !payload.jti || !payload.scopes) {
      console.error("Missing required claims in API token");
      return null;
    }

    // Validate audience
    if (payload.aud !== "mcp") {
      console.error("Invalid audience in API token");
      return null;
    }

    // Validate issuer
    if (payload.iss !== "pawtograder") {
      console.error("Invalid issuer in API token");
      return null;
    }

    // Validate scopes
    if (!Array.isArray(payload.scopes) || !payload.scopes.every((s) => VALID_SCOPES.includes(s))) {
      console.error("Invalid scopes in API token");
      return null;
    }

    return payload;
  } catch (error) {
    console.error("Failed to verify API token:", error);
    return null;
  }
}

/**
 * Check if a token has been revoked
 * Uses the revoked_token_ids table for fast lookup
 */
export async function isTokenRevoked(tokenId: string): Promise<boolean> {
  const adminSupabase = createClient<Database>(
    Deno.env.get(SUPABASE_URL_ENV)!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data, error } = await adminSupabase
    .from("revoked_token_ids")
    .select("token_id")
    .eq("token_id", tokenId)
    .maybeSingle();

  if (error) {
    console.error("Error checking token revocation:", error);
    // Fail closed - treat as revoked if we can't check
    return true;
  }

  return !!data;
}

/**
 * Mint a short-lived Supabase JWT for RLS
 * Cached for ~55 seconds per user to avoid minting on every request
 */
export async function mintSupabaseJwt(userId: string): Promise<string> {
  const now = Date.now();

  // Check cache first
  const cached = supabaseJwtCache.get(userId);
  if (cached && cached.expiresAt > now + 5000) {
    // 5 second buffer
    return cached.jwt;
  }

  // Mint a new JWT
  const key = await getSupabaseJwtKey();
  const expiresAt = now + 60 * 1000; // 60 seconds

  const payload = {
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    exp: getNumericDate(new Date(expiresAt)),
    iat: getNumericDate(new Date(now))
  };

  const jwt = await create({ alg: "HS256", typ: "JWT" }, payload, key);

  // Cache the JWT
  supabaseJwtCache.set(userId, { jwt, expiresAt });

  return jwt;
}

/**
 * Create a Supabase client authenticated as a specific user
 * Uses a short-lived JWT minted for that user
 */
export async function createAuthenticatedSupabaseClient(userId: string): Promise<SupabaseClient<Database>> {
  const jwt = await mintSupabaseJwt(userId);

  return createClient<Database>(Deno.env.get(SUPABASE_URL_ENV)!, Deno.env.get(SUPABASE_ANON_KEY_ENV)!, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

/**
 * Full authentication flow for MCP requests
 * Extracts token from Authorization header, validates, and creates authenticated client
 */
export async function authenticateMCPRequest(authHeader: string | null): Promise<MCPAuthContext> {
  if (!authHeader) {
    throw new MCPAuthError("Missing Authorization header");
  }

  // Extract token from Bearer header
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw new MCPAuthError("Invalid Authorization header format");
  }

  const token = parts[1];

  // Verify the API token
  const payload = await verifyApiToken(token);
  if (!payload) {
    throw new MCPAuthError("Invalid or expired API token");
  }

  // Check for revocation
  const revoked = await isTokenRevoked(payload.jti);
  if (revoked) {
    throw new MCPAuthError("API token has been revoked");
  }

  // Check that user has instructor/grader role somewhere
  // (This is an additional security check beyond the token)
  const adminSupabase = createClient<Database>(
    Deno.env.get(SUPABASE_URL_ENV)!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: roles, error: rolesError } = await adminSupabase
    .from("user_roles")
    .select("class_id, role")
    .eq("user_id", payload.sub)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"]);

  if (rolesError || !roles || roles.length === 0) {
    throw new MCPAuthError("User must be an instructor or grader to use MCP");
  }

  // Create authenticated Supabase client
  const supabase = await createAuthenticatedSupabaseClient(payload.sub);

  return {
    userId: payload.sub,
    scopes: payload.scopes,
    tokenId: payload.jti,
    supabase
  };
}

/**
 * Check if the auth context has a required scope
 */
export function hasScope(context: MCPAuthContext, scope: MCPScope): boolean {
  return context.scopes.includes(scope);
}

/**
 * Require a specific scope, throw if not present
 */
export function requireScope(context: MCPAuthContext, scope: MCPScope): void {
  if (!hasScope(context, scope)) {
    throw new MCPAuthError(`Missing required scope: ${scope}`);
  }
}

/**
 * Custom error class for MCP authentication errors
 */
export class MCPAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPAuthError";
  }
}

/**
 * Update last_used_at for a token (for auditing)
 * This is optional and can be called asynchronously
 */
export async function updateTokenLastUsed(tokenId: string): Promise<void> {
  try {
    const adminSupabase = createClient<Database>(
      Deno.env.get(SUPABASE_URL_ENV)!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await adminSupabase.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_id", tokenId);
  } catch (error) {
    // Non-critical, just log
    console.error("Failed to update token last_used_at:", error);
  }
}
