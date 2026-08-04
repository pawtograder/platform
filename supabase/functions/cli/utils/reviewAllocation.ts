/**
 * Round-robin allocation of grading work for `reviews assign`.
 *
 * Kept free of any Supabase dependency so it can be unit tested directly. The
 * command handler gathers submissions, the staff pool, rubric parts, existing
 * assignments, and grading conflicts, then hands them here.
 *
 * This is deliberately simpler than the web UI's bulk-assign page, which runs a
 * min-cost-flow solver over per-TA capacities and historical workload
 * (`app/course/[course_id]/manage/assignments/[assignment_id]/reviews/assignmentCalculator.tsx`).
 * The CLI aims for an even, reproducible split; anything more finely weighted goes
 * through `--file` with an explicit manifest.
 */

export interface DraftAssignment {
  assignee_profile_id: string;
  submission_id: number;
  /** null means the assignment covers the whole rubric rather than one part. */
  rubric_part_id: number | null;
}

export interface AllocateRoundRobinInput {
  /** Submissions to be reviewed. */
  submissionIds: number[];
  /** Eligible reviewers (staff private profile ids). */
  assigneeProfileIds: string[];
  /** Rubric parts to fan out over, or null to assign the whole rubric once. */
  rubricPartIds: number[] | null;
  /**
   * Assignments that already exist. Used twice: to skip work that is already
   * assigned, and to seed each reviewer's load so a re-run spreads new work
   * across the people who have least so far.
   */
  existing: DraftAssignment[];
  /**
   * Reviewers who must not be given a particular submission, keyed by
   * submission id. Built from `grading_conflicts` and from group membership, so
   * nobody is asked to grade their own work or a student they are conflicted
   * with.
   */
  excludedBySubmission?: Map<number, Set<string>>;
}

export interface AllocateRoundRobinResult {
  drafts: DraftAssignment[];
  /** (submission, part) pairs that already had an assignee. */
  skippedAlreadyAssigned: number;
  /**
   * Pairs with no eligible reviewer left after exclusions. These are reported
   * rather than silently dropped — an operator needs to know that some
   * submissions went unassigned.
   */
  unassignable: Array<{ submission_id: number; rubric_part_id: number | null }>;
}

/**
 * Deals each (submission, rubric part) pair to the eligible reviewer holding the
 * least work, breaking ties by profile id. Inputs are sorted first, so the same
 * inputs always produce the same output.
 *
 * Coverage, not key equality, decides what is already assigned. An assignment
 * with no rubric-part links covers the *whole* rubric, so it also covers every
 * individual part: treating `submission:null` as merely a different key from
 * `submission:<part>` meant `--by-part` after a whole-rubric assignment re-dealt
 * every part, and `bulk_assign_reviews` would then either duplicate the work
 * across assignees or, reusing the same assignee's row, silently narrow that
 * whole-rubric assignment down to the added parts. The reverse direction was
 * equally wrong.
 */
export function allocateRoundRobin(input: AllocateRoundRobinInput): AllocateRoundRobinResult {
  const submissionIds = [...new Set(input.submissionIds)].sort((a, b) => a - b);
  const assignees = [...new Set(input.assigneeProfileIds)].sort((a, b) => a.localeCompare(b));
  const parts = input.rubricPartIds === null ? [null] : [...new Set(input.rubricPartIds)].sort((a, b) => a - b);

  /** Submissions already covered by a whole-rubric assignment. */
  const wholeRubricCovered = new Set<number>();
  /** submission id -> rubric part ids already assigned individually. */
  const partsCovered = new Map<number, Set<number>>();
  for (const e of input.existing) {
    if (e.rubric_part_id === null) {
      wholeRubricCovered.add(e.submission_id);
    } else {
      const set = partsCovered.get(e.submission_id) ?? new Set<number>();
      set.add(e.rubric_part_id);
      partsCovered.set(e.submission_id, set);
    }
  }

  /** Whether this (submission, part) slot is already someone's job. */
  const isCovered = (submissionId: number, rubricPartId: number | null): boolean => {
    if (wholeRubricCovered.has(submissionId)) return true;
    const covered = partsCovered.get(submissionId);
    if (!covered || covered.size === 0) return false;
    // A whole-rubric draft would overlap any part that is already assigned;
    // "the remaining parts" is not expressible as a single assignment.
    if (rubricPartId === null) return true;
    return covered.has(rubricPartId);
  };

  const load = new Map<string, number>();
  for (const id of assignees) load.set(id, 0);
  for (const e of input.existing) {
    // Only count load for people in the current pool; work held by someone
    // outside it should not skew the split.
    if (load.has(e.assignee_profile_id)) {
      load.set(e.assignee_profile_id, load.get(e.assignee_profile_id)! + 1);
    }
  }

  const drafts: DraftAssignment[] = [];
  const unassignable: AllocateRoundRobinResult["unassignable"] = [];
  let skippedAlreadyAssigned = 0;

  for (const submissionId of submissionIds) {
    const excluded = input.excludedBySubmission?.get(submissionId);
    // Hoisted: exclusions are per submission and do not vary across its rubric parts, so
    // filtering inside the inner loop rebuilt the same array once per part.
    const eligible = excluded ? assignees.filter((id) => !excluded.has(id)) : assignees;

    for (const rubricPartId of parts) {
      if (isCovered(submissionId, rubricPartId)) {
        skippedAlreadyAssigned++;
        continue;
      }

      if (eligible.length === 0) {
        unassignable.push({ submission_id: submissionId, rubric_part_id: rubricPartId });
        continue;
      }

      let chosen = eligible[0]!;
      for (const candidate of eligible) {
        if (load.get(candidate)! < load.get(chosen)!) chosen = candidate;
      }

      drafts.push({ assignee_profile_id: chosen, submission_id: submissionId, rubric_part_id: rubricPartId });
      load.set(chosen, load.get(chosen)! + 1);
    }
  }

  return { drafts, skippedAlreadyAssigned, unassignable };
}

/** Who a submission belongs to: a group, or an individual student. */
export interface SubmissionOwner {
  groupId: number | null;
  profileId: string | null;
}

/**
 * Indexes active submissions by owner, so a stale submission id can be mapped
 * onto whatever is current for the same student or group.
 */
export function buildActiveSubmissionIndex(
  active: Array<{ id: number; profile_id: string | null; assignment_group_id: number | null }>
): Map<string, number> {
  const index = new Map<string, number>();
  for (const submission of active) {
    if (submission.assignment_group_id != null) {
      index.set(`g:${submission.assignment_group_id}`, submission.id);
    }
    if (submission.profile_id) {
      index.set(`p:${submission.profile_id}`, submission.id);
    }
  }
  return index;
}

/**
 * The current active submission for `owner`, falling back to `fallbackId`.
 *
 * Existing review assignments can point at a submission that a resubmission has
 * since superseded. Comparing raw ids would make the student's current
 * submission look unassigned, so the allocator would draft it again — usually to
 * a different assignee, since the stale assignment still counts toward reviewer
 * load. `bulk_assign_reviews` only retargets rows its own drafts touch, so the
 * stale assignment would survive and the submission would be graded twice.
 *
 * Group ownership wins over the individual profile: a group submission carries
 * both, and the group is the unit the assignment follows.
 */
export function activeSubmissionFor(
  owner: SubmissionOwner | null,
  fallbackId: number,
  index: Map<string, number>
): number {
  if (!owner) return fallbackId;
  if (owner.groupId != null) return index.get(`g:${owner.groupId}`) ?? fallbackId;
  if (owner.profileId) return index.get(`p:${owner.profileId}`) ?? fallbackId;
  return fallbackId;
}

export interface ExistingCoverageRow {
  assignee: string;
  /** The submission the row points at, which may have been superseded. */
  rawSubmissionId: number;
  /** The row's submission as embedded by the query, or null when it did not load. */
  submission: { is_active: boolean; profile_id: string | null; assignment_group_id: number | null } | null;
  /** Empty for a whole-rubric assignment. */
  rubricPartIds: number[];
}

/**
 * Existing review assignments flattened to coverage, in *active* submission ids.
 *
 * The remap is the point. An existing assignment can name a submission that a
 * resubmission has superseded, while a `--file` manifest names the active one — so
 * comparing raw ids reported no overlap and let the manifest add a second reviewer for
 * work already assigned. `bulk_assign_reviews` retargets only the rows its own drafts
 * touch, so the stale row survives and the submission is graded twice.
 *
 * A row whose submission is already active maps to itself. A row with no embedded
 * submission, or whose owner has no active submission at all, keeps its raw id: the
 * conservative choice, since coverage is still reported, just not merged with anything.
 */
export function flattenExistingCoverage(
  rows: ExistingCoverageRow[],
  activeByOwner: Map<string, number>
): DraftAssignment[] {
  const out: DraftAssignment[] = [];
  for (const row of rows) {
    const submissionId =
      row.submission && row.submission.is_active === false
        ? activeSubmissionFor(
            { groupId: row.submission.assignment_group_id, profileId: row.submission.profile_id },
            row.rawSubmissionId,
            activeByOwner
          )
        : row.rawSubmissionId;
    if (row.rubricPartIds.length === 0) {
      out.push({ assignee_profile_id: row.assignee, submission_id: submissionId, rubric_part_id: null });
    } else {
      for (const partId of row.rubricPartIds) {
        out.push({ assignee_profile_id: row.assignee, submission_id: submissionId, rubric_part_id: partId });
      }
    }
  }
  return out;
}

/**
 * Coverage conflicts in an explicit set of drafts.
 *
 * The round-robin path cannot produce these — `allocateRoundRobin` skips anything
 * already covered — but an explicit `--file` manifest bypasses that reasoning
 * entirely, and `bulk_assign_reviews` does not check coverage either. Two shapes
 * corrupt grading state:
 *
 *   - A whole-rubric draft and a part draft for the same submission. The RPC
 *     reuses the assignee's row and adds the part link, converting a whole-rubric
 *     assignment into a part-only one — silently narrowing what gets graded.
 *   - Overlapping drafts for different assignees, which duplicates the work.
 *
 * Checked against the manifest's own entries and against what already exists.
 */
export function findCoverageConflicts(drafts: DraftAssignment[], existing: DraftAssignment[]): string[] {
  const conflicts: string[] = [];

  const wholeRubric = new Map<number, Set<string>>();
  const byPart = new Map<string, Set<string>>();
  /** Part ids claimed per submission, so the whole-rubric overlap check is a lookup. */
  const partsBySubmission = new Map<number, Set<number>>();
  const record = <K>(map: Map<K, Set<string>>, key: K, assignee: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(assignee);
    map.set(key, set);
  };

  for (const entry of [...existing, ...drafts]) {
    if (entry.rubric_part_id === null) {
      record(wholeRubric, entry.submission_id, entry.assignee_profile_id);
    } else {
      record(byPart, `${entry.submission_id}:${entry.rubric_part_id}`, entry.assignee_profile_id);
      const claimed = partsBySubmission.get(entry.submission_id) ?? new Set<number>();
      claimed.add(entry.rubric_part_id);
      partsBySubmission.set(entry.submission_id, claimed);
    }
  }

  const seen = new Set<string>();
  for (const draft of drafts) {
    const submissionId = draft.submission_id;

    if (draft.rubric_part_id === null) {
      // A lookup, not a scan. Spreading and prefix-matching every part key once per
      // whole-rubric draft was quadratic: a 5,000-entry manifest against an assignment
      // with 5,500 part claims did ~27M string comparisons to answer an O(1) question.
      const parts = [...(partsBySubmission.get(submissionId) ?? [])].sort((a, b) => a - b);
      if (parts.length > 0 && !seen.has(`whole:${submissionId}`)) {
        seen.add(`whole:${submissionId}`);
        conflicts.push(
          `submission ${submissionId}: a whole-rubric assignment overlaps part assignment(s) ` + parts.join(", ")
        );
      }
      const holders = wholeRubric.get(submissionId);
      if (holders && holders.size > 1 && !seen.has(`dupwhole:${submissionId}`)) {
        seen.add(`dupwhole:${submissionId}`);
        conflicts.push(`submission ${submissionId}: assigned to more than one reviewer for the whole rubric`);
      }
    } else {
      const key = `${submissionId}:${draft.rubric_part_id}`;
      if (wholeRubric.has(submissionId) && !seen.has(`whole:${submissionId}`)) {
        seen.add(`whole:${submissionId}`);
        conflicts.push(
          `submission ${submissionId}: rubric part ${draft.rubric_part_id} overlaps an existing ` +
            "whole-rubric assignment, which would be narrowed to that part"
        );
      }
      const holders = byPart.get(key);
      if (holders && holders.size > 1 && !seen.has(`dup:${key}`)) {
        seen.add(`dup:${key}`);
        conflicts.push(
          `submission ${submissionId}, rubric part ${draft.rubric_part_id}: assigned to more than one reviewer`
        );
      }
    }
  }

  return conflicts;
}

/** Per-reviewer draft counts, for the summary the CLI prints. */
export function summarizeLoad(drafts: DraftAssignment[]): Array<{ assignee_profile_id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const d of drafts) {
    counts.set(d.assignee_profile_id, (counts.get(d.assignee_profile_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([assignee_profile_id, count]) => ({ assignee_profile_id, count }))
    .sort((a, b) => b.count - a.count || a.assignee_profile_id.localeCompare(b.assignee_profile_id));
}

/** An existing review assignment, flattened onto the rubric part it covers. */
export interface ExistingAssignmentRow {
  /** `review_assignments.id`. Several flattened rows can share one, under by-part grading. */
  rowId: number;
  assignee: string;
  /** The submission the row points at, which may have been superseded. */
  rawSubmissionId: number;
  /** The current active submission for that student or group. */
  activeSubmissionId: number;
  rubricPartId: number | null;
  dueDate: string;
}

export interface StaleRetargetPlan {
  /** Coverage as it will read after repair, for seeding the allocator. */
  existing: DraftAssignment[];
  /** Repairs to submit, naming the stale submission id the RPC will retarget. */
  retargetDrafts: DraftAssignment[];
  /** Original deadlines to restore after the RPC rewrites them, by row id. */
  staleDueDates: Map<number, string>;
  /** Stale rows left alone because repairing them would collide. */
  contestedRowIds: number[];
}

/**
 * Decides which stale review assignments can be repointed at the current submission.
 *
 * The decision is per `review_assignments` row, not per rubric part, because
 * `bulk_assign_reviews` retargets a whole row including all of its part links. Deciding
 * per part let a row covering parts 1 and 2 queue a repair for part 2 while part 1 was
 * skipped as contested — and the repair dragged part 1 along anyway, either duplicating
 * the existing part-1 assignment or tripping the
 * (assignee_profile_id, submission_review_id) uniqueness constraint and aborting the RPC.
 *
 * A contested row is left alone rather than repaired: with the same assignee the retarget
 * collides, and with a different assignee two reviewers end up holding the same work.
 * Neither is fixable from here — the redundant stale row wants deleting, which is
 * `reviews clear`'s job — so it is reported instead.
 */
export function planStaleRetargets(rows: ExistingAssignmentRow[]): StaleRetargetPlan {
  // Occupancy per active submission, split into whole-rubric claims and per-part ones.
  //
  // Whole-rubric coverage overlaps *every* part, so `submission:all` and
  // `submission:3` are not unrelated keys: comparing them as exact strings let a stale
  // whole-rubric row retarget onto a submission that already had part assignments (and
  // a stale part retarget onto an existing whole-rubric row), which is the overlapping
  // grading work and uniqueness-constraint abort this function exists to prevent.
  const wholeRubricClaims = new Map<number, number>();
  /** Every part claim on a submission, however many distinct parts. */
  const anyPartClaims = new Map<number, number>();
  const partClaims = new Map<string, number>();
  const partKey = (submissionId: number, rubricPartId: number) => `${submissionId}:${rubricPartId}`;
  const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const row of rows) {
    if (row.rubricPartId === null) {
      bump(wholeRubricClaims, row.activeSubmissionId);
    } else {
      bump(anyPartClaims, row.activeSubmissionId);
      bump(partClaims, partKey(row.activeSubmissionId, row.rubricPartId));
    }
  }

  /** How many claims overlap this row's coverage on the active submission, itself included. */
  const overlappingClaims = (row: ExistingAssignmentRow): number => {
    const whole = wholeRubricClaims.get(row.activeSubmissionId) ?? 0;
    // A whole-rubric row overlaps every part on that submission; a part row overlaps
    // only its own part, plus any whole-rubric claim.
    if (row.rubricPartId === null) return whole + (anyPartClaims.get(row.activeSubmissionId) ?? 0);
    return whole + (partClaims.get(partKey(row.activeSubmissionId, row.rubricPartId)) ?? 0);
  };

  const contested = new Set<number>();
  for (const row of rows) {
    if (row.activeSubmissionId === row.rawSubmissionId) continue;
    if (overlappingClaims(row) > 1) contested.add(row.rowId);
  }

  const existing: DraftAssignment[] = [];
  const retargetDrafts: DraftAssignment[] = [];
  const staleDueDates = new Map<number, string>();
  for (const row of rows) {
    // Coverage is recorded against the active submission either way: a repaired row will
    // point there, and a contested one is already covered there by whatever contests it.
    existing.push({
      assignee_profile_id: row.assignee,
      submission_id: row.activeSubmissionId,
      rubric_part_id: row.rubricPartId
    });
    if (row.activeSubmissionId === row.rawSubmissionId || contested.has(row.rowId)) continue;

    retargetDrafts.push({
      assignee_profile_id: row.assignee,
      submission_id: row.rawSubmissionId,
      rubric_part_id: row.rubricPartId
    });
    staleDueDates.set(row.rowId, row.dueDate);
  }

  return { existing, retargetDrafts, staleDueDates, contestedRowIds: [...contested] };
}
