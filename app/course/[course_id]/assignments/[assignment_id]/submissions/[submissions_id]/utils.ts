"use client";

const SUB_PAGES = ["/files", "/results", "/repo-analytics"];

export function linkToSubPage(pathname: string, page: string, searchParams?: URLSearchParams) {
  const isOnSubPage = SUB_PAGES.some((p) => pathname.includes(p));
  const newPath = isOnSubPage ? `${pathname.substring(0, pathname.lastIndexOf("/"))}/${page}` : pathname + "/" + page;
  return `${newPath}${searchParams ? `?${searchParams.toString()}` : ""}`;
}
