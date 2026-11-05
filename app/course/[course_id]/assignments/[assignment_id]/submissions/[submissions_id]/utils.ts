"use client";

/** grade, files, results, repo-analytics, checks, deployments, or survey after /submissions/:id/ — avoids false positives from .includes("/files") elsewhere. */
const SUBMISSION_SUB_PAGE_RE =
  /\/submissions\/[^/]+\/(?:grade|files|results|repo-analytics|checks|deployments|survey)(?:\/|$|\?|#)/;

/** Last path segment after /submissions/:id/ (grade/files/results) — used for default active tab. */
export function getSubmissionFilesOrResultsTab(pathname: string): "grade" | "files" | "results" | null {
  const m = pathname.match(/\/submissions\/[^/]+\/(grade|files|results)(?:\/|$|\?|#)/);
  if (m?.[1] === "grade" || m?.[1] === "files" || m?.[1] === "results") {
    return m[1];
  }
  return null;
}

export function linkToSubPage(pathname: string, page: string, searchParams?: URLSearchParams) {
  const base = pathname.replace(/\/$/, "");
  const newPath = SUBMISSION_SUB_PAGE_RE.test(base)
    ? `${base.slice(0, base.lastIndexOf("/"))}/${page}`
    : `${base}/${page}`;
  return `${newPath}${searchParams ? `?${searchParams.toString()}` : ""}`;
}

/** Every sub-page a submission can be viewed on; the one in the URL is carried to the next submission. */
const SUBMISSION_SUB_PAGE_NAME_RE =
  /\/submissions\/[^/]+\/(grade|files|results|repo-analytics|checks|deployments|survey)(?:\/|$|\?|#)/;

export type SubmissionSubPage = "grade" | "files" | "results" | "repo-analytics" | "checks" | "deployments" | "survey";

/** The sub-page (tab) the current submission URL is on, or null on the bare submission root. */
export function getSubmissionSubPage(pathname: string): SubmissionSubPage | null {
  const m = pathname.match(SUBMISSION_SUB_PAGE_NAME_RE);
  return (m?.[1] as SubmissionSubPage | undefined) ?? null;
}

/**
 * URL for another submission of the same assignment, on the same tab the grader is looking at now.
 * With no tab (`subPage` null) the submission root picks its own default.
 */
export function submissionUrl({
  courseId,
  assignmentId,
  submissionId,
  subPage,
  reviewAssignmentId
}: {
  courseId: string | number;
  assignmentId: string | number;
  submissionId: number;
  subPage: SubmissionSubPage | null;
  reviewAssignmentId?: number;
}) {
  const path = `/course/${courseId}/assignments/${assignmentId}/submissions/${submissionId}${subPage ? `/${subPage}` : ""}`;
  return reviewAssignmentId ? `${path}?review_assignment_id=${reviewAssignmentId}` : path;
}
