import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { TZDate } from "npm:@date-fns/tz";
import type { AssignmentGroupJoinRequest } from "../_shared/FunctionTypes.d.ts";
import { syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import {
  IllegalArgumentError,
  SecurityError,
  UserVisibleError,
  assertUserIsInCourse,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
async function handleAssignmentGroupJoin(req: Request): Promise<{ message: string; joined_group: boolean }> {
  const { assignment_group_id } = (await req.json()) as AssignmentGroupJoinRequest;
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: assignmentGroup } = await adminSupabase
    .from("assignment_groups")
    .select("*, assignments(*), classes(github_org, slug, time_zone), repositories(*)")
    .eq("id", assignment_group_id)
    .single();
  if (!assignmentGroup) {
    throw new IllegalArgumentError("Assignment group not found");
  }
  console.log(JSON.stringify(assignmentGroup, null, 2));
  const timeZone = assignmentGroup.classes.time_zone || "America/New_York";
  const groupFormationDeadline = assignmentGroup.assignments.group_formation_deadline;
  if (groupFormationDeadline && new TZDate(groupFormationDeadline, timeZone) < TZDate.tz(timeZone)) {
    throw new SecurityError("Group formation deadline has passed");
  }
  //Validate user for this course
  const { enrollment } = await assertUserIsInCourse(assignmentGroup.class_id, req.headers.get("Authorization")!);

  //Ensure not already in group
  const { data: existingMember } = await adminSupabase
    .from("assignment_groups_members")
    .select("*")
    .eq("assignment_group_id", assignment_group_id)
    .eq("profile_id", enrollment.private_profile_id);
  console.log(existingMember);
  if (existingMember && existingMember.length > 0) {
    throw new IllegalArgumentError("You are already in this group");
  }

  //Check for invitation
  const { data: invitation } = await adminSupabase
    .from("assignment_group_invitations")
    .select("*")
    .eq("invitee", enrollment.private_profile_id)
    .eq("assignment_group_id", assignment_group_id);
  if (invitation && invitation.length > 0) {
    //Invitation found, add directly to the group
    const { error } = await adminSupabase.from("assignment_groups_members").insert({
      assignment_group_id,
      profile_id: enrollment.private_profile_id,
      assignment_id: assignmentGroup.assignment_id,
      class_id: assignmentGroup.class_id,
      added_by: invitation[0].inviter
    });
    if (error) {
      console.log(error);
      throw new Error("Failed to add to group");
    }
    //Delete invitation
    const { error: deleteError } = await adminSupabase
      .from("assignment_group_invitations")
      .delete()
      .eq("id", invitation[0].id);
    if (deleteError) {
      console.log(deleteError);
      throw new Error("Failed to delete invitation");
    }
    //Sync repo permissions
    const { data: remaining_members, error: remaining_members_error } = await adminSupabase
      .from("assignment_groups_members")
      .select(
        "*,classes(github_org), profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))"
      )
      .eq("assignment_group_id", assignment_group_id);
    if (remaining_members) {
      await syncRepoPermissions(
        assignmentGroup.classes!.github_org!,
        assignmentGroup.repositories[0].repository,
        assignmentGroup.classes!.slug!,
        remaining_members.map((m) => m.profiles!.user_roles!.users!.github_username!)
      );
    } else if (remaining_members_error) {
      console.log(remaining_members_error);
      throw new UserVisibleError("Failed to get remaining members");
    }
    //Deactivate any submissions for this assignment for this student
    const { error: deactivateError } = await adminSupabase
      .from("submissions")
      .update({
        is_active: false
      })
      .eq("assignment_id", assignmentGroup.assignment_id)
      .eq("profile_id", enrollment.private_profile_id);
    if (deactivateError) {
      console.log(deactivateError);
      throw new Error("Failed to deactivate submissions");
    }
    return {
      joined_group: true,
      message: `Joined group ${assignmentGroup.name}`
    };
  } else {
    //Ensure no join requests
    const { data: joinRequest } = await adminSupabase
      .from("assignment_group_join_request")
      .select("*")
      .eq("assignment_group_id", assignment_group_id)
      .eq("profile_id", enrollment.private_profile_id)
      .eq("status", "pending");
    if (joinRequest && joinRequest.length > 0) {
      throw new IllegalArgumentError(
        "You have already requested to join this group. Please wait for approval from a group members."
      );
    }
    //Create join request
    const { error: createError } = await adminSupabase.from("assignment_group_join_request").insert({
      assignment_group_id,
      profile_id: enrollment.private_profile_id,
      class_id: assignmentGroup.class_id,
      assignment_id: assignmentGroup.assignment_id,
      status: "pending"
    });
    if (createError) {
      console.log(createError);
      throw new Error("Failed to create join request");
    }
    return {
      joined_group: false,
      message: `Requested to join group ${assignmentGroup.name}. Please wait for approval from a current member of the group.`
    };
  }
}

Deno.serve((req) => {
  return wrapRequestHandler(req, handleAssignmentGroupJoin);
});
