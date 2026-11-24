import type { Database } from "@/utils/supabase/SupabaseTypes";

type HelpQueue = Pick<Database["public"]["Tables"]["help_queues"]["Row"], "id" | "name" | "is_active">;
type HelpRequest = Pick<Database["public"]["Tables"]["help_requests"]["Row"], "help_queue" | "status" | "created_at">;
type HelpQueueAssignment = Pick<
  Database["public"]["Tables"]["help_queue_assignments"]["Row"],
  "help_queue_id" | "ended_at"
>;

export type QueueHealth = {
  queue_id: number;
  queue_name: string;
  waiting: number;
  oldest_wait_seconds: number;
  helping: number;
  staffed_tas: number;
  unstaffed_seconds: number | null;
};

/**
 * Health numbers for every active queue, keyed by queue id, from the rows the office-hours
 * TableControllers already hold. Inactive queues are left out, so they get no card, no badge and
 * no alert.
 *
 * "Staffed" means a shift with no ended_at, not one flagged is_active. A queue with nobody on
 * shift reports how long ago its last shift ended, or null if it never had one.
 */
export function computeQueueHealth(
  queues: readonly HelpQueue[],
  requests: readonly HelpRequest[],
  assignments: readonly HelpQueueAssignment[],
  nowMs: number
): Record<number, QueueHealth> {
  const byQueue: Record<number, QueueHealth> = {};
  const oldestOpen = new Map<number, number>();
  const lastShiftEnd = new Map<number, number>();
  for (const q of queues) {
    if (!q.is_active) continue;
    byQueue[q.id] = {
      queue_id: q.id,
      queue_name: q.name,
      waiting: 0,
      oldest_wait_seconds: 0,
      helping: 0,
      staffed_tas: 0,
      unstaffed_seconds: null
    };
  }
  for (const r of requests) {
    const h = byQueue[r.help_queue];
    if (!h) continue;
    if (r.status === "open") {
      h.waiting++;
      const created = Date.parse(r.created_at);
      const prev = oldestOpen.get(r.help_queue);
      if (prev === undefined || created < prev) oldestOpen.set(r.help_queue, created);
    } else if (r.status === "in_progress") {
      h.helping++;
    }
  }
  for (const a of assignments) {
    const h = byQueue[a.help_queue_id];
    if (!h) continue;
    if (a.ended_at === null) {
      h.staffed_tas++;
    } else {
      const ended = Date.parse(a.ended_at);
      const prev = lastShiftEnd.get(a.help_queue_id);
      if (prev === undefined || ended > prev) lastShiftEnd.set(a.help_queue_id, ended);
    }
  }
  for (const h of Object.values(byQueue)) {
    const oldest = oldestOpen.get(h.queue_id);
    if (oldest !== undefined) h.oldest_wait_seconds = Math.max(0, Math.floor((nowMs - oldest) / 1000));
    const ended = lastShiftEnd.get(h.queue_id);
    if (h.staffed_tas === 0 && ended !== undefined)
      h.unstaffed_seconds = Math.max(0, Math.floor((nowMs - ended) / 1000));
  }
  return byQueue;
}
