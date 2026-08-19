import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  AssignmentGroupCreateRequest,
  AssignmentGroupInstructorCreateRequest,
  GenericResponse
} from "../_shared/FunctionTypes.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { sanitizeRepoNameComponent } from "../_shared/repoNames.ts";
import { assignmentProvisionsRepositories } from "../_shared/repoCreationStrategy.ts";
import {
  SecurityError,
  UserVisibleError,
  wrapRequestHandler,
  IllegalArgumentError,
  assertUserIsInstructor
} from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
async function instructorCreateAutograderGroup(
  req: Request,
  scope: Sentry.Scope
): Promise<{ message: string; id: number }> {
  //Get the user
  const { course_id, assignment_id, name } = (await req.json()) as AssignmentGroupInstructorCreateRequest;
  scope?.setTag("function", "assignment-group-instructor-create");
  scope?.setTag("course_id", course_id.toString());
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("name", name);
  const { supabase, enrollment } = await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new IllegalArgumentError("Group name cannot be empty");
  }
  //Valid group names are alphanumeric, hyphens, or underscore, max 36 characters
  if (!/^[a-zA-Z0-9_-]{1,36}$/.test(trimmedName)) {
    throw new IllegalArgumentError(
      "Group name must consist only of letters, numbers, hyphens, or underscores, and be 36 characters or fewer"
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
    .select("*,classes(slug,github_org)")
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

  //Neither the name rules below nor the repo enqueue further down apply to an assignment that never provisions a
  //repository. Mirrors the repo_mode exemption in validate_assignment_group_name().
  const providesRepositories = assignmentProvisionsRepositories(assignment.repo_mode);
  if (providesRepositories) {
    if (!/[a-zA-Z0-9]/.test(trimmedName)) {
      throw new IllegalArgumentError("Group name must contain at least one letter or number");
    }
    //Two different names can still collide once sanitized for GitHub (e.g. "Team-One" and "Team--One" both become
    //"Team-One"), and the two groups would then fight over the same repository name
    const sanitizedName = sanitizeRepoNameComponent(trimmedName).toLowerCase();
    const { data: assignmentGroups, error: assignmentGroupsError } = await adminSupabase
      .from("assignment_groups")
      .select("id, name")
      .eq("assignment_id", assignment_id);
    if (assignmentGroupsError) {
      console.error(assignmentGroupsError);
      Sentry.captureException(assignmentGroupsError, scope);
      throw new UserVisibleError(
        "We could not check the group name against the other groups for this assignment. Try again in a moment."
      );
    }
    const conflictingGroup = (assignmentGroups ?? []).find(
      //Names stored before this validation existed may sanitize to nothing (which throws); they cannot collide with a
      //name that has at least one letter or number, so skip them
      (group) => /[a-zA-Z0-9]/.test(group.name) && sanitizeRepoNameComponent(group.name).toLowerCase() === sanitizedName
    );
    if (conflictingGroup) {
      throw new IllegalArgumentError(
        `Group name is too similar to the existing group "${conflictingGroup.name}": both become "${sanitizedName}" once normalized for GitHub. Choose a more distinct name.`
      );
    }
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

  //Enqueue async repo creation for the group, unless this assignment never provisions one
  if (providesRepositories) {
    //Sanitize the group-name component the same way every other repo-name derivation does, or this group's repository
    //is named differently here than in github-user-sync and assignment-create-all-repos
    const repoName = `${profile.classes!.slug}-${assignment.slug}-group-${sanitizeRepoNameComponent(trimmedName)}`;
    // Enqueue the repo creation (this will create the repository record and enqueue the GitHub operations)
    const { error: enqueueError } = await adminSupabase.rpc("enqueue_github_create_repo", {
      p_class_id: assignment.class_id!,
      p_org: profile.classes!.github_org!,
      p_repo_name: repoName,
      p_template_repo: assignment.template_repo!,
      p_course_slug: profile.classes!.slug!,
      p_github_usernames: [],
      p_is_template_repo: false,
      p_debug_id: `group-create-${newGroup.id}`,
      p_assignment_id: assignment.id,
      p_profile_id: undefined, // Group repos don't have a profile_id
      p_assignment_group_id: newGroup.id,
      p_latest_template_sha: assignment.latest_template_sha ?? undefined
    });
    if (enqueueError) {
      Sentry.captureException(enqueueError, scope);
      throw new UserVisibleError(`Error enqueueing repo creation: ${enqueueError.message}`);
    }
  }
  return {
    message: `Group #${newGroup.id} created successfully`,
    id: newGroup.id
  };
}
Deno.serve((req) => {
  return wrapRequestHandler(req, instructorCreateAutograderGroup);
});
