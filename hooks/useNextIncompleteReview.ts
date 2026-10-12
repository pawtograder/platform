"use client";

import {
  getSubmissionSubPage,
  submissionUrl
} from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/utils";
import { useActiveSubmissions, useAssignmentGroups, useMyReviewAssignments } from "@/hooks/useAssignment";
import { useAllProfilesForClass, useGradersAndInstructors } from "@/hooks/useCourseController";
import { useParams, usePathname } from "next/navigation";
import { useMemo } from "react";

/** One row of the review-mode submission dropdown: a submission with review assignments for me. */
export type ReviewSubmissionOption = {
  submissionId: number;
  /** Prefer an incomplete review assignment for this submission. */
  reviewAssignmentId?: number;
  hasIncompleteReview: boolean;
  allReviewsComplete: boolean;
  totalReviews: number;
  completedReviews: number;
};

/**
 * My review assignments grouped per submission, in the order the review dropdown shows them:
 * submissions with incomplete reviews first, then by submission id.
 */
export function useMyReviewSubmissionOptions(): ReviewSubmissionOption[] {
  const myReviewAssignments = useMyReviewAssignments();
  return useMemo(() => {
    const bySubmission = new Map<number, typeof myReviewAssignments>();
    myReviewAssignments.forEach((ra) => {
      const existing = bySubmission.get(ra.submission_id) || [];
      bySubmission.set(ra.submission_id, [...existing, ra]);
    });
    const options = Array.from(bySubmission.entries()).map(([submissionId, assignments]) => {
      const primary = assignments.find((ra) => !ra.completed_at) || assignments[0];
      const completedReviews = assignments.filter((ra) => ra.completed_at).length;
      return {
        submissionId,
        reviewAssignmentId: primary?.id,
        hasIncompleteReview: assignments.some((ra) => !ra.completed_at),
        allReviewsComplete: assignments.every((ra) => ra.completed_at),
        totalReviews: assignments.length,
        completedReviews
      };
    });
    options.sort((a, b) => {
      if (a.hasIncompleteReview && !b.hasIncompleteReview) return -1;
      if (!a.hasIncompleteReview && b.hasIncompleteReview) return 1;
      return a.submissionId - b.submissionId;
    });
    return options;
  }, [myReviewAssignments]);
}

export interface SubmissionOption {
  value: number;
  label: string;
  authorName: string;
  isStudent: boolean;
}

export interface SubmissionGroup {
  label: string;
  options: SubmissionOption[];
}

/**
 * Every active submission for the assignment, grouped Students then Instructors & Graders and sorted
 * by author name: the order of the "select any submission" picker graders use when they have no
 * review assignments.
 */
export function useGroupedSubmissionOptions(): SubmissionGroup[] {
  const submissions = useActiveSubmissions();
  const classProfiles = useAllProfilesForClass();
  const assignmentGroups = useAssignmentGroups();
  const staffProfiles = useGradersAndInstructors();

  return useMemo(() => {
    const studentSubmissions: SubmissionOption[] = [];
    const staffSubmissions: SubmissionOption[] = [];

    submissions.forEach((submission) => {
      let authorName = "";
      if (submission.profile_id) {
        const profile = classProfiles.find((p) => p.id === submission.profile_id);
        authorName = profile?.name || `Submission ${submission.id}`;
      } else if (submission.assignment_group_id) {
        const group = assignmentGroups.find((g) => g.id === submission.assignment_group_id);
        authorName = group?.name || `Group ${submission.assignment_group_id}`;
      } else {
        authorName = `Submission ${submission.id}`;
      }

      // A profile that belongs to a grader or instructor is a staff submission (e.g. a test run).
      const isStudent = submission.profile_id ? !staffProfiles.find((p) => p.id === submission.profile_id) : true;

      const option: SubmissionOption = { value: submission.id, label: authorName, authorName, isStudent };
      (isStudent ? studentSubmissions : staffSubmissions).push(option);
    });

    const groups: SubmissionGroup[] = [];
    if (studentSubmissions.length > 0) {
      groups.push({ label: "Students", options: studentSubmissions.sort((a, b) => a.label.localeCompare(b.label)) });
    }
    if (staffSubmissions.length > 0) {
      groups.push({
        label: "Instructors & Graders",
        options: staffSubmissions.sort((a, b) => a.label.localeCompare(b.label))
      });
    }
    return groups;
  }, [submissions, classProfiles, assignmentGroups, staffProfiles]);
}

export type SubmissionNavigation = {
  /** True when the viewer has review assignments on this assignment. */
  isReviewMode: boolean;
  /** Review mode: the next submission with an incomplete review for me. Otherwise: the next submission in the picker. */
  nextUrl: string | null;
  /** The previous submission in the same list, including ones already completed, so a grader can go back and fix one. */
  previousUrl: string | null;
  /** URL for a given submission on the current tab. */
  urlFor: (submissionId: number, reviewAssignmentId?: number) => string;
};

/**
 * Previous/next submission for the grading toolbar and for "complete and move on".
 *
 * Every URL keeps the tab the grader is on now (Files, Autograder Detail, Survey, ...), so moving
 * through 20 submissions does not mean re-picking the tab 20 times. A target that lacks the tab
 * falls back on its own: the layout redirects a no-submission assignment to Grade, for instance.
 */
export function useSubmissionNavigation(): SubmissionNavigation {
  const { course_id, assignment_id, submissions_id } = useParams();
  const pathname = usePathname();
  const reviewOptions = useMyReviewSubmissionOptions();
  const groups = useGroupedSubmissionOptions();
  const subPage = getSubmissionSubPage(pathname);

  return useMemo(() => {
    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : undefined;
    const urlFor = (submissionId: number, reviewAssignmentId?: number) =>
      submissionUrl({
        courseId: course_id as string,
        assignmentId: assignment_id as string,
        submissionId,
        subPage,
        reviewAssignmentId
      });

    if (reviewOptions.length > 0) {
      // Same rule the "Next Incomplete" link has always used: the first incomplete submission after
      // this one by id, wrapping around to the first incomplete one overall.
      const next =
        reviewOptions.find(
          (opt) => opt.hasIncompleteReview && (!currentSubmissionId || opt.submissionId > currentSubmissionId)
        ) || reviewOptions.find((opt) => opt.hasIncompleteReview && opt.submissionId !== currentSubmissionId);
      // Previous walks back by id through all of my submissions, complete or not, without wrapping:
      // after "complete and move on" it returns to the one just finished.
      const previous = currentSubmissionId
        ? reviewOptions
            .filter((opt) => opt.submissionId < currentSubmissionId)
            .sort((a, b) => b.submissionId - a.submissionId)[0]
        : undefined;
      return {
        isReviewMode: true,
        nextUrl: next ? urlFor(next.submissionId, next.reviewAssignmentId) : null,
        previousUrl: previous
          ? urlFor(previous.submissionId, previous.hasIncompleteReview ? previous.reviewAssignmentId : undefined)
          : null,
        urlFor
      };
    }

    const ordered = groups.flatMap((g) => g.options);
    const index = ordered.findIndex((opt) => opt.value === currentSubmissionId);
    const next = index >= 0 ? ordered[index + 1] : undefined;
    const previous = index > 0 ? ordered[index - 1] : undefined;
    return {
      isReviewMode: false,
      nextUrl: next ? urlFor(next.value) : null,
      previousUrl: previous ? urlFor(previous.value) : null,
      urlFor
    };
  }, [course_id, assignment_id, submissions_id, subPage, reviewOptions, groups]);
}

/**
 * Returns the URL for the next incomplete review assignment, or null if all
 * reviews are complete or the user is not in review mode. Keeps the current tab.
 */
export function useNextIncompleteReviewUrl(): string | null {
  const { isReviewMode, nextUrl } = useSubmissionNavigation();
  return isReviewMode ? nextUrl : null;
}
