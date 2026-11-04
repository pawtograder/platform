import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { AssignmentGroupInstructorMoveStudentRequest } from "../_shared/FunctionTypes.d.ts";
import { IllegalArgumentError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

/**
 * Everything the move needs from outside, so tests can substitute an in-memory database and
 * record the GitHub jobs instead of enqueueing them (see moveStudent.test.ts).
 */
export type MoveStudentDeps = {
  /** The calling instructor's client; RLS applies. */
  supabase: SupabaseClient<Database>;
  adminSupabase: SupabaseClient<Database>;
  /** private_profile_id recorded as added_by on the new membership. */
  addedBy: string;
  enqueueGithubArchiveRepo: (class_id: number, org: string, repo: string, debug_id?: string) => Promise<unknown>;
  enqueueSyncRepoPermissions: (args: {
    class_id: number;
    course_slug: string;
    org: string;
    repo: string;
    githubUsernames: string[];
    debug_id?: string;
  }) => Promise<unknown>;
  /** Reports an error that must not abort the move. */
  reportError: (error: unknown) => void;
};

/**
 * Moves a student out of `old_assignment_group_id` (if any) and into `new_assignment_group_id`
 * (if any). The steps are separate requests, not one transaction. Everything that can reject the
 * move (same group, new group missing or in another class or assignment, student not in the old
 * group) is checked before anything changes.
 * Once the old membership is deleted, cleanup failures are reported and never thrown: throwing
 * would leave the student in no group, and a retry would fail with "Student not in group".
 *
 * When the student was the last member, the old group and its repository are deleted, unless the
 * group has submissions. Then group, repo and submissions are kept, and the repo is re-synced to
 * an empty member list so the students who left lose GitHub access.
 */
export async function moveStudentBetweenGroups(
  {
    new_assignment_group_id,
    old_assignment_group_id,
    profile_id,
    class_id
  }: AssignmentGroupInstructorMoveStudentRequest,
  deps: MoveStudentDeps
): Promise<void> {
  const { supabase, adminSupabase, addedBy, reportError } = deps;

  // Validate the destination before touching the old membership.
  if (old_assignment_group_id !== null && old_assignment_group_id === new_assignment_group_id) {
    // Running the removal first would dissolve a sole member's group and then fail to re-add them.
    throw new IllegalArgumentError("Student is already in that group");
  }
  let newGroup: {
    assignment_id: number;
    class_id: number;
    repositories: { repository: string }[];
    classes: { github_org: string | null; slug: string | null } | null;
  } | null = null;
  if (new_assignment_group_id !== null) {
    const { data } = await adminSupabase
      .from("assignment_groups")
      .select("*, repositories(*), classes(github_org, slug)")
      .eq("id", new_assignment_group_id)
      .single();
    // The admin client bypasses RLS, so the class check is what keeps an instructor of one class
    // from moving a student into another class's group.
    if (!data || data.class_id !== class_id) {
      throw new IllegalArgumentError("New group not found");
    }
    newGroup = data;
  }

  if (old_assignment_group_id !== null) {
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
    if (newGroup && newGroup.assignment_id !== currentGroup.assignment_id) {
      throw new IllegalArgumentError("New group belongs to a different assignment");
    }
    const { error: remove_member_error } = await adminSupabase
      .from("assignment_groups_members")
      .delete()
      .eq("id", currentGroup.id);
    if (remove_member_error) {
      console.error(remove_member_error);
      throw new Error("Failed to remove member from group");
    }

    // From here on the removal is committed: report failures, do not throw.
    const { data: remaining_members, error: remaining_members_error } = await adminSupabase
      .from("assignment_groups_members")
      .select("*, profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))")
      .eq("assignment_group_id", old_assignment_group_id);
    if (remaining_members_error || !remaining_members) {
      // Without the member list we cannot tell whether the group is now empty, nor whom the repo
      // should keep, so leave the group and its repo exactly as they are.
      reportError(remaining_members_error ?? new Error("Failed to get remaining members"));
    } else {
      const oldGroupRepo = currentGroup.assignment_groups!.repositories[0];
      // Whether the old group's repo stays, and so needs its collaborators re-synced.
      let oldRepoStays = remaining_members.length > 0;
      if (remaining_members.length === 0) {
        // A group with submissions is always kept, as publish_assignment_group_changes does. So
        // is one whose submissions cannot be counted, or whose repo cannot be deleted.
        const { count: submissionCount, error: submissions_error } = await adminSupabase
          .from("submissions")
          .select("id", { count: "exact", head: true })
          .or(
            oldGroupRepo
              ? `assignment_group_id.eq.${old_assignment_group_id},repository_id.eq.${oldGroupRepo.id}`
              : `assignment_group_id.eq.${old_assignment_group_id}`
          );
        let keepGroup = submissions_error !== null || (submissionCount ?? 0) > 0;
        if (submissions_error) {
          reportError(submissions_error);
        }
        if (!keepGroup && oldGroupRepo) {
          // Raises 23503 for any reference it does not clear; the group is then kept.
          const { error: delete_repo_error } = await adminSupabase.rpc("delete_repository_rows", {
            p_repository_ids: [oldGroupRepo.id]
          });
          if (delete_repo_error) {
            reportError(delete_repo_error);
            keepGroup = true;
          } else {
            // The stored owner/name, not one rebuilt from the class github_org.
            const repoName = oldGroupRepo.repository;
            if (repoName) {
              // The repo row is gone, so a failed enqueue only leaves the GitHub repo unarchived.
              try {
                await deps.enqueueGithubArchiveRepo(class_id, currentGroup.classes!.github_org!, repoName);
              } catch (archive_error) {
                reportError(archive_error);
              }
            }
          }
        }
        if (!keepGroup) {
          // Invitations and join requests only go once the group itself is going.
          await adminSupabase
            .from("assignment_group_invitations")
            .delete()
            .eq("assignment_group_id", old_assignment_group_id);
          await adminSupabase
            .from("assignment_group_join_request")
            .delete()
            .eq("assignment_group_id", old_assignment_group_id);
          const { error: delete_group_error } = await adminSupabase
            .from("assignment_groups")
            .delete()
            .eq("id", old_assignment_group_id);
          if (delete_group_error) {
            reportError(delete_group_error);
          }
        }
        oldRepoStays = keepGroup;
      }
      if (oldGroupRepo && oldRepoStays) {
        // Reconciles the repo to the remaining members, so the student who left loses access.
        // A kept empty group syncs to an empty list, which revokes every student collaborator.
        try {
          await deps.enqueueSyncRepoPermissions({
            class_id,
            course_slug: currentGroup.classes!.slug!,
            org: currentGroup.classes!.github_org!,
            repo: oldGroupRepo.repository,
            githubUsernames: remaining_members
              .filter((m) => m.profiles!.user_roles!.users!.github_username)
              .map((m) => m.profiles!.user_roles!.users!.github_username!),
            debug_id: `assignment-group-instructor-move-student-${old_assignment_group_id}-${profile_id}`
          });
        } catch (sync_error) {
          reportError(sync_error);
        }
      }
    }
  }

  if (new_assignment_group_id !== null && newGroup) {
    if (!old_assignment_group_id) {
      // Joining a group from no group: the student's individual submissions stop counting.
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
      added_by: addedBy
    });
    if (add_member_error) {
      throw new Error("Failed to add member to group");
    }
    const { data: members, error: members_error } = await adminSupabase
      .from("assignment_groups_members")
      .select("*, profiles!profile_id(user_roles!user_roles_private_profile_id_fkey(users(github_username)))")
      .eq("assignment_group_id", new_assignment_group_id);
    if (members_error || !members) {
      // The student is in the group; only their GitHub access is missing. Report it rather
      // than fail a move that has happened.
      reportError(members_error ?? new Error("Failed to get new group members"));
      return;
    }
    const repository = newGroup.repositories[0];
    if (repository) {
      try {
        await deps.enqueueSyncRepoPermissions({
          class_id,
          course_slug: newGroup.classes!.slug!,
          org: newGroup.classes!.github_org!,
          repo: repository.repository,
          githubUsernames: members
            .filter((m) => m.profiles!.user_roles!.users!.github_username)
            .map((m) => m.profiles!.user_roles!.users!.github_username!),
          debug_id: `assignment-group-instructor-move-student-${new_assignment_group_id}-${profile_id}`
        });
      } catch (sync_error) {
        reportError(sync_error);
      }
    }
  }
}
