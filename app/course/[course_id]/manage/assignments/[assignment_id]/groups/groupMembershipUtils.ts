import { AssignmentGroupWithMembersAndMentor } from "@/utils/supabase/DatabaseTypes";

/** Prefer this over `profiles.assignment_groups_members` so the UI stays in sync with `assignmentGroupsWithMembers` refetches. */
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
