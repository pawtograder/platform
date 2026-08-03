/**
 * Interpreting caller-supplied dates in a class's time zone.
 *
 * `new Date("2026-09-15")` parses as midnight **UTC**, so a deadline entered as a
 * bare date lands on the evening of the 14th for a course in `America/New_York`.
 * The web bulk-assign flow avoids this by constructing the timestamp with
 * `TZDate(dueDate, course.time_zone)`; this is the equivalent for the CLI, done
 * with `Intl` rather than a date library so it works unchanged in the Edge
 * runtime.
 *
 * Dependency-free and pure, so it is unit tested directly.
 */

/** `YYYY-MM-DD` with nothing after it. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DDTHH:MM(:SS)?` with no trailing offset or `Z`. */
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Milliseconds to add to a "wall clock read as UTC" value to get the real UTC
 * instant, for the given zone at the given instant.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }

  // Intl renders midnight as hour 24 in some engines; normalize it.
  const hour = parts.hour === 24 ? 0 : parts.hour;

  // Intl has no millisecond field, so carry the instant's own milliseconds
  // across; without this the offset is short by up to 999ms and a 23:59:59.999
  // deadline rolls into the next day.
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
    instant.getUTCMilliseconds()
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * The UTC instant at which the given wall-clock time occurs in `timeZone`.
 *
 * Two passes: the offset depends on the instant, and the instant depends on the
 * offset. The first pass gets within an hour, the second lands exactly except on
 * a wall-clock time that does not exist (the spring-forward gap), where it
 * settles on a stable adjacent instant rather than throwing — a grading deadline
 * does not warrant failing the command over an hour that the calendar skipped.
 */
function utcFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let instant = new Date(target - zoneOffsetMs(new Date(target), timeZone));
  instant = new Date(target - zoneOffsetMs(instant, timeZone));
  return instant;
}

export class ZonedDateError extends Error {}

/**
 * Rejects dates that do not exist. `Date.UTC` rolls over silently — Feb 30
 * becomes Mar 2 — which would accept a typo and set a deadline two days late.
 */
function assertRealCalendarDate(year: number, month: number, day: number, raw: string): void {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ZonedDateError(`Invalid date: ${raw}`);
  }
}

/**
 * Resolves a caller-supplied due date to an ISO instant.
 *
 * - `YYYY-MM-DD` is taken as the **end** of that day in `timeZone`
 *   (23:59:59.999). "Due September 15" reads as "by the end of the 15th", and
 *   erring later is the safer direction for a deadline.
 * - `YYYY-MM-DDTHH:MM[:SS]` with no offset is that wall-clock time in `timeZone`.
 * - Anything carrying its own offset or `Z` is respected as written.
 *
 * `timeZone` falls back to UTC when a class has none recorded.
 */
export function resolveDueDate(input: string, timeZone: string | null | undefined): string {
  const raw = input.trim();
  if (raw === "") throw new ZonedDateError("due date is empty");

  const zone = timeZone && timeZone.trim() !== "" ? timeZone : "UTC";

  // Reject an unknown zone up front rather than silently falling back, which
  // would put every deadline in the wrong place.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ZonedDateError(`Unknown time zone for this class: ${zone}`);
  }

  const dateOnly = raw.match(DATE_ONLY_RE);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    assertRealCalendarDate(Number(y), Number(m), Number(d), raw);
    const instant = utcFromWallClock(Number(y), Number(m), Number(d), 23, 59, 59, 999, zone);
    if (Number.isNaN(instant.getTime())) throw new ZonedDateError(`Invalid date: ${raw}`);
    return instant.toISOString();
  }

  const localDateTime = raw.match(LOCAL_DATE_TIME_RE);
  if (localDateTime) {
    const [, y, m, d, hh, mm, ss] = localDateTime;
    assertRealCalendarDate(Number(y), Number(m), Number(d), raw);
    const instant = utcFromWallClock(
      Number(y),
      Number(m),
      Number(d),
      Number(hh),
      Number(mm),
      ss === undefined ? 0 : Number(ss),
      0,
      zone
    );
    if (Number.isNaN(instant.getTime())) throw new ZonedDateError(`Invalid date: ${raw}`);
    return instant.toISOString();
  }

  // Has an explicit offset or Z, or some other format Date understands.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ZonedDateError(
      `Could not parse due date: ${raw}. Use YYYY-MM-DD, YYYY-MM-DDTHH:MM, or a timestamp with an offset.`
    );
  }
  return parsed.toISOString();
}
