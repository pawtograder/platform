/**
 * @jest-environment node
 */
import { gradeTargetsForSubmission, perStudentEvaluationBlocked } from "@/lib/rubricGradingCompletion";
import type { RubricPart } from "@/utils/supabase/DatabaseTypes";

// Only the two flags matter to the helpers under test; the rest of RubricPart is irrelevant here.
function part(overrides: Partial<RubricPart> = {}): RubricPart {
  return { is_individual_grading: false, is_assign_to_student: false, ...overrides } as RubricPart;
}

const perStudentPart = () => part({ is_individual_grading: true });
const assignToStudentPart = () => part({ is_assign_to_student: true });

describe("gradeTargetsForSubmission", () => {
  it("returns the group's members for a group submission", () => {
    expect(
      gradeTargetsForSubmission({ assignmentGroupId: 7, profileId: "solo", groupMemberProfileIds: ["a", "b"] })
    ).toEqual(["a", "b"]);
  });

  it("de-duplicates members", () => {
    expect(
      gradeTargetsForSubmission({ assignmentGroupId: 7, profileId: null, groupMemberProfileIds: ["a", "a", "b"] })
    ).toEqual(["a", "b"]);
  });

  it("returns the submitter for a solo submission", () => {
    expect(
      gradeTargetsForSubmission({ assignmentGroupId: null, profileId: "solo", groupMemberProfileIds: [] })
    ).toEqual(["solo"]);
  });

  it("returns empty for a group with no known members", () => {
    // Ambiguous by construction — this is exactly why callers need perStudentEvaluationBlocked.
    expect(gradeTargetsForSubmission({ assignmentGroupId: 7, profileId: "solo", groupMemberProfileIds: [] })).toEqual(
      []
    );
  });
});

describe("perStudentEvaluationBlocked", () => {
  it("is false when the rubric has no per-student parts, whatever the targets", () => {
    expect(perStudentEvaluationBlocked({ rubricParts: [part()], gradeTargets: [], gradeTargetsLoaded: false })).toBe(
      false
    );
  });

  it("is true when per-student parts exist but membership has not loaded", () => {
    // The regression: this state used to fall through to "any one member's comment counts",
    // producing a false all-clear.
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: ["a"],
        gradeTargetsLoaded: false
      })
    ).toBe(true);
  });

  it("is true when per-student parts exist and there are no targets", () => {
    expect(
      perStudentEvaluationBlocked({ rubricParts: [perStudentPart()], gradeTargets: [], gradeTargetsLoaded: true })
    ).toBe(true);
  });

  it("is false once membership is loaded and targets are known", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: ["a", "b"],
        gradeTargetsLoaded: true
      })
    ).toBe(false);
  });

  it("treats assign-to-student parts the same as individual-grading parts", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [assignToStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true
      })
    ).toBe(true);
  });
});
