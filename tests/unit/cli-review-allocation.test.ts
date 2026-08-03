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
  activeSubmissionFor,
  allocateRoundRobin,
  buildActiveSubmissionIndex,
  findCoverageConflicts,
  planStaleRetargets,
  summarizeLoad,
  type DraftAssignment,
  type ExistingAssignmentRow
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

describe("retargeting stale submissions", () => {
  // A resubmission supersedes the submission an existing review assignment points
  // at. If coverage were keyed on the raw id, the current submission would look
  // unassigned and get drafted again — usually to a different assignee, since the
  // stale assignment still counts toward reviewer load — and bulk_assign_reviews
  // would leave the stale row in place. The work would then be graded twice.
  const active = [
    { id: 500, profile_id: "student-1", assignment_group_id: null },
    { id: 501, profile_id: null, assignment_group_id: 42 }
  ];
  const index = buildActiveSubmissionIndex(active);

  it("maps an individual's stale submission onto their active one", () => {
    expect(activeSubmissionFor({ groupId: null, profileId: "student-1" }, 400, index)).toBe(500);
  });

  it("maps a group's stale submission onto the group's active one", () => {
    expect(activeSubmissionFor({ groupId: 42, profileId: "member-a" }, 401, index)).toBe(501);
  });

  it("prefers group ownership when a submission carries both", () => {
    // Group submissions record a submitting profile too; the group is the unit
    // the assignment follows.
    expect(activeSubmissionFor({ groupId: 42, profileId: "student-1" }, 402, index)).toBe(501);
  });

  it("keeps the original id when the owner has no active submission", () => {
    expect(activeSubmissionFor({ groupId: 99, profileId: null }, 403, index)).toBe(403);
    expect(activeSubmissionFor({ groupId: null, profileId: "unknown" }, 404, index)).toBe(404);
    expect(activeSubmissionFor(null, 405, index)).toBe(405);
  });

  it("treats the retargeted assignment as covering the active submission", () => {
    // End to end: the stale assignment is remapped, so no duplicate is drafted.
    const stale = { assignee_profile_id: "grader-a", submission_id: 400, rubric_part_id: null };
    const remapped: DraftAssignment = {
      ...stale,
      submission_id: activeSubmissionFor({ groupId: null, profileId: "student-1" }, stale.submission_id, index)
    };

    const { drafts, skippedAlreadyAssigned } = allocateRoundRobin({
      submissionIds: [500],
      assigneeProfileIds: ["grader-a", "grader-b"],
      rubricPartIds: null,
      existing: [remapped]
    });

    expect(drafts).toEqual([]);
    expect(skippedAlreadyAssigned).toBe(1);
  });

  it("would have duplicated the work without retargeting", () => {
    // Guards the regression: keeping the stale id drafts the active submission.
    const { drafts } = allocateRoundRobin({
      submissionIds: [500],
      assigneeProfileIds: ["grader-a", "grader-b"],
      rubricPartIds: null,
      existing: [{ assignee_profile_id: "grader-a", submission_id: 400, rubric_part_id: null }]
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].submission_id).toBe(500);
  });
});

describe("findCoverageConflicts", () => {
  // The --file manifest is the escape hatch around allocateRoundRobin, and
  // bulk_assign_reviews checks coverage no more than it does. Two shapes corrupt
  // grading state, and a dry run would otherwise approve both.
  const whole = (assignee: string, submission: number): DraftAssignment => ({
    assignee_profile_id: assignee,
    submission_id: submission,
    rubric_part_id: null
  });
  const part = (assignee: string, submission: number, rubricPart: number): DraftAssignment => ({
    assignee_profile_id: assignee,
    submission_id: submission,
    rubric_part_id: rubricPart
  });

  it("accepts a manifest that covers distinct work", () => {
    expect(findCoverageConflicts([part(GRADER_A, 1, 100), part(GRADER_B, 1, 200)], [])).toEqual([]);
    expect(findCoverageConflicts([whole(GRADER_A, 1), whole(GRADER_B, 2)], [])).toEqual([]);
  });

  it("rejects a whole-rubric row alongside a part row for the same submission", () => {
    // The RPC would reuse the row and add the part link, narrowing a whole-rubric
    // assignment to just that part.
    const conflicts = findCoverageConflicts([whole(GRADER_A, 1), part(GRADER_A, 1, 100)], []);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/submission 1/);
  });

  it("rejects a part row that overlaps an existing whole-rubric assignment", () => {
    const conflicts = findCoverageConflicts([part(GRADER_B, 1, 100)], [whole(GRADER_A, 1)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/narrowed/);
  });

  it("rejects the same part assigned to two reviewers", () => {
    const conflicts = findCoverageConflicts([part(GRADER_A, 1, 100), part(GRADER_B, 1, 100)], []);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/more than one reviewer/);
  });

  it("rejects a whole rubric assigned to two reviewers", () => {
    const conflicts = findCoverageConflicts([whole(GRADER_A, 1), whole(GRADER_B, 1)], []);
    expect(conflicts.some((c) => /more than one reviewer/.test(c))).toBe(true);
  });

  it("detects an overlap against existing part work too", () => {
    const conflicts = findCoverageConflicts([whole(GRADER_A, 1)], [part(GRADER_B, 1, 100)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/overlaps part assignment/);
  });

  it("does not flag re-assigning identical work to the same reviewer", () => {
    // Idempotent rerun: the RPC reuses the row, which is the intended behavior.
    expect(findCoverageConflicts([part(GRADER_A, 1, 100)], [part(GRADER_A, 1, 100)])).toEqual([]);
  });

  it("reports each conflicting submission once, not once per row", () => {
    const conflicts = findCoverageConflicts([whole(GRADER_A, 1), part(GRADER_A, 1, 100), part(GRADER_A, 1, 200)], []);
    expect(conflicts).toHaveLength(1);
  });
});

describe("planStaleRetargets", () => {
  const row = (over: Partial<ExistingAssignmentRow>): ExistingAssignmentRow => ({
    rowId: 1,
    assignee: "ta-1",
    rawSubmissionId: 100,
    activeSubmissionId: 100,
    rubricPartId: null,
    dueDate: "2026-03-01T05:00:00Z",
    ...over
  });

  it("repairs a stale row whose active slot nobody else claims", () => {
    const plan = planStaleRetargets([row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200 })]);
    // The draft names the *stale* id, which is what makes the RPC retarget that row.
    expect(plan.retargetDrafts).toEqual([{ assignee_profile_id: "ta-1", submission_id: 100, rubric_part_id: null }]);
    // Coverage is recorded against the active submission, so the allocator does not
    // hand the same work out again.
    expect(plan.existing).toEqual([{ assignee_profile_id: "ta-1", submission_id: 200, rubric_part_id: null }]);
    expect(plan.staleDueDates.get(1)).toBe("2026-03-01T05:00:00Z");
    expect(plan.contestedRowIds).toEqual([]);
  });

  it("leaves a row alone when the active submission is already assigned", () => {
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200 }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200 })
    ]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds).toEqual([1]);
    expect(plan.staleDueDates.size).toBe(0);
  });

  it("suppresses the whole row when only one of its parts is contested", () => {
    // The bug this guards: deciding per part queued a repair for part 2 while
    // skipping part 1, and the RPC retargets whole rows — so part 1 moved anyway and
    // collided with row 2.
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 1 }),
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 2 }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: 1 })
    ]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds).toEqual([1]);
  });

  it("repairs every part of a row when none of them is contested", () => {
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 1 }),
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 2 })
    ]);
    expect(plan.retargetDrafts).toHaveLength(2);
    expect(plan.retargetDrafts.map((d) => d.rubric_part_id)).toEqual([1, 2]);
    // One row, so one deadline to restore however many parts it covers.
    expect(plan.staleDueDates.size).toBe(1);
  });

  it("suppresses both rows when two stale rows target the same active slot", () => {
    // Repairing either would collide with the other.
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 300 }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 300 })
    ]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds.sort()).toEqual([1, 2]);
  });

  it("counts contested rows once however many parts they cover", () => {
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 1 }),
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 2 }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: 1 }),
      row({ rowId: 3, assignee: "ta-3", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: 2 })
    ]);
    expect(plan.contestedRowIds).toEqual([1]);
  });

  it("treats a stale whole-rubric row as colliding with any part already assigned", () => {
    // `submission:all` and `submission:1` are not unrelated slots: whole-rubric coverage
    // includes every part, so retargeting would overlap the existing part assignment.
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: null }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: 1 })
    ]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds).toEqual([1]);
  });

  it("treats a stale part row as colliding with an existing whole-rubric assignment", () => {
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: 3 }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: null })
    ]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds).toEqual([1]);
  });

  it("does not confuse submission 20 with submission 200", () => {
    // A prefix-matched key would have let 200's part claims contest 20's whole-rubric row.
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 20, rubricPartId: null }),
      row({ rowId: 2, assignee: "ta-2", rawSubmissionId: 200, activeSubmissionId: 200, rubricPartId: 1 })
    ]);
    expect(plan.retargetDrafts).toEqual([{ assignee_profile_id: "ta-1", submission_id: 100, rubric_part_id: null }]);
    expect(plan.contestedRowIds).toEqual([]);
  });

  it("still repairs a stale whole-rubric row when nothing else claims the submission", () => {
    const plan = planStaleRetargets([
      row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 200, rubricPartId: null })
    ]);
    expect(plan.retargetDrafts).toHaveLength(1);
    expect(plan.contestedRowIds).toEqual([]);
  });

  it("passes through rows that are not stale, without repairing anything", () => {
    const plan = planStaleRetargets([row({ rowId: 1, rawSubmissionId: 100, activeSubmissionId: 100 })]);
    expect(plan.retargetDrafts).toEqual([]);
    expect(plan.contestedRowIds).toEqual([]);
    expect(plan.existing).toEqual([{ assignee_profile_id: "ta-1", submission_id: 100, rubric_part_id: null }]);
  });
});
