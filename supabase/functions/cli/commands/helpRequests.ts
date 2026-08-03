/**
 * help_requests.* CLI commands — help_requests.list (cli:read),
 * help_requests.close (cli:write).
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { classSummary, resolveClass } from "../utils/resolvers.ts";
import { UUID_IN_BATCH_SIZE } from "../utils/paging.ts";
import { assertUserCanAccessClass, assertUserIsClassInstructor, getCallerPrivateProfileId } from "../utils/auth.ts";
import {
  HELP_REQUEST_RESOLUTION_STATUSES,
  TERMINAL_HELP_REQUEST_STATUSES,
  parseStatusFilter
} from "../utils/helpRequestStatus.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse } from "../types.ts";

type HelpRequestStatus = Database["public"]["Enums"]["help_request_status"];
type HelpRequestResolutionStatus = Database["public"]["Enums"]["help_request_resolution_status"];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface HelpRequestsListParams {
  class?: string | number;
  status?: string;
  queue?: string | number;
  limit?: number;
  /** Rows to skip. Pass `next_offset` from a truncated page to continue. */
  offset?: number;
}

interface HelpRequestsCloseParams {
  id?: number;
  status?: string;
  resolution_status?: string;
  notes?: string;
  force?: boolean;
}

/** Batched private-profile-id → display name lookup. */
async function fetchProfileNames(
  supabase: ReturnType<typeof getAdminClient>,
  ids: Array<string | null>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return names;

  // profiles.id is a UUID, so this is bounded by URL length, not max_rows.
  const BATCH = UUID_IN_BATCH_SIZE;
  for (let i = 0; i < unique.length; i += BATCH) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", unique.slice(i, i + BATCH));
    if (error) throw new CLICommandError(`Failed to resolve profile names: ${error.message}`, 500);
    for (const row of data ?? []) {
      if (row.name) names.set(row.id, row.name);
    }
  }
  return names;
}

async function handleHelpRequestsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as HelpRequestsListParams;
  if (!p.class) throw new CLICommandError("class is required");

  const statusFilter = parseStatusFilter(p.status);
  if ("error" in statusFilter) throw new CLICommandError(statusFilter.error, 400);
  const statuses = statusFilter.statuses;

  const limit = p.limit === undefined || p.limit === null ? DEFAULT_LIMIT : Math.floor(Number(p.limit));
  if (!Number.isFinite(limit) || limit < 1) {
    throw new CLICommandError("limit must be a positive integer", 400);
  }
  // Capped per page rather than overall: a queue with more than MAX_LIMIT requests
  // matching one status is normal on a long-running course, and narrowing --status or
  // --queue cannot reach the older ones. `--offset` walks past the cap instead.
  if (limit > MAX_LIMIT) {
    throw new CLICommandError(
      `limit must be ${MAX_LIMIT} or less (got ${limit}); it is the page size, not a total. ` +
        "Pass --offset (or the next_offset from a truncated page) to read further.",
      400
    );
  }

  const offset = p.offset === undefined || p.offset === null ? 0 : Math.floor(Number(p.offset));
  if (!Number.isFinite(offset) || offset < 0) {
    throw new CLICommandError("offset must be zero or a positive integer", 400);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  let queueId: number | null = null;
  if (p.queue !== undefined && p.queue !== null && String(p.queue).trim() !== "") {
    const raw = String(p.queue).trim();
    const { data: queues, error: queueError } = await supabase
      .from("help_queues")
      .select("id, name")
      .eq("class_id", classData.id);
    if (queueError) throw new CLICommandError(`Failed to list help queues: ${queueError.message}`, 500);

    const available = (queues ?? []).map((q) => `${q.id} (${q.name})`).join(", ") || "none";

    if (/^\d+$/.test(raw)) {
      const match = (queues ?? []).find((q) => q.id === Number(raw));
      if (!match) throw new CLICommandError(`Help queue not found: ${raw}. Available: ${available}`, 404);
      queueId = match.id;
    } else {
      // Nothing stops a class having two queues whose names differ only by case,
      // and the query has no ordering, so picking the first match would filter an
      // unpredictable queue. Make the caller disambiguate by id instead.
      const matches = (queues ?? []).filter((q) => q.name.toLowerCase() === raw.toLowerCase());
      if (matches.length === 0) {
        throw new CLICommandError(`Help queue not found: ${raw}. Available: ${available}`, 404);
      }
      if (matches.length > 1) {
        throw new CLICommandError(
          `Multiple help queues in this class are named "${raw}": ${matches.map((q) => q.id).join(", ")}. ` +
            "Pass the queue id instead.",
          400
        );
      }
      queueId = matches[0]!.id;
    }
  }

  let query = supabase
    .from("help_requests")
    .select(
      "id, class_id, help_queue, created_by, assignee, request, status, is_private, is_video_live, " +
        "location_type, referenced_submission_id, followup_to, resolution_status, resolution_notes, " +
        "resolved_at, resolved_by, created_at, updated_at, help_queues!inner(name)"
    )
    .eq("class_id", classData.id)
    // Tie-broken by id: `created_at` alone is not a total order — two requests created
    // in the same instant could swap between pages, so a row could be seen twice or
    // skipped entirely while paging.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (statuses) query = query.in("status", statuses);
  if (queueId !== null) query = query.eq("help_queue", queueId);

  const { data, error } = await query;
  if (error) throw new CLICommandError(`Failed to list help requests: ${error.message}`, 500);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { help_queues?: { name: string } | null }>;

  const names = await fetchProfileNames(supabase, [
    ...rows.map((r) => (r.created_by as string | null) ?? null),
    ...rows.map((r) => (r.assignee as string | null) ?? null),
    ...rows.map((r) => (r.resolved_by as string | null) ?? null)
  ]);

  const requests = rows.map((r) => ({
    id: r.id,
    queue_id: r.help_queue,
    queue_name: r.help_queues?.name ?? null,
    status: r.status,
    request: r.request,
    is_private: r.is_private,
    is_video_live: r.is_video_live,
    location_type: r.location_type,
    referenced_submission_id: r.referenced_submission_id,
    followup_to: r.followup_to,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    created_by_name: r.created_by ? (names.get(r.created_by as string) ?? null) : null,
    assignee: r.assignee,
    assignee_name: r.assignee ? (names.get(r.assignee as string) ?? null) : null,
    resolved_at: r.resolved_at,
    resolved_by: r.resolved_by,
    resolved_by_name: r.resolved_by ? (names.get(r.resolved_by as string) ?? null) : null,
    resolution_status: r.resolution_status,
    resolution_notes: r.resolution_notes
  }));

  const byStatus: Record<string, number> = {};
  for (const r of requests) {
    const key = String(r.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return {
    success: true,
    data: {
      class: classSummary(classData),
      requests,
      summary: {
        total: requests.length,
        by_status: byStatus,
        offset,
        truncated: requests.length >= limit,
        /** Pass as --offset to continue past a truncated page. */
        next_offset: requests.length >= limit ? offset + requests.length : null
      }
    }
  };
}

/**
 * help_requests.close — moves a request to `closed` (or `resolved`) the same way
 * the staff path in the office-hours UI does: a plain UPDATE setting the status
 * and resolution columns.
 *
 * A direct UPDATE is the correct mechanism rather than a bespoke RPC, because
 * every side effect is trigger-driven and fires for this write too: the realtime
 * broadcasts and status-change notification (`broadcast_help_requests_change`,
 * `help_request_updated_trigger`), the Discord notification
 * (`trg_discord_help_request_notification`), closing open work sessions
 * (`help_request_work_sessions_trigger`), and the resolution system message
 * (`help_requests_resolution_message_tr`, which needs `resolution_status` and
 * `resolved_by` to be set to produce its message).
 *
 * Not covered by any trigger: tearing down a live video call. `is_video_live`
 * stays true and the Chime meeting stays up, so we report it back and let the
 * CLI warn rather than silently leaving the operator with a live call.
 */
async function handleHelpRequestsClose(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as HelpRequestsCloseParams;
  // Not floored: this command is destructive, yargs happily accepts `--id 123.4`
  // for a numeric option, and silently truncating would close a different
  // request than the caller named.
  const id = p.id === undefined || p.id === null ? NaN : Number(p.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new CLICommandError(`id must be a positive integer (got ${String(p.id)})`, 400);
  }

  const targetStatus = (p.status ?? "closed") as HelpRequestStatus;
  if (!TERMINAL_HELP_REQUEST_STATUSES.includes(targetStatus)) {
    throw new CLICommandError(`status must be one of ${TERMINAL_HELP_REQUEST_STATUSES.join(", ")}`, 400);
  }

  let resolutionStatus: HelpRequestResolutionStatus | null = null;
  if (p.resolution_status !== undefined && p.resolution_status !== null && p.resolution_status !== "") {
    if (!(HELP_REQUEST_RESOLUTION_STATUSES as string[]).includes(p.resolution_status)) {
      throw new CLICommandError(
        `Invalid resolution status: ${p.resolution_status}. Must be one of ${HELP_REQUEST_RESOLUTION_STATUSES.join(", ")}`,
        400
      );
    }
    resolutionStatus = p.resolution_status as HelpRequestResolutionStatus;
  }

  const supabase = getAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from("help_requests")
    .select("id, class_id, status, is_video_live, resolved_at")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new CLICommandError(`Failed to load help request: ${fetchError.message}`, 500);
  if (!existing) throw new CLICommandError(`Help request not found: ${id}`, 404);

  // Authorization is keyed on the request's own class, so a token scoped to one
  // class cannot close another class's requests.
  //
  // A 403 here would be its own disclosure: paired with the 404 above it tells
  // the caller that the id exists in some class they cannot see. Both cases
  // answer identically.
  try {
    await assertUserIsClassInstructor(supabase, ctx.userId, existing.class_id);
  } catch (err) {
    if (err instanceof CLICommandError && err.status === 403) {
      throw new CLICommandError(`Help request not found: ${id}`, 404);
    }
    throw err;
  }

  // Refused rather than warned after the fact: video-call-controls disables both
  // Join and End Call once the request is resolved/closed, so closing first
  // strands the Chime meeting with no way to end it from the UI. Ending the call
  // while the request is still open is possible, so that is what we ask for.
  if (existing.is_video_live === true && p.force !== true) {
    throw new CLICommandError(
      `Help request ${id} has a live video call. End the call from the office-hours page first — ` +
        "once the request is closed, the End Call button is disabled and the meeting cannot be torn down. " +
        "Pass force to close anyway and leave the meeting running.",
      409
    );
  }

  if (TERMINAL_HELP_REQUEST_STATUSES.includes(existing.status) && p.force !== true) {
    throw new CLICommandError(
      `Help request ${id} is already ${existing.status}. Pass force to overwrite its resolution.`,
      409
    );
  }

  const resolvedBy = await getCallerPrivateProfileId(supabase, ctx.userId, existing.class_id);

  const update: Database["public"]["Tables"]["help_requests"]["Update"] = {
    status: targetStatus,
    resolved_by: resolvedBy,
    resolved_at: new Date().toISOString()
  };
  if (resolutionStatus) update.resolution_status = resolutionStatus;
  if (p.notes !== undefined) update.resolution_notes = p.notes ?? null;

  // Conditional on the status we observed above. Without this, a concurrent
  // resolve from the office-hours UI (or another operator) between the read and
  // the write would be silently overwritten, including its resolved_by and
  // resolved_at, even though the caller did not pass force.
  let closeQuery = supabase.from("help_requests").update(update).eq("id", id).eq("status", existing.status);

  // Also predicated on the call state for a non-force close. The is_video_live
  // check above is a read, and staff can start a call between that read and this
  // write (video-call-controls updates the flag independently); the status
  // predicate alone would let the close through and strand the meeting, since
  // both Join and End Call are disabled once the request is terminal.
  if (p.force !== true) {
    closeQuery = closeQuery.eq("is_video_live", false);
  }

  const { data: updated, error: updateError } = await closeQuery
    .select(
      "id, class_id, help_queue, status, resolved_at, resolved_by, resolution_status, resolution_notes, is_video_live"
    )
    .maybeSingle();

  if (updateError) throw new CLICommandError(`Failed to close help request: ${updateError.message}`, 500);
  if (!updated) {
    // Either the status moved or a call started; re-read so the message says
    // which, rather than making the operator guess.
    const { data: current } = await supabase
      .from("help_requests")
      .select("status, is_video_live")
      .eq("id", id)
      .maybeSingle();

    const reason =
      current?.is_video_live === true
        ? "a video call is now live on it"
        : `its status is now ${current?.status ?? "unknown"} (it was ${existing.status})`;
    throw new CLICommandError(
      `Help request ${id} changed while this command was running: ${reason}. Re-run to see its current state.`,
      409
    );
  }

  // The staff UI writes one student_help_activity row per participant after
  // resolving, and no trigger does it. Without this, CLI-resolved requests
  // vanish from per-student help histories and the analytics built on them.
  // Best-effort, matching the UI, which does not block resolution on it.
  let activityLogged = 0;
  try {
    const { data: participants } = await supabase
      .from("help_request_students")
      .select("profile_id")
      .eq("help_request_id", id);

    const rows = (participants ?? []).map((participant) => ({
      student_profile_id: participant.profile_id,
      class_id: existing.class_id,
      help_request_id: id,
      activity_type: "request_resolved" as const,
      activity_description: `Request ${targetStatus} by instructor via CLI`
    }));

    if (rows.length > 0) {
      const { error: activityError } = await supabase.from("student_help_activity").insert(rows);
      if (!activityError) activityLogged = rows.length;
    }
  } catch {
    // Activity logging is not worth failing an otherwise successful close over.
  }

  return {
    success: true,
    data: {
      request: updated,
      previous_status: existing.status,
      activity_logged: activityLogged,
      /**
       * True when a Chime call is still up; no trigger tears it down. Read from
       * the updated row, not the pre-update one: a call that ended between the
       * read and the write would otherwise be reported as still running.
       */
      video_still_live: updated.is_video_live === true
    }
  };
}

registerCommand({
  name: "help_requests.list",
  requiredScope: "cli:read",
  handler: handleHelpRequestsList
});

registerCommand({
  name: "help_requests.close",
  requiredScope: "cli:write",
  handler: handleHelpRequestsClose
});
