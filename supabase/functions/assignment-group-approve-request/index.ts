import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { TZDate } from "npm:@date-fns/tz";
import { SecurityError, assertUserIsInCourse, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleAssignmentGroupApproveRequest(req: Request, scope: Sentry.Scope): Promise<{ message: string }> {
  const { join_request_id, course_id } = (await req.json()) as { join_request_id: number; course_id: number };
  scope?.setTag("function", "assignment-group-approve-request");
  scope?.setTag("join_request_id", join_request_id.toString());
  scope?.setTag("course_id", course_id.toString());
  const { enrollment } = await assertUserIsInCourse(course_id, req.headers.get("Authorization") || "");

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data, error } = await adminSupabase
    .from("assignment_group_join_request")
    .select("*, assignment_groups(*, assignments(*), assignment_groups_members(*))")
    .eq("id", join_request_id)
    .eq("assignment_groups.class_id", course_id)
    .single();
  if (error) {
    throw new Error("Failed to get join request");
  }
  const timeZone = enrollment.classes.time_zone || "America/New_York";
  const groupFormationDeadline = data.assignment_groups.assignments.group_formation_deadline;
  if (groupFormationDeadline && new TZDate(groupFormationDeadline, timeZone) < TZDate.tz(timeZone)) {
    //TODO timezones
    throw new SecurityError("Group formation deadline has passed");
  }
  // Make sure user is in the group
  const { data: group_members, error: group_members_error } = await adminSupabase
    .from("assignment_groups_members")
    .select("*")
    .eq("assignment_group_id", data.assignment_groups.id)
    .eq("profile_id", enrollment.private_profile_id)
    .single();
  if (group_members_error) {
    throw new Error("Failed to get group members");
  }
  if (!group_members) {
    throw new Error("You are not a member of this group");
  }
  // Make sure that there is a spot in the group
  const max_group_size = data.assignment_groups.assignments.max_group_size;
  const curCount = data.assignment_groups.assignment_groups_members.length;
  if (!max_group_size || curCount >= max_group_size) {
    throw new Error("Group is full");
  }
  // Add user to group
  const { error: add_member_error } = await adminSupabase.from("assignment_groups_members").insert({
    assignment_group_id: data.assignment_groups.id,
    profile_id: data.profile_id,
    added_by: enrollment.private_profile_id,
    assignment_id: data.assignment_groups.assignments.id,
    class_id: course_id
  });
  if (add_member_error) {
    console.log(add_member_error);
    throw new Error("Failed to add user to group");
  }
  //Update join request status
  const { error: update_error } = await adminSupabase
    .from("assignment_group_join_request")
    .update({
      status: "approved",
      decision_maker: enrollment.private_profile_id
    })
    .eq("id", join_request_id);
  if (update_error) {
    throw new Error("Failed to update join request status");
  }

  //Deactivate any submissions for this assignment for this student
  const { error: deactivateError } = await adminSupabase
    .from("submissions")
    .update({
      is_active: false
    })
    .eq("assignment_id", data.assignment_groups.assignments.id)
    .eq("is_active", true)
    .eq("profile_id", data.profile_id);
  if (deactivateError) {
    console.error(deactivateError);
    throw new Error("Failed to deactivate submissions");
  }

  return {
    message: `Join request approved for group ${data.assignment_groups.name}`
  };
}
Deno.serve((req) => {
  return wrapRequestHandler(req, handleAssignmentGroupApproveRequest);
});
