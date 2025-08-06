import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { AssignmentGroupInstructorMoveStudentRequest } from "../_shared/FunctionTypes.d.ts";
import { syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { IllegalArgumentError, assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleAssignmentGroupInstructorMoveStudent(req: Request, scope: Sentry.Scope): Promise<void> {
  const { new_assignment_group_id, old_assignment_group_id, profile_id, class_id } =
    (await req.json()) as AssignmentGroupInstructorMoveStudentRequest;
  scope?.setTag("function", "assignment-group-instructor-move-student");
  scope?.setTag("new_assignment_group_id", new_assignment_group_id?.toString() || "(null)");
  scope?.setTag("old_assignment_group_id", old_assignment_group_id?.toString() || "(null)");
  scope?.setTag("profile_id", profile_id.toString());
  scope?.setTag("class_id", class_id.toString());
  const { supabase, enrollment } = await assertUserIsInstructor(class_id, req.headers.get("Authorization")!);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  if (old_assignment_group_id !== null) {
    //Remove student from current group
    const { data: currentGroup } = await supabase
      .from("assignment_groups_members")
      .select("*, assignments(slug), classes(*), assignment_groups(*, repositories(*))")
      .eq("assignment_group_id", old_assignment_group_id)
      .eq("profile_id", profile_id)
      .eq("class_id", class_id)
      .single();
    if (!currentGroup) {
      throw new IllegalArgumentError("Student not in group");
    }
    const { error: remove_member_error } = await adminSupabase
      .from("assignment_groups_members")
      .delete()
      .eq("id", currentGroup.id);
    if (remove_member_error) {
      console.error(remove_member_error);
      throw new Error("Failed to remove member from group");
    }
    const { data: remaining_members, error: remaining_members_error } = await adminSupabase
      .from("assignment_groups_members")
      .select("*, profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))")
      .eq("assignment_group_id", old_assignment_group_id);
    if (remaining_members_error) {
      throw new Error("Failed to get remaining members");
    }
    if (!remaining_members) {
      throw new Error("Failed to get remaining members");
    }
    const repository = currentGroup.assignment_groups!.repositories[0];
    if (repository) {
      await syncRepoPermissions(
        currentGroup.classes!.github_org!,
        repository.repository,
        currentGroup.classes!.slug!,
        remaining_members
          .filter((m) => m.profiles!.user_roles!.users!.github_username)
          .map((m) => m.profiles!.user_roles!.users!.github_username!)
      );
    }
  }

  //Add student to new group
  if (new_assignment_group_id !== null) {
    const { data: newGroup } = await adminSupabase
      .from("assignment_groups")
      .select("*, repositories(*), classes(github_org, slug)")
      .eq("id", new_assignment_group_id)
      .single();
    if (!newGroup) {
      throw new IllegalArgumentError("New group not found");
    }

    if (!old_assignment_group_id) {
      //Deactivate any submissions for this assignment for this student
      const { error: deactivateError } = await adminSupabase
        .from("submissions")
        .update({
          is_active: false
        })
        .eq("assignment_id", newGroup.assignment_id)
        .eq("profile_id", profile_id);
      if (deactivateError) {
        throw new Error("Failed to deactivate submissions");
      }
    }
    const { error: add_member_error } = await adminSupabase.from("assignment_groups_members").insert({
      assignment_group_id: new_assignment_group_id,
      profile_id,
      assignment_id: newGroup.assignment_id,
      class_id,
      added_by: enrollment.private_profile_id
    });
    if (add_member_error) {
      throw new Error("Failed to add member to group");
    }
    const { data: remaining_members, error: remaining_members_error } = await adminSupabase
      .from("assignment_groups_members")
      .select("*, profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))")
      .eq("assignment_group_id", new_assignment_group_id);
    if (remaining_members_error) {
      throw new Error("Failed to get remaining members");
    }
    if (!remaining_members) {
      throw new Error("Failed to get remaining members");
    }
    const repository = newGroup.repositories[0];
    if (repository) {
      await syncRepoPermissions(
        newGroup.classes!.github_org!,
        repository.repository,
        newGroup.classes!.slug!,
        remaining_members
          .filter((m) => m.profiles!.user_roles!.users!.github_username)
          .map((m) => m.profiles!.user_roles!.users!.github_username!)
      );
    }
  }
}
Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleAssignmentGroupInstructorMoveStudent);
});
