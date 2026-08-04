/**
 * `--status` filter handling for help_requests.list.
 *
 * Split out from the command module so it can be unit tested: importing a
 * command module pulls in the router, which pulls in MCPAuth and its
 * URL-imported Deno dependencies.
 *
 * This module deliberately imports nothing but types. Jest compiles it under
 * the Node tsconfig, which rejects `.ts` import specifiers, so it cannot reach
 * for `CLICommandError` — hence `parseStatusFilter` returns an error string and
 * the command handler turns it into a 400.
 */

import type { Database } from "../../_shared/SupabaseTypes.d.ts";

export type HelpRequestStatus = Database["public"]["Enums"]["help_request_status"];

export const HELP_REQUEST_STATUSES: HelpRequestStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * The four enum values plus two convenience aliases matching how the
 * office-hours UI groups requests: `active` is everything not yet finished,
 * `all` applies no filter.
 */
export type HelpRequestStatusFilter = HelpRequestStatus | "active" | "all";

export const HELP_REQUEST_STATUS_FILTERS: HelpRequestStatusFilter[] = [...HELP_REQUEST_STATUSES, "active", "all"];

/** Statuses a request can be moved *to* by `help_requests.close`. */
export const TERMINAL_HELP_REQUEST_STATUSES: HelpRequestStatus[] = ["resolved", "closed"];

export const HELP_REQUEST_RESOLUTION_STATUSES: Array<Database["public"]["Enums"]["help_request_resolution_status"]> = [
  "self_solved",
  "staff_helped",
  "peer_helped",
  "no_time",
  "other"
];

export type StatusFilterResult =
  /** `statuses: null` means match every status. */
  { statuses: HelpRequestStatus[] | null } | { error: string };

/**
 * Translates a `--status` filter into the enum values to match.
 *
 * Anything unrecognized comes back as an error rather than quietly matching
 * everything — a typo'd filter that silently returns the whole queue is worse
 * than a rejected command.
 */
export function parseStatusFilter(filter: string | undefined | null): StatusFilterResult {
  if (filter === undefined || filter === null || filter === "all") return { statuses: null };
  if (filter === "active") return { statuses: ["open", "in_progress"] };
  if ((HELP_REQUEST_STATUSES as string[]).includes(filter)) return { statuses: [filter as HelpRequestStatus] };
  return {
    error: `Invalid status: ${filter}. Must be one of ${HELP_REQUEST_STATUS_FILTERS.join(", ")}`
  };
}

/**
 * The `resolved_at` to write when closing a help request.
 *
 * `resolved_at` records when the request was actually completed, and the office-hours
 * history sorts terminal requests by it. `--force` exists to correct resolution
 * metadata on an already-closed request, so stamping the current time made a week-old
 * request appear newly resolved and destroyed the real completion time. The original is
 * preserved on a forced correction — unless the row reached a terminal status without
 * one, in which case there is nothing to preserve and `now` is the best available answer.
 */
export function resolvedAtForClose(
  wasAlreadyTerminal: boolean,
  existingResolvedAt: string | null | undefined,
  now: string
): string {
  return wasAlreadyTerminal && existingResolvedAt ? existingResolvedAt : now;
}

/**
 * Participants that still need a `request_resolved` activity row, in a stable order.
 *
 * `student_help_activity` has no uniqueness constraint on
 * (help_request_id, student_profile_id, activity_type), so the caller has to decide what
 * is missing rather than relying on an upsert. Doing it as a set difference — instead of
 * skipping the write whenever the request is already terminal — is what makes a failed
 * write retryable: a rerun fills in only the gaps, so `--force` neither duplicates rows
 * nor leaves a permanent hole in the per-student history.
 *
 * Duplicates within `participants` collapse, so one call cannot write two rows for the
 * same student.
 */
export function participantsNeedingActivity(
  participants: Array<string | null | undefined>,
  alreadyLogged: Array<string | null | undefined>
): string[] {
  const logged = new Set(alreadyLogged.filter((id): id is string => !!id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of participants) {
    if (!id || logged.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
