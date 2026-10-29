/**
 * Rules for office hours ticket escalation shared by the queue views.
 * The database enforces the same rules in
 * supabase/migrations/20261029120000_help_request_escalation.sql; these helpers
 * only decide what to show.
 */

export const ESCALATION_NOTE_MAX_LENGTH = 500;

type QueueOrderFields = { escalation_count: number; created_at: string };

export function isEscalated(request: Pick<QueueOrderFields, "escalation_count">): boolean {
  return request.escalation_count > 0;
}

/**
 * Queue order: escalated tickets first, then everything else. Within each group the original
 * `created_at` decides, so an escalated ticket keeps the place it earned when it first joined.
 */
export function compareHelpRequestQueueOrder(a: QueueOrderFields, b: QueueOrderFields): number {
  const escalatedDiff = Number(isEscalated(b)) - Number(isEscalated(a));
  if (escalatedDiff !== 0) return escalatedDiff;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/**
 * True while the student can still answer "Did your problem get fixed?" after staff resolved the
 * ticket. Staff "End ticket" sets the status to closed and leaves no check-in.
 */
export function isCheckInPending(
  request: { status: string; check_in_expires_at: string | null },
  now: number = Date.now()
): boolean {
  return (
    request.status === "resolved" &&
    request.check_in_expires_at !== null &&
    new Date(request.check_in_expires_at).getTime() > now
  );
}

/**
 * Time spent waiting in line, summed across pickups. The ticket starts waiting when it is
 * created and again after each escalation; each wait ends at the next work session start. Time
 * between staff Resolve and a student's escalation is not counted: the ticket was not in line.
 */
export function totalQueueWaitMs(
  request: { created_at: string; status: string },
  workSessions: { started_at: string }[],
  escalations: { created_at: string }[],
  now: number = Date.now()
): number {
  const starts = workSessions.map((s) => new Date(s.started_at).getTime()).sort((a, b) => a - b);
  const waitStarts = [request.created_at, ...escalations.map((e) => e.created_at)]
    .map((t) => new Date(t).getTime())
    .sort((a, b) => a - b);

  return waitStarts.reduce((total, waitStart, i) => {
    const nextWaitStart = waitStarts[i + 1] ?? Infinity;
    const pickup = starts.find((s) => s >= waitStart && s <= nextWaitStart);
    if (pickup !== undefined) return total + (pickup - waitStart);
    // Still waiting: only the latest wait can be open, and only while the ticket is in line.
    if (i === waitStarts.length - 1 && request.status === "open") return total + Math.max(0, now - waitStart);
    return total;
  }, 0);
}

export function formatWaitDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function isValidEscalationNote(note: string): boolean {
  const trimmed = note.trim();
  return trimmed.length > 0 && trimmed.length <= ESCALATION_NOTE_MAX_LENGTH;
}

/** Most recent escalation note per help request, for queue row previews. */
export function latestEscalationNoteByRequest(
  escalations: { help_request_id: number; note: string; created_at: string }[]
): Map<number, string> {
  const latest = new Map<number, { note: string; at: number }>();
  for (const e of escalations) {
    const at = new Date(e.created_at).getTime();
    const current = latest.get(e.help_request_id);
    if (!current || at >= current.at) latest.set(e.help_request_id, { note: e.note, at });
  }
  return new Map(Array.from(latest, ([id, { note }]) => [id, note]));
}

export function escalationBadgeLabel(escalationCount: number): string | null {
  if (escalationCount <= 0) return null;
  return escalationCount > 1 ? `Escalated ×${escalationCount}` : "Escalated";
}
