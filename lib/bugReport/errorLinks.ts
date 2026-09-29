/**
 * The Sentry errors a recording links to (`error_ids`, `trace_ids` on the replay event). Each is
 * kept with the time it was captured, so a frozen buffer, and a buffer trimmed to the last N
 * minutes in review, link only the errors inside the window they replay.
 */
import type { LinkedError } from "./types";

/** Most errors remembered per recording; past it the oldest are dropped. */
export const MAX_LINKED_ERRORS = 100;

/** Adds an error unless its event id is already there, dropping the oldest past the cap. */
export function noteLinkedError(errors: LinkedError[], error: LinkedError): void {
  if (!error.eventId && !error.traceId) return;
  if (error.eventId && errors.some((e) => e.eventId === error.eventId)) return;
  errors.push(error);
  if (errors.length > MAX_LINKED_ERRORS) errors.splice(0, errors.length - MAX_LINKED_ERRORS);
}

/** The errors captured at or after `since`, and their distinct event and trace ids. */
export function linkedErrorsSince(
  errors: readonly LinkedError[],
  since: number
): { errors: LinkedError[]; errorIds: string[]; traceIds: string[] } {
  const kept = errors.filter((e) => e.at >= since);
  const errorIds = new Set<string>();
  const traceIds = new Set<string>();
  for (const e of kept) {
    if (e.eventId) errorIds.add(e.eventId);
    if (e.traceId) traceIds.add(e.traceId);
  }
  return { errors: kept, errorIds: [...errorIds], traceIds: [...traceIds] };
}
