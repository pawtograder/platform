/**
 * The URLs a recording visited (`urls` on the replay event). Each visit is kept with its time,
 * so a frozen buffer, and a buffer trimmed to the last N minutes in review, list only the URLs
 * of the window they replay.
 */
import type { UrlVisit } from "./types";

/**
 * The visits of a window starting at `since`: the one current at `since`, and every later one.
 * `visits` is in time order.
 */
export function visitsSince(visits: readonly UrlVisit[], since: number): UrlVisit[] {
  let first = visits.findIndex((v) => v.at > since);
  if (first === -1) first = visits.length;
  return visits.slice(Math.max(0, first - 1));
}

/** The visited URLs in order of first visit, without duplicates. */
export function visitedUrls(visits: readonly UrlVisit[]): string[] {
  return Array.from(new Set(visits.map((v) => v.url)));
}
