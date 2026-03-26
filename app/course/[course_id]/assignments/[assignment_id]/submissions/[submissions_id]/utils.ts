"use client";

/** Last path segment after /submissions/:id/ — avoids false positives from .includes("/files") elsewhere in the path. */
export function getSubmissionFilesOrResultsTab(pathname: string): "files" | "results" | null {
  const m = pathname.match(/\/submissions\/[^/]+\/(files|results)(?:\/|$|\?|#)/);
  if (m?.[1] === "files" || m?.[1] === "results") {
    return m[1];
  }
  return null;
}

export function linkToSubPage(pathname: string, page: string, searchParams?: URLSearchParams) {
  const base = pathname.replace(/\/$/, "");
  const newPath =
    getSubmissionFilesOrResultsTab(base) !== null
      ? `${base.slice(0, base.lastIndexOf("/"))}/${page}`
      : `${base}/${page}`;
  return `${newPath}${searchParams ? `?${searchParams.toString()}` : ""}`;
}
