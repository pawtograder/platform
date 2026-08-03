/**
 * Review-assignment status and pool rules, kept free of imports so the unit tests can
 * load this file directly. (The command modules reach Deno-only URL imports through
 * the router, which Jest cannot resolve.)
 */

/** The subset of a `review_assignments` row, plus its embedded review, that status depends on. */
export interface ReviewAssignmentStatusRow {
  completed_at: string | null;
  assignee_profile_id: string;
  submission_reviews?: { completed_at: string | null; grader: string | null } | null;
}

/**
 * Whether a review assignment counts as done, matching the web reviews table
 * (`reviews/ReviewsTable.tsx` `getReviewStatus`).
 *
 * Either the assignment itself is completed, **or** its linked submission_review was
 * completed *by this assignee*. The grader check matters: under by-part grading several
 * assignees share one submission_review, and only the one named as its grader actually
 * finished it. Consulting `review_assignments.completed_at` alone reported work as
 * pending that the web showed as completed, because completing a review does not write
 * back to the assignment row.
 */
export function isReviewComplete(row: ReviewAssignmentStatusRow): boolean {
  if (row.completed_at != null) return true;
  const review = row.submission_reviews;
  return review?.completed_at != null && review.grader === row.assignee_profile_id;
}

/** The subset of a `submissions` row the assignable-pool rules depend on. */
export interface AssignableSubmissionRow {
  id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
  submitted_via: string | null;
}

export interface AssignablePoolInput<T extends AssignableSubmissionRow> {
  submissions: T[];
  /** Private profile ids of everyone still enrolled (not disabled) in the class. */
  activeProfiles: ReadonlySet<string>;
  /** Members of each group referenced by `submissions`, by group id. */
  groupMembers: ReadonlyMap<number, string[]>;
  /**
   * Drop content-less placeholder stubs. False for `--include-non-submitters`, and for
   * no_submission assignments where a manual stub is the only kind of submission there is.
   */
  excludeStubs: boolean;
}

export interface AssignablePoolResult<T> {
  submissions: T[];
  excluded: { stubs: number; dropped_students: number };
}

/**
 * Narrow active submissions to the ones worth grading, mirroring the web bulk-assign
 * pool (`manage/assignments/[assignment_id]/reviews/bulk-assign/page.tsx`). Without
 * these rules the CLI dealt placeholder stubs and dropped students' work out as real
 * grading, and counted them in each grader's load.
 */
export function selectAssignableSubmissions<T extends AssignableSubmissionRow>(
  input: AssignablePoolInput<T>
): AssignablePoolResult<T> {
  const { submissions, activeProfiles, groupMembers, excludeStubs } = input;

  /** Whether anyone who owns this submission is still enrolled. */
  const hasActiveOwner = (row: T): boolean => {
    if (row.assignment_group_id != null) {
      return (groupMembers.get(row.assignment_group_id) ?? []).some((pid) => activeProfiles.has(pid));
    }
    return row.profile_id ? activeProfiles.has(row.profile_id) : false;
  };

  let stubs = 0;
  let droppedStudents = 0;
  const kept = submissions.filter((row) => {
    if (excludeStubs && row.submitted_via === "manual") {
      stubs++;
      return false;
    }
    if (!hasActiveOwner(row)) {
      droppedStudents++;
      return false;
    }
    return true;
  });

  return { submissions: kept, excluded: { stubs, dropped_students: droppedStudents } };
}
