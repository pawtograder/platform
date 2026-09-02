"use client";

/** grade, files, results, repo-analytics, checks, or deployments after /submissions/:id/ — avoids false positives from .includes("/files") elsewhere. */
const SUBMISSION_SUB_PAGE_RE =
  /\/submissions\/[^/]+\/(?:grade|files|results|repo-analytics|checks|deployments)(?:\/|$|\?|#)/;

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
