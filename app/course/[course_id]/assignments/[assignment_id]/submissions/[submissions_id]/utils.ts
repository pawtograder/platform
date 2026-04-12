"use client";

/** Files, results, or repo-analytics after /submissions/:id/ — avoids false positives from .includes("/files") elsewhere. */
const SUBMISSION_SUB_PAGE_RE = /\/submissions\/[^/]+\/(?:files|results|repo-analytics)(?:\/|$|\?|#)/;

/** Last path segment after /submissions/:id/ for files vs results — used for default active tab. */
export function getSubmissionFilesOrResultsTab(pathname: string): "files" | "results" | null {
  const m = pathname.match(/\/submissions\/[^/]+\/(files|results)(?:\/|$|\?|#)/);
  if (m?.[1] === "files" || m?.[1] === "results") {
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
