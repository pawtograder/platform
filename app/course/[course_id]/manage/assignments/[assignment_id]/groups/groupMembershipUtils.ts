import { AssignmentGroupWithMembersAndMentor } from "@/utils/supabase/DatabaseTypes";

/**
 * Resolves which assignment group a student belongs to for a given assignment by scanning
 * `assignment_groups` rows (with members) from CourseController, instead of relying on the
 * nested `profiles.assignment_groups_members` embed which can lag behind `refetchAll()`.
 *
 * @param groups Assignment groups for the course (typically filtered to one assignment in the UI)
 * @param assignmentId Assignment to match on `assignment_groups.assignment_id`
 * @param privateProfileId Student private profile id (`user_roles.private_profile_id`)
 * @returns The group row if the profile is a member, otherwise `undefined`
 */
export function findGroupForProfileOnAssignment(
  groups: AssignmentGroupWithMembersAndMentor[],
  assignmentId: number,
  privateProfileId: string
): AssignmentGroupWithMembersAndMentor | undefined {
  return groups.find(
    (g) =>
      g.assignment_id === assignmentId && g.assignment_groups_members.some((m) => m.profile_id === privateProfileId)
  );
}
