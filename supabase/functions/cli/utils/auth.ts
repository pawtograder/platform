/**
 * Authorization helpers for CLI commands.
 *
 * The MCP token scope check (cli:read / cli:write) only verifies the caller holds
 * a CLI-capable token — it says nothing about *which* classes they may touch. The
 * token gate in MCPAuth admits anyone who is an instructor or grader in at least
 * one class, so scope alone would let a grader in one course reach every course
 * on the deployment.
 *
 * Per-class authorization is enforced here, against user_roles. Every CLI handler
 * runs on the service-role client, which bypasses RLS, so these checks are the
 * only thing enforcing class boundaries. `tests/unit/cli-command-authorization.test.ts`
 * audits every registered command for one of them.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import { CLICommandError } from "../errors.ts";

/** Roles that grant a CLI caller access to a class's data. */
const CLI_CLASS_ROLES = ["instructor", "grader"] as const;

/**
 * The classes `userId` may act on, as a set of class ids.
 *
 * For commands that enumerate rather than target a single class (`classes.list`),
 * where there is nothing to assert against. Returns an empty array when the user
 * has no active staff role anywhere, and callers should render that as an empty
 * result rather than an error.
 *
 * Note that `admin` is deliberately not included: `authenticateMCPRequest` only
 * issues a working context to instructors and graders, so a platform admin who
 * needs CLI access holds an instructor role in the class. Accepting `admin` here
 * would grant broader access than the token gate itself.
 */
export async function listAccessibleClassIds(supabase: SupabaseClient<Database>, userId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("class_id")
    .eq("user_id", userId)
    .eq("disabled", false)
    .in("role", CLI_CLASS_ROLES);

  if (error) throw new CLICommandError(`Failed to verify class access: ${error.message}`, 500);
  return [...new Set((data ?? []).map((row) => row.class_id))];
}

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

/**
 * Throws 403 unless `userId` has an active instructor role in the class.
 * Graders are deliberately excluded: commands gated on this mutate
 * course-wide state (closing another person's help request, creating review
 * assignments for the whole staff) rather than acting on the caller's own work.
 */
export async function assertUserIsClassInstructor(
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
    .eq("role", "instructor")
    .limit(1)
    .maybeSingle();

  if (error) throw new CLICommandError(`Failed to verify class access: ${error.message}`, 500);
  if (!data) {
    throw new CLICommandError("This command requires instructor access to the class", 403);
  }
}

/**
 * The caller's private profile id in a class.
 *
 * Attribution columns (`help_requests.resolved_by`,
 * `review_assignments.completed_by`, …) hold private *profile* ids, not auth
 * user ids, so any command that writes one has to make this hop first.
 */
export async function getCallerPrivateProfileId(
  supabase: SupabaseClient<Database>,
  userId: string,
  classId: number
): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", userId)
    .eq("class_id", classId)
    .eq("disabled", false)
    .limit(1)
    .maybeSingle();

  if (error) throw new CLICommandError(`Failed to resolve your profile in this class: ${error.message}`, 500);
  if (!data) throw new CLICommandError("You do not have a role in this class", 403);
  return data.private_profile_id;
}
