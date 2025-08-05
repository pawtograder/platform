import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { AssignmentGroupInstructorCreateRequest } from "../_shared/FunctionTypes.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  SecurityError,
  UserVisibleError,
  wrapRequestHandler,
  IllegalArgumentError,
  assertUserIsInstructor
} from "../_shared/HandlerUtils.ts";
async function instructorCreateAutograderGroup(req: Request): Promise<{ message: string; id: number }> {
  //Get the user
  const { course_id, assignment_id, name } = (await req.json()) as AssignmentGroupInstructorCreateRequest;

  const { supabase, enrollment } = await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new IllegalArgumentError("Group name cannot be empty");
  }
  //Valid group names are alphanumeric, hyphens, or underscore, max 36 characters
  if (!/^[a-zA-Z0-9_-]{1,36}$/.test(trimmedName)) {
    throw new IllegalArgumentError(
      "Group name consist only of alphanumeric, hyphens, or underscores, and be less than 36 characters"
    );
  }
  console.log(course_id, assignment_id, trimmedName);
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    throw new SecurityError("User not found");
  }
  //Validate that the user is in the course
  const { data: profile } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .eq("role", "instructor")
    .eq("class_id", course_id)
    .single();
  if (!profile) {
    throw new SecurityError("User not found");
  }
  const profile_id = profile.private_profile_id;
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  //Validate that the group has a unique name for this assignment
  const { data: existingAssignmentGroupWithSameName } = await adminSupabase
    .from("assignment_groups")
    .select("*")
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
  const { data: newGroup, error: newGroupError } = await adminSupabase
    .from("assignment_groups")
    .insert({
      name: trimmedName,
      assignment_id: assignment_id,
      class_id: course_id
    })
    .select("id")
    .single();
  if (newGroupError) {
    console.error(newGroupError);
    throw new UserVisibleError("Failed to create group");
  }
  return {
    message: `Group #${newGroup.id} created successfully`,
    id: newGroup.id
  };
}
Deno.serve((req) => {
  return wrapRequestHandler(req, instructorCreateAutograderGroup);
});
