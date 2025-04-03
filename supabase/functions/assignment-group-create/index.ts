import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { AssignmentGroupCreateRequest, GenericResponse } from "../_shared/FunctionTypes.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  SecurityError,
  UserVisibleError,
  wrapRequestHandler,
  IllegalArgumentError,
} from "../_shared/HandlerUtils.ts";
async function createAutograderGroup(req: Request): Promise<{ message: string }> {
  //Get the user
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! },
      },
    },
  );
  const { course_id, assignment_id, name, invitees } = await req.json() as AssignmentGroupCreateRequest;
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new IllegalArgumentError("Group name cannot be empty");
  }
  //Valid group names are alphanumeric, hyphens, or underscore, max 36 characters
  if (!/^[a-zA-Z0-9_-]{1,36}$/.test(trimmedName)) {
    throw new IllegalArgumentError("Group name consist only of alphanumeric, hyphens, or underscores, and be less than 36 characters");
  }
  console.log(course_id, assignment_id, trimmedName, invitees);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new SecurityError("User not found");
  }
  //Validate that the user is in the course
  const { data: profile } = await supabase.from("user_roles").select("*")
    .eq("user_id", user.id)
    .eq("role", "student")
    .eq("class_id", course_id)
    .single();
  if (!profile) {
    throw new SecurityError("User not found");
  }
  const profile_id = profile.private_profile_id;
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  //Validate that the user does not have an open group request for this assignment
  const { data: pendingGroupRequest } = await adminSupabase.from("assignment_group_join_request")
    .select("*")
    .eq("profile_id", profile_id)
    .eq("assignment_id", assignment_id)
    .eq("status", "pending");
  if (pendingGroupRequest && pendingGroupRequest.length > 0) {
    throw new IllegalArgumentError("You already have a pending group request for this assignment");
  }

  //Validate that the user is not in a group for this assignment
  const { data: existingAssignmentGroup } = await adminSupabase.from("assignment_groups_members").select("*")
    .eq("assignment_id", assignment_id)
    .eq("profile_id", profile_id);
  if (existingAssignmentGroup && existingAssignmentGroup.length > 0) {
    throw new IllegalArgumentError("You are already in a group for this assignment");
  }

  //Validate that the group has a unique name for this assignment
  const { data: existingAssignmentGroupWithSameName } = await adminSupabase.from("assignment_groups").select("*")
    .eq("assignment_id", assignment_id)
    .eq("name", trimmedName);
  if (existingAssignmentGroupWithSameName && existingAssignmentGroupWithSameName.length > 0) {
    throw new IllegalArgumentError("A group with this name already exists for this assignment");
  }

  const { data: assignment } = await adminSupabase.from("assignments").select("*").eq("id", assignment_id).single();
  if (!assignment) {
    throw new IllegalArgumentError("Assignment not found");
  }
  const groupFormationDeadline = assignment.group_formation_deadline;
  if (groupFormationDeadline && new Date(groupFormationDeadline) < new Date()) {
    //TODO timezones
    throw new SecurityError("Group formation deadline has passed");
  }
  //Create a new group
  const { data: newGroup, error: newGroupError } = await adminSupabase.from("assignment_groups").insert({
    name: trimmedName,
    assignment_id: assignment_id,
    class_id: course_id,
  }).select("id").single();
  if (newGroupError) {
    console.error(newGroupError);
    throw new UserVisibleError("Failed to create group");
  }
  //Enroll the user in the group
  const { error: enrollmentError } = await adminSupabase.from("assignment_groups_members").insert({
    assignment_group_id: newGroup.id,
    profile_id: profile_id,
    assignment_id: assignment_id,
    class_id: course_id,
    added_by: profile_id,
  });
  if (enrollmentError) {
    console.error(enrollmentError);
    throw new UserVisibleError("Failed to enroll in group");
  }
  //Add the invitees to the group
  const { error: inviteesError } = await adminSupabase.from("assignment_group_invitations")
    .insert(invitees.map((invitee) => ({
      assignment_group_id: newGroup.id,
      invitee: invitee,
      inviter: profile_id,
      class_id: course_id,
    })));
  if (inviteesError) {
    console.error(inviteesError);
    throw new UserVisibleError("Failed to invite users to group");
  }
  return {
    message: `Group #${newGroup.id} created successfully`,
  };
}

Deno.serve((req) => {
  return wrapRequestHandler(req, createAutograderGroup);
})