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
 * The CLI aims for an even, reproducible split; anything more nuanced goes
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

    for (const rubricPartId of parts) {
      if (isCovered(submissionId, rubricPartId)) {
        skippedAlreadyAssigned++;
        continue;
      }

      const eligible = excluded ? assignees.filter((id) => !excluded.has(id)) : assignees;
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
