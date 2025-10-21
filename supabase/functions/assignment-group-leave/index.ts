import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { TZDate } from "npm:@date-fns/tz";
import {
  archiveRepoAndLock,
  enqueueGithubArchiveRepo,
  enqueueSyncRepoPermissions,
  syncRepoPermissions
} from "../_shared/GitHubWrapper.ts";
import {
  IllegalArgumentError,
  SecurityError,
  assertUserIsInCourse,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
async function handleAssignmentGroupLeave(req: Request, scope: Sentry.Scope): Promise<{ message: string }> {
  const { assignment_id } = (await req.json()) as { assignment_id: number };
  scope?.setTag("function", "assignment-group-leave");
  scope?.setTag("assignment_id", assignment_id.toString());
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("*, classes(time_zone)")
    .eq("id", assignment_id)
    .single();
  if (!assignment) {
    throw new IllegalArgumentError("Assignment not found");
  }
  const timeZone = assignment.classes.time_zone || "America/New_York";
  const groupFormationDeadline = assignment.group_formation_deadline;
  if (groupFormationDeadline && new TZDate(groupFormationDeadline, timeZone) < TZDate.tz(timeZone)) {
    throw new SecurityError("Group formation deadline has passed");
  }
  const { enrollment } = await assertUserIsInCourse(assignment.class_id, req.headers.get("Authorization")!);

  const { data: membership } = await adminSupabase
    .from("assignment_groups_members")
    .select("*, assignments(slug), classes(*), assignment_groups(*, repositories(*))")
    .eq("assignment_id", assignment_id)
    .eq("profile_id", enrollment.private_profile_id)
    .single();
  if (!membership) {
    throw new IllegalArgumentError("You are not a member of any group for this assignment");
  }

  //OK I guess we can do it!
  const { error: remove_member_error } = await adminSupabase
    .from("assignment_groups_members")
    .delete()
    .eq("id", membership!.id);
  if (remove_member_error) {
    throw new Error("Failed to remove member from group");
  }

  //Get remaining members, update the repo permissions or archive it
  const { data: remaining_members, error: remaining_members_error } = await adminSupabase
    .from("assignment_groups_members")
    .select("*, profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))")
    .eq("assignment_group_id", membership!.assignment_group_id);
  if (remaining_members_error) {
    console.error(remaining_members_error);
    throw new Error("Failed to get remaining members");
  }
  if (!remaining_members) {
    throw new Error("Failed to get remaining members");
  }
  const repository = membership.assignment_groups!.repositories[0];
  if (repository) {
    if (remaining_members.length === 0) {
      //Archive
      await enqueueGithubArchiveRepo(membership.class_id, membership.classes!.github_org!, repository.repository);
    } else {
      //Update the repo permissions
      await enqueueSyncRepoPermissions({
        class_id: membership.class_id,
        course_slug: membership.classes!.slug!,
        org: membership.classes!.github_org!,
        repo: repository.repository,
        githubUsernames: remaining_members.map((m) => m.profiles!.user_roles!.users!.github_username!),
        debug_id: `assignment-group-leave-${membership.assignment_group_id}`
      });
    }
  }
  return {
    message: "You have left the group"
  };
}
Deno.serve((req) => {
  return wrapRequestHandler(req, handleAssignmentGroupLeave);
});
