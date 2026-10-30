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
 * Time spent waiting in line, summed across pickups. The ticket enters the line when it is
 * created, after each escalation, and whenever a work session ends with the ticket going straight
 * back to the queue (Stop helping, or a reassignment). Each wait ends at the next work session
 * start. A session that ends in Resolve is not a wait unless the student then escalates, and the
 * escalation, not the Resolve, starts that wait: the check-in window is not time in line.
 */
export function totalQueueWaitMs(
  request: { created_at: string; status: string },
  workSessions: { started_at: string; ended_at?: string | null }[],
  escalations: { created_at: string }[],
  now: number = Date.now()
): number {
  const time = (t: string) => new Date(t).getTime();
  const sessions = workSessions
    .map((s) => ({ start: time(s.started_at), end: s.ended_at ? time(s.ended_at) : null }))
    .sort((a, b) => a.start - b.start);
  const escalatedAt = escalations.map((e) => time(e.created_at)).sort((a, b) => a - b);

  const waitStarts = [time(request.created_at), ...escalatedAt];
  sessions.forEach((session, i) => {
    if (session.end === null) return;
    const end = session.end;
    const nextStart = sessions[i + 1]?.start ?? null;
    const escalatedBeforeNextPickup = escalatedAt.some((t) => t >= end && (nextStart === null || t <= nextStart));
    if (escalatedBeforeNextPickup) return;
    const isLastAndBackInLine = nextStart === null && request.status === "open";
    if (nextStart !== null || isLastAndBackInLine) waitStarts.push(end);
  });
  waitStarts.sort((a, b) => a - b);

  const starts = sessions.map((s) => s.start);
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
