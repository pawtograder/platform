/**
 * Authentication module for Pawtograder MCP Server Edge Function
 * Uses OAuth flow with configurable OAuth endpoint
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { UserRole } from "./types.ts";

// OAuth configuration from environment variables
const OAUTH_ENDPOINT = Deno.env.get("MCP_OAUTH_ENDPOINT") || Deno.env.get("SUPABASE_URL") + "/auth/v1";
const OAUTH_CLIENT_ID = Deno.env.get("MCP_OAUTH_CLIENT_ID") || "";
const OAUTH_CLIENT_SECRET = Deno.env.get("MCP_OAUTH_CLIENT_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

/**
 * Exchange an authorization code for tokens using OAuth flow
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenResponse> {
  const tokenEndpoint = `${OAUTH_ENDPOINT}/token`;

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID
    })
  });

  if (!response.ok) {
    const error: OAuthError = await response.json();
    throw new Error(error.error_description || error.error || "OAuth token exchange failed");
  }

  return await response.json();
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const tokenEndpoint = `${OAUTH_ENDPOINT}/token`;

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID
    })
  });

  if (!response.ok) {
    const error: OAuthError = await response.json();
    throw new Error(error.error_description || error.error || "OAuth token refresh failed");
  }

  return await response.json();
}

/**
 * Creates a Supabase client with user's access token
 */
export function createAuthenticatedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

/**
 * Verifies that the user exists and returns their user ID
 */
export async function verifyUser(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
    error
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Invalid or expired authentication token");
  }

  return user.id;
}

/**
 * Gets the user's roles across all classes
 * Returns only instructor and grader roles (students are excluded from MCP access)
 */
export async function getUserRoles(supabase: SupabaseClient, userId: string): Promise<UserRole[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("class_id, role, private_profile_id")
    .eq("user_id", userId)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"]);

  if (error) {
    throw new Error(`Failed to fetch user roles: ${error.message}`);
  }

  return (data || []).map((row) => ({
    class_id: row.class_id,
    role: row.role as "instructor" | "grader",
    private_profile_id: row.private_profile_id
  }));
}

/**
 * Checks if user has instructor or grader role for a specific class
 */
export function hasAccessToClass(roles: UserRole[], classId: number): boolean {
  return roles.some((role) => role.class_id === classId && (role.role === "instructor" || role.role === "grader"));
}

/**
 * Verifies user has access to the specified class
 * Throws an error if access is denied
 */
export function requireClassAccess(roles: UserRole[], classId: number): void {
  if (!hasAccessToClass(roles, classId)) {
    throw new Error(`Access denied: You must be an instructor or grader in this class`);
  }
}

/**
 * Extract access token from Authorization header
 */
export function extractAccessToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw new Error("Invalid Authorization header format. Expected: Bearer <token>");
  }

  return parts[1];
}

/**
 * Full authentication flow: verify token and get user roles
 */
export async function authenticateRequest(
  authHeader: string | undefined
): Promise<{ supabase: SupabaseClient; userId: string; roles: UserRole[] }> {
  const accessToken = extractAccessToken(authHeader);
  const supabase = createAuthenticatedClient(accessToken);
  const userId = await verifyUser(supabase);
  const roles = await getUserRoles(supabase, userId);

  // Ensure user has at least one instructor/grader role
  if (roles.length === 0) {
    throw new Error("Access denied: MCP server is only available to instructors and graders");
  }

  return { supabase, userId, roles };
}

/**
 * Get OAuth authorization URL for MCP clients
 */
export function getAuthorizationUrl(redirectUri: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile"
  });

  if (state) {
    params.set("state", state);
  }

  return `${OAUTH_ENDPOINT}/authorize?${params.toString()}`;
}

/**
 * Get OAuth configuration for clients
 */
export function getOAuthConfig() {
  return {
    authorization_endpoint: `${OAUTH_ENDPOINT}/authorize`,
    token_endpoint: `${OAUTH_ENDPOINT}/token`,
    client_id: OAUTH_CLIENT_ID
    // Note: client_secret is NOT exposed to clients
  };
}
