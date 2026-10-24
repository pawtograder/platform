import type { Repository } from "@/utils/supabase/DatabaseTypes";

/**
 * Whether a repository row is *this viewer's* repository for an assignment.
 *
 * The student assignment page reads repositories out of the course controller, whose row set depends
 * on the viewer's role: a student's controller holds only their own rows, a staff member's holds the
 * whole class. Filtering on `assignment_id` alone was therefore correct only by accident of who was
 * looking — any staff viewer, including staff previewing their own work as a student, would be shown
 * an arbitrary classmate's repository as their own.
 *
 * Group assignments key on the group, individual ones on the profile, mirroring how the same page
 * chooses between a group submission and an individual one.
 */
export function isOwnRepositoryForAssignment(
  repository: Pick<Repository, "assignment_id" | "assignment_group_id" | "profile_id">,
  viewer: { assignmentId: number; assignmentGroupId: number | null; profileId: string }
): boolean {
  if (repository.assignment_id !== viewer.assignmentId) {
    return false;
  }
  if (viewer.assignmentGroupId !== null) {
    return repository.assignment_group_id === viewer.assignmentGroupId;
  }
  return repository.assignment_group_id === null && repository.profile_id === viewer.profileId;
}
