/**
 * Authentication module for Pawtograder MCP Server
 * Handles Supabase OAuth authentication and role verification
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "./types.js";

// Environment variables for Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing required environment variables: SUPABASE_URL and SUPABASE_ANON_KEY");
}

/**
 * Creates a Supabase client with user's access token
 */
export function createAuthenticatedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Verifies that the user exists and returns their user ID
 */
export async function verifyUser(supabase: SupabaseClient): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();

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
    private_profile_id: row.private_profile_id,
  }));
}

/**
 * Checks if user has instructor or grader role for a specific class
 */
export function hasAccessToClass(roles: UserRole[], classId: number): boolean {
  return roles.some(
    (role) => role.class_id === classId && (role.role === "instructor" || role.role === "grader")
  );
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
