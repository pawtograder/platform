/**
 * @jest-environment node
 */
import { gradeTargetsForSubmission, perStudentEvaluationBlocked } from "@/lib/rubricGradingCompletion";
import type { RubricPart } from "@/utils/supabase/DatabaseTypes";

// Only the two flags matter to the helpers under test; the rest of RubricPart is irrelevant here.
function part(overrides: Partial<RubricPart> = {}): RubricPart {
  return { id: 1, is_individual_grading: false, is_assign_to_student: false, ...overrides } as RubricPart;
}

const perStudentPart = () => part({ is_individual_grading: true });
const assignToStudentPart = () => part({ id: 42, is_assign_to_student: true });

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
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [part()],
        gradeTargets: [],
        gradeTargetsLoaded: false,
        rubricPartStudentAssignments: null
      })
    ).toBe(false);
  });

  it("is true when per-student parts exist but membership has not loaded", () => {
    // The regression: this state used to fall through to "any one member's comment counts",
    // producing a false all-clear.
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: ["a"],
        gradeTargetsLoaded: false,
        rubricPartStudentAssignments: null
      })
    ).toBe(true);
  });

  it("is true when per-student parts exist and there are no targets", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: null
      })
    ).toBe(true);
  });

  it("is false once membership is loaded and targets are known", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: ["a", "b"],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: null
      })
    ).toBe(false);
  });

  it("treats an ASSIGNED assign-to-student part the same as an individual-grading part", () => {
    // Only once somebody is actually assigned. The unassigned case is skipped -- see below.
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [assignToStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: { "42": "student-a" }
      })
    ).toBe(true);
  });

  // An is_assign_to_student part with nobody assigned is SKIPPED by
  // computeRubricGradingCompletion and by validate_review_assignment_completion, so blocking on it
  // made a server-completable review permanently uncompletable in the UI.
  it("is false when the only per-student part is an unassigned assign-to-student part", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [assignToStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: null
      })
    ).toBe(false);
  });

  it("treats an empty-string assignment as unassigned, matching partAssignToStudentSkipped", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [assignToStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: { "42": "" }
      })
    ).toBe(false);
  });

  it("is true when an assign-to-student part IS assigned but there are no targets", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [assignToStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: { "42": "student-a" }
      })
    ).toBe(true);
  });

  // is_individual_grading has no per-part opt-out, so the assignment map must not excuse it.
  it("still blocks an individual-grading part regardless of the assignment map", () => {
    expect(
      perStudentEvaluationBlocked({
        rubricParts: [perStudentPart()],
        gradeTargets: [],
        gradeTargetsLoaded: true,
        rubricPartStudentAssignments: {}
      })
    ).toBe(true);
  });
});
