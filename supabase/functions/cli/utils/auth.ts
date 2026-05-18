/**
 * Authorization helpers for CLI commands.
 *
 * The MCP token scope check (cli:read / cli:write) only verifies the caller
 * holds a CLI-capable token; per-class authorization is enforced separately
 * via user_roles. Service-role queries bypass RLS, so this check is
 * load-bearing for any CLI command that reads class-scoped data.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import { CLICommandError } from "../errors.ts";

/**
 * Throws 403 unless `userId` has an active instructor or grader role in the
 * class. Used by every command that reads class-scoped student data.
 */
export async function assertUserCanAccessClass(
  supabase: SupabaseClient<Database>,
  userId: string,
  classId: number
): Promise<void> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("class_id", classId)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .limit(1)
    .maybeSingle();

  if (error) throw new CLICommandError(`Failed to verify class access: ${error.message}`, 500);
  if (!data) {
    throw new CLICommandError("You do not have instructor/grader access to this class", 403);
  }
}
