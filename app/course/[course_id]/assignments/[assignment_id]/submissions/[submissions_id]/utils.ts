"use client";

export function linkToSubPage(pathname: string, page: string, searchParams?: URLSearchParams) {
  const newPath =
    pathname.includes("/files") || pathname.includes("/results")
      ? `${pathname.substring(0, pathname.lastIndexOf("/"))}/${page}`
      : pathname + "/" + page;
  return `${newPath}${searchParams ? `?${searchParams.toString()}` : ""}`;
}
