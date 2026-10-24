import { isOwnRepositoryForAssignment } from "@/lib/ownRepositoryForAssignment";

const me = "39dab5f1-3685-4d1a-8e9a-4b3abaee6971";
const classmate = "e860f42d-f381-4404-902c-79d222b23c69";

function repo(overrides: { assignment_id: number; assignment_group_id?: number | null; profile_id?: string | null }) {
  return {
    assignment_id: overrides.assignment_id,
    assignment_group_id: overrides.assignment_group_id ?? null,
    profile_id: overrides.profile_id ?? null
  };
}

/**
 * The student assignment page reads repositories from the course controller, whose rows depend on the
 * viewer's role: a student's controller holds only their own, a staff member's holds the whole class.
 * The page used to filter on `assignment_id` alone, which was correct only by accident of who was
 * looking — so a staff viewer, including staff previewing their own work as a student, could be shown
 * a classmate's repository as their own.
 */
describe("isOwnRepositoryForAssignment", () => {
  const individual = { assignmentId: 34, assignmentGroupId: null, profileId: me };

  it("matches my own individual repository", () => {
    expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, profile_id: me }), individual)).toBe(true);
  });

  it("does not match a classmate's repository for the same assignment", () => {
    expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, profile_id: classmate }), individual)).toBe(false);
  });

  it("does not match my repository for a different assignment", () => {
    expect(isOwnRepositoryForAssignment(repo({ assignment_id: 35, profile_id: me }), individual)).toBe(false);
  });

  it("does not match a group repository when I am not in a group", () => {
    expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, assignment_group_id: 7 }), individual)).toBe(false);
  });

  describe("when I am in a group", () => {
    const grouped = { assignmentId: 34, assignmentGroupId: 7, profileId: me };

    it("matches my group's repository", () => {
      expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, assignment_group_id: 7 }), grouped)).toBe(true);
    });

    it("does not match another group's repository", () => {
      expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, assignment_group_id: 8 }), grouped)).toBe(false);
    });

    it("does not match a stray individual repository of mine", () => {
      // Group assignments are graded off the group repo; an individual row left over from a
      // Test Assignment repo must not be shown as the group's work.
      expect(isOwnRepositoryForAssignment(repo({ assignment_id: 34, profile_id: me }), grouped)).toBe(false);
    });
  });
});
