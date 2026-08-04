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

/**
 * `YYYY-MM-DDTHH:MM(:SS(.mmm)?)?` with no trailing offset or `Z`.
 *
 * Fractional seconds are matched because the client will forward them
 * (`cli/utils/schedule.ts` accepts `.\d+`); without this they fell through to
 * `new Date(raw)` and were read as UTC rather than in the class's zone.
 */
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/** Ends in `Z` or `±HH:MM` / `±HHMM`. */
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

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
 * offset. The first pass gets within an hour, the second lands exactly — except on
 * a wall-clock time that does not exist, the spring-forward gap.
 *
 * There the second pass lands *before* the gap, because it subtracts the
 * post-transition offset from a target that only exists pre-transition. For a
 * midday deadline that is merely an hour off, but zones whose jump is at midnight
 * (`America/Havana` 2026-03-08, `America/Santiago` 2026-09-06) put 00:00 inside the
 * gap, so a `start-of-day` release date landed at 23:00 on the *previous day* — an
 * assignment named for the 8th became visible on the 7th, which is exactly the
 * off-by-one-day this module exists to prevent.
 *
 * So we detect the gap by round-tripping and, when the requested wall clock does
 * not exist, shift forward past it instead of back. That matches `Temporal`'s
 * `disambiguation: "compatible"`, `java.time`, and the `TZDate` the web flow uses.
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
  const firstCandidate = target - zoneOffsetMs(new Date(target), timeZone);
  const secondCandidate = target - zoneOffsetMs(new Date(firstCandidate), timeZone);
  const instant = new Date(secondCandidate);

  // Round-trip check. `zoneOffsetMs` is defined so that `instant + offset(instant)`
  // is the wall clock `instant` actually reads as, so when that is not the requested
  // `target` the wall clock does not exist in this zone.
  if (instant.getTime() + zoneOffsetMs(instant, timeZone) === target) return instant;

  // In the gap. Both candidates sit on opposite sides of it; the later one is the
  // first instant *after* the jump, which is what `Temporal`'s `compatible`
  // disambiguation, `java.time`, and the web flow's `TZDate` all pick. Taking the
  // second candidate unconditionally moved the deadline to the wrong side, and in a
  // zone whose jump is at midnight (`America/Havana` 2026-03-08, `America/Santiago`
  // 2026-09-06) "the wrong side" is the previous calendar day — so a `start-of-day`
  // release date named for the 8th went live on the 7th. Comparing instants rather
  // than offsets keeps this right in zones east of UTC, where the offsets are
  // positive and the arithmetic runs the other way (`Africa/Cairo` 2026-04-24).
  return new Date(Math.max(firstCandidate, secondCandidate));
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
 * Rejects an out-of-range wall clock such as `25:00` or `12:60`.
 *
 * The date-time pattern matches any two digits per field, and `Date.UTC` rolls a
 * too-large field into the next hour or day rather than failing — so `2026-09-15T25:00`
 * became the 16th at 01:00 and a deadline was stored that nobody asked for. Leap
 * seconds are not accepted (`60` seconds), matching `Date`.
 */
function assertRealWallClock(hour: number, minute: number, second: number, ms: number, raw: string): void {
  if (hour > 23 || minute > 59 || second > 59 || ms > 999) {
    throw new ZonedDateError(`Invalid time of day in ${raw}. Hours are 00-23, minutes and seconds 00-59.`);
  }
}

/**
 * Which end of the day a bare `YYYY-MM-DD` means.
 *
 * A deadline reads as "by the end of the 15th"; a release date reads as "from the
 * start of the 15th". Using the deadline convention for a release would keep the
 * assignment hidden for almost the whole day the operator named.
 */
export type DateOnlyBoundary = "end-of-day" | "start-of-day";

/**
 * Resolves a caller-supplied date to an ISO instant, interpreting bare dates and
 * offset-less times in `timeZone`.
 *
 * - `YYYY-MM-DD` maps to the boundary given by `dateOnly`.
 * - `YYYY-MM-DDTHH:MM[:SS[.mmm]]` with no offset is that wall-clock time in `timeZone`.
 * - Anything carrying its own offset or `Z` is respected as written.
 *
 * `timeZone` falls back to UTC when a class has none recorded.
 */
export function resolveZonedTimestamp(
  input: string,
  timeZone: string | null | undefined,
  dateOnly: DateOnlyBoundary
): string {
  const raw = input.trim();
  if (raw === "") throw new ZonedDateError("date is empty");

  const zone = timeZone && timeZone.trim() !== "" ? timeZone : "UTC";

  // Reject an unknown zone up front rather than silently falling back, which
  // would put every deadline in the wrong place.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ZonedDateError(`Unknown time zone for this class: ${zone}`);
  }

  const dateOnlyMatch = raw.match(DATE_ONLY_RE);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    assertRealCalendarDate(Number(y), Number(m), Number(d), raw);
    const instant =
      dateOnly === "start-of-day"
        ? utcFromWallClock(Number(y), Number(m), Number(d), 0, 0, 0, 0, zone)
        : utcFromWallClock(Number(y), Number(m), Number(d), 23, 59, 59, 999, zone);
    if (Number.isNaN(instant.getTime())) throw new ZonedDateError(`Invalid date: ${raw}`);
    return instant.toISOString();
  }

  const localDateTime = raw.match(LOCAL_DATE_TIME_RE);
  if (localDateTime) {
    const [, y, m, d, hh, mm, ss, frac] = localDateTime;
    assertRealCalendarDate(Number(y), Number(m), Number(d), raw);
    const second = ss === undefined ? 0 : Number(ss);
    // "5" means 500ms, not 5ms — pad before parsing.
    const ms = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
    assertRealWallClock(Number(hh), Number(mm), second, ms, raw);
    const instant = utcFromWallClock(Number(y), Number(m), Number(d), Number(hh), Number(mm), second, ms, zone);
    if (Number.isNaN(instant.getTime())) throw new ZonedDateError(`Invalid date: ${raw}`);
    return instant.toISOString();
  }

  // Only trust Date for input that states its own offset. ECMAScript reads an
  // offset-less date-time as *local* time, and the Edge runtime's local zone is
  // UTC — so anything that reached here without an offset would be silently
  // shifted out of the class's zone, which is the failure this module exists to
  // prevent. Rejecting also keeps formats like `09/15/2026` from being read in
  // the wrong zone.
  if (!HAS_OFFSET_RE.test(raw)) {
    throw new ZonedDateError(
      `Could not parse date: ${raw}. Use YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS[.mmm]], ` +
        "or a timestamp with an explicit offset such as 2026-09-15T17:00:00-04:00."
    );
  }

  // Validate the calendar date before handing it to Date. V8 normalizes an
  // impossible date rather than rejecting it, so `2026-02-30T17:00:00-05:00`
  // silently becomes March 2 — the bare and offset-less forms are checked by
  // assertRealCalendarDate, and this branch has to be too.
  const offsetDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (offsetDate) {
    assertRealCalendarDate(Number(offsetDate[1]), Number(offsetDate[2]), Number(offsetDate[3]), raw);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ZonedDateError(
      `Could not parse date: ${raw}. Use YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS[.mmm]], ` +
        "or a timestamp with an explicit offset."
    );
  }
  return parsed.toISOString();
}

/**
 * A grading deadline. Bare dates mean the end of that day in the class's zone.
 */
export function resolveDueDate(input: string, timeZone: string | null | undefined): string {
  return resolveZonedTimestamp(input, timeZone, "end-of-day");
}

/**
 * A release date. Bare dates mean the start of that day, so an assignment
 * released "on the 15th" is available for all of the 15th.
 */
export function resolveReleaseDate(input: string, timeZone: string | null | undefined): string {
  return resolveZonedTimestamp(input, timeZone, "start-of-day");
}
