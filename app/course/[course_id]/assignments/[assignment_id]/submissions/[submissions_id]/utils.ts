"use client";

export function linkToSubPage(pathname: string, page: string, searchParams?: URLSearchParams) {
  const newPath = `${pathname.substring(0, pathname.lastIndexOf("/"))}/${page}`;
  return `${newPath}${searchParams ? `?${searchParams.toString()}` : ""}`;
}
