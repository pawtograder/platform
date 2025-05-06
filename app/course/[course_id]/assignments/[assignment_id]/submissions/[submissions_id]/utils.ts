"use client";

export function linkToSubPage(pathname: string, page: string) {
  const basePath = pathname.substring(0, pathname.lastIndexOf("/"));
  return `${basePath}/${page}`;
}
