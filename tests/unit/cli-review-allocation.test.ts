/**
 * @jest-environment node
 */

/**
 * Round-robin allocation for `pawtograder reviews assign`.
 *
 * These are the properties an operator relies on: an even split so no TA is
 * quietly handed twice the grading, stability so a re-run does not reshuffle
 * work, and hard respect for exclusions so nobody grades their own submission
 * or a student they are conflicted with. Getting any of them wrong produces a
 * plausible-looking assignment set that is wrong in a way nobody notices until
 * grading is underway.
 */

import {
  allocateRoundRobin,
  summarizeLoad,
  type DraftAssignment
} from "../../supabase/functions/cli/utils/reviewAllocation";

const GRADER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const GRADER_B = "bbbbbbbb-0000-0000-0000-000000000002";
const GRADER_C = "cccccccc-0000-0000-0000-000000000003";

function countsByAssignee(drafts: DraftAssignment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of drafts) counts[d.assignee_profile_id] = (counts[d.assignee_profile_id] ?? 0) + 1;
  return counts;
}

describe("allocateRoundRobin", () => {
  it("splits evenly when submissions divide across graders", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2, 3, 4, 5, 6],
      assigneeProfileIds: [GRADER_A, GRADER_B, GRADER_C],
      rubricPartIds: null,
      existing: []
    });

    expect(drafts).toHaveLength(6);
    expect(countsByAssignee(drafts)).toEqual({ [GRADER_A]: 2, [GRADER_B]: 2, [GRADER_C]: 2 });
    // One assignment per submission, covering the whole rubric.
    expect(drafts.every((d) => d.rubric_part_id === null)).toBe(true);
    expect(new Set(drafts.map((d) => d.submission_id)).size).toBe(6);
  });

  it("spreads the remainder rather than piling it on one grader", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2, 3, 4, 5, 6, 7],
      assigneeProfileIds: [GRADER_A, GRADER_B, GRADER_C],
      rubricPartIds: null,
      existing: []
    });

    const counts = Object.values(countsByAssignee(drafts)).sort();
    expect(counts).toEqual([2, 2, 3]);
  });

  it("is deterministic across runs and independent of input order", () => {
    const first = allocateRoundRobin({
      submissionIds: [3, 1, 2, 4],
      assigneeProfileIds: [GRADER_C, GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing: []
    });
    const second = allocateRoundRobin({
      submissionIds: [1, 2, 3, 4],
      assigneeProfileIds: [GRADER_A, GRADER_B, GRADER_C],
      rubricPartIds: null,
      existing: []
    });

    expect(first.drafts).toEqual(second.drafts);
  });

  it("skips work that already has an assignee", () => {
    const existing: DraftAssignment[] = [
      { assignee_profile_id: GRADER_A, submission_id: 1, rubric_part_id: null },
      { assignee_profile_id: GRADER_B, submission_id: 2, rubric_part_id: null }
    ];

    const { drafts, skippedAlreadyAssigned } = allocateRoundRobin({
      submissionIds: [1, 2, 3, 4],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing
    });

    expect(skippedAlreadyAssigned).toBe(2);
    expect(drafts.map((d) => d.submission_id).sort()).toEqual([3, 4]);
  });

  it("seeds load from existing work so a re-run levels graders up", () => {
    // A already holds three reviews; B holds none. The two new submissions
    // should both go to B rather than round-robin from scratch.
    const existing: DraftAssignment[] = [
      { assignee_profile_id: GRADER_A, submission_id: 10, rubric_part_id: null },
      { assignee_profile_id: GRADER_A, submission_id: 11, rubric_part_id: null },
      { assignee_profile_id: GRADER_A, submission_id: 12, rubric_part_id: null }
    ];

    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing
    });

    expect(countsByAssignee(drafts)).toEqual({ [GRADER_B]: 2 });
  });

  it("ignores load held by graders outside the current pool", () => {
    // C is not in the pool, so their existing work must not skew the A/B split.
    const existing: DraftAssignment[] = [
      { assignee_profile_id: GRADER_C, submission_id: 10, rubric_part_id: null },
      { assignee_profile_id: GRADER_C, submission_id: 11, rubric_part_id: null }
    ];

    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing
    });

    expect(countsByAssignee(drafts)).toEqual({ [GRADER_A]: 1, [GRADER_B]: 1 });
  });

  it("never assigns an excluded grader, even when they hold the least work", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing: [],
      // A wrote submission 1 (or is conflicted with its author).
      excludedBySubmission: new Map([[1, new Set([GRADER_A])]])
    });

    const forSubmission1 = drafts.filter((d) => d.submission_id === 1);
    expect(forSubmission1).toHaveLength(1);
    expect(forSubmission1[0].assignee_profile_id).toBe(GRADER_B);
  });

  it("reports pairs with no eligible grader instead of dropping them", () => {
    const { drafts, unassignable } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [GRADER_A],
      rubricPartIds: null,
      existing: [],
      excludedBySubmission: new Map([[1, new Set([GRADER_A])]])
    });

    expect(unassignable).toEqual([{ submission_id: 1, rubric_part_id: null }]);
    // The submission that can be assigned still is.
    expect(drafts).toEqual([{ assignee_profile_id: GRADER_A, submission_id: 2, rubric_part_id: null }]);
  });

  it("fans out one assignment per rubric part when parts are given", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: [100, 200],
      existing: []
    });

    expect(drafts).toHaveLength(4);
    expect(countsByAssignee(drafts)).toEqual({ [GRADER_A]: 2, [GRADER_B]: 2 });
    // Each (submission, part) pair appears exactly once.
    const pairs = drafts.map((d) => `${d.submission_id}:${d.rubric_part_id}`).sort();
    expect(pairs).toEqual(["1:100", "1:200", "2:100", "2:200"]);
  });

  it("treats a whole-rubric assignment as covering every part", () => {
    // An assignment with no rubric-part links covers the whole rubric, so
    // --by-part must not re-deal its parts. Doing so either duplicates the work
    // across assignees or, when bulk_assign_reviews reuses the same assignee's
    // row, silently narrows the existing whole-rubric assignment to those parts.
    const { drafts, skippedAlreadyAssigned } = allocateRoundRobin({
      submissionIds: [1],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: [100, 200],
      existing: [{ assignee_profile_id: GRADER_A, submission_id: 1, rubric_part_id: null }]
    });

    expect(drafts).toEqual([]);
    expect(skippedAlreadyAssigned).toBe(2);
  });

  it("does not deal a whole-rubric assignment over already-assigned parts", () => {
    // The inverse direction: "the remaining parts" cannot be expressed as a
    // single whole-rubric assignment, so it would overlap part 100.
    const { drafts, skippedAlreadyAssigned } = allocateRoundRobin({
      submissionIds: [1],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: null,
      existing: [{ assignee_profile_id: GRADER_A, submission_id: 1, rubric_part_id: 100 }]
    });

    expect(drafts).toEqual([]);
    expect(skippedAlreadyAssigned).toBe(1);
  });

  it("still fills in parts that are genuinely unassigned", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1],
      assigneeProfileIds: [GRADER_A, GRADER_B],
      rubricPartIds: [100, 200, 300],
      existing: [{ assignee_profile_id: GRADER_A, submission_id: 1, rubric_part_id: 100 }]
    });

    expect(drafts.map((d) => d.rubric_part_id).sort()).toEqual([200, 300]);
  });

  it("returns nothing when there are no graders, without throwing", () => {
    const { drafts, unassignable } = allocateRoundRobin({
      submissionIds: [1, 2],
      assigneeProfileIds: [],
      rubricPartIds: null,
      existing: []
    });

    expect(drafts).toEqual([]);
    expect(unassignable).toHaveLength(2);
  });

  it("handles a single submission and a single grader", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [42],
      assigneeProfileIds: [GRADER_A],
      rubricPartIds: null,
      existing: []
    });

    expect(drafts).toEqual([{ assignee_profile_id: GRADER_A, submission_id: 42, rubric_part_id: null }]);
  });

  it("deduplicates repeated submission ids and graders", () => {
    const { drafts } = allocateRoundRobin({
      submissionIds: [1, 1, 2],
      assigneeProfileIds: [GRADER_A, GRADER_A],
      rubricPartIds: null,
      existing: []
    });

    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.submission_id)).toEqual([1, 2]);
  });
});

describe("summarizeLoad", () => {
  it("counts per grader, heaviest first", () => {
    const summary = summarizeLoad([
      { assignee_profile_id: GRADER_B, submission_id: 1, rubric_part_id: null },
      { assignee_profile_id: GRADER_A, submission_id: 2, rubric_part_id: null },
      { assignee_profile_id: GRADER_A, submission_id: 3, rubric_part_id: null }
    ]);

    expect(summary).toEqual([
      { assignee_profile_id: GRADER_A, count: 2 },
      { assignee_profile_id: GRADER_B, count: 1 }
    ]);
  });

  it("returns an empty list for no drafts", () => {
    expect(summarizeLoad([])).toEqual([]);
  });
});
