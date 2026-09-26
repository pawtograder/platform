import { TZDate } from "@date-fns/tz";
import { addMinutes } from "date-fns";

/**
 * The single client-side implementation of the lab-based due date rule.
 *
 * This mirrors `public.calculate_effective_due_date` (see
 * `supabase/migrations/20260825140000_audit_findings_2026_08.sql`):
 * take the most recent non-cancelled meeting of the student's lab section whose END has already
 * passed by the assignment's original deadline, and add `minutes_due_after_lab` to that end.
 *
 * There used to be three hand-rolled copies of this rule -- `useAssignmentDueDate`,
 * `CourseController.calculateEffectiveDueDate`, and the assignment form's Lab Section Due Date
 * Preview -- and all three disagreed with the database and with each other. Two separate defects
 * came out of that, so the rule lives here now and the call sites delegate.
 *
 * Two traps this module exists to contain:
 *
 *  1. The meeting filter has to compare the meeting's *end timestamp in the course time zone* to
 *     the deadline. Comparing the meeting's calendar date instead (either as a date-only
 *     `new Date("2026-10-19")`, which is midnight UTC, or as a `YYYY-MM-DD` string) picks a
 *     different meeting whenever the deadline falls on a meeting day: the date-only forms cannot
 *     see whether the lab ends before or after the deadline that day.
 *
 *  2. `new TZDate("2026-10-12T23:59:59", "America/New_York")` does NOT mean "23:59:59 in New
 *     York" -- a timezone-less ISO string is parsed as UTC and then *rendered* in the target
 *     zone, landing on 19:59:59 EDT. Only the numeric-component form,
 *     `new TZDate(year, monthIndex, day, hours, minutes, seconds, timeZone)`, means what it
 *     looks like. Do not "simplify" this back to the string form.
 *
 *  3. A wall clock inside a DST fall-back is ambiguous, and TZDate and Postgres pick different
 *     instants: measured for `2026-11-01 01:30` in America/New_York, TZDate returns 05:30Z (the
 *     first, daylight occurrence) and `timestamp AT TIME ZONE` returns 06:30Z (the second,
 *     standard one). `labMeetingEndTimestamp` corrects for this; see the note there.
 */

/**
 * A lab section with no recorded end time is treated as ending at the end of its meeting day.
 * `lab_sections.end_time` is nullable: the lab-section form used to leave it optional, and SIS
 * import still writes NULL whenever a section's `meeting_times` does not parse. The same default
 * is applied by `calculate_effective_due_date`, so all surfaces agree.
 */
export const DEFAULT_LAB_END_TIME = "23:59:59";

export type LabMeetingLike = {
  meeting_date: string;
  cancelled?: boolean | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds east of UTC in `timeZone` at `instant`. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  // getTimezoneOffset() follows the JS convention (minutes WEST of UTC), so negate it.
  return -new TZDate(instant, timeZone).getTimezoneOffset() * 60_000;
}

/** The local wall clock at `instant`, as a comparable key. */
function wallClockKey(instant: number, timeZone: string): string {
  const d = new TZDate(instant, timeZone);
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(":");
}

/**
 * The instant a lab meeting ends, as a wall-clock time in the course's time zone.
 * `endTime` is a Postgres `time` ("HH:MM:SS") or an `<input type="time">` value ("HH:MM").
 *
 * Resolves DST edges the way `timestamp AT TIME ZONE` does, which is not the way TZDate does:
 *
 *   - Ambiguous wall clock (fall-back, the hour that repeats): Postgres takes the LATER,
 *     standard-time instant. Measured: `2026-11-01 01:30` in America/New_York is 06:30Z in
 *     Postgres but 05:30Z from TZDate; `2026-04-04 23:59:59` in America/Santiago is 03:59:59Z in
 *     Postgres but 02:59:59Z from TZDate.
 *   - Nonexistent wall clock (spring-forward, the hour that is skipped): Postgres uses the
 *     pre-transition offset, which shifts the result forward past the gap. TZDate already agrees
 *     here -- `2026-03-08 02:30` in America/New_York is 07:30Z on both sides -- so this branch
 *     changes nothing, but it is derived rather than assumed.
 *
 * How reachable is the ambiguous case? For America/New_York -- the only time zone in the database
 * and the app's hardcoded fallback -- the repeated hour is 01:00-01:59:59, so the 23:59:59 default
 * never lands in it and you would need a lab whose explicit `end_time` falls between 01:00 and
 * 02:00 on the one fall-back Sunday a year. That is effectively unreachable. It is a real case for
 * zones that fall back at midnight, though: `classes.time_zone` is free text, and in
 * America/Santiago local 23:00-23:59:59 repeats, which is exactly where the 23:59:59 default sits.
 * The fix is here because this module's whole contract is parity with the database -- a silent
 * one-hour disagreement between the deadline a student is shown and the one enforcement applies is
 * the class of bug this file exists to prevent -- not because the scenario is common.
 */
export function labMeetingEndTimestamp(
  meetingDate: string,
  endTime: string | null | undefined,
  timeZone: string
): Date {
  const [year, month, day] = meetingDate.split("-").map(Number);
  const [hours = 0, minutes = 0, seconds = 0] = (endTime || DEFAULT_LAB_END_TIME).split(":").map(Number);

  // Treat the wall clock as if it were UTC, then subtract the offset actually in force. Both
  // candidate offsets are sampled (a day either side, which brackets any single transition
  // without ever spanning two), because on a transition day the offset before and after differ
  // and only one of them -- or, in the fall-back case, both -- reproduces the requested wall
  // clock. Deliberately not `new TZDate(y, m, d, ...)`: that constructor resolves the fall-back
  // ambiguity to the first occurrence, and Postgres resolves it to the second. See trap 3.
  const naive = Date.UTC(year, month - 1, day, hours, minutes, Math.trunc(seconds));
  const requested = [year, month - 1, day, hours, minutes, Math.trunc(seconds)].join(":");
  const candidates = Array.from(
    new Set([naive - zoneOffsetMs(naive - DAY_MS, timeZone), naive - zoneOffsetMs(naive + DAY_MS, timeZone)])
  );

  // Candidates that round-trip to the wall clock we asked for. There are two during a fall-back
  // (take the later, as Postgres does), one normally, and none inside a spring-forward gap --
  // where the later candidate is the pre-transition reading, again matching Postgres.
  const exact = candidates.filter((instant) => wallClockKey(instant, timeZone) === requested);
  return new TZDate(Math.max(...(exact.length > 0 ? exact : candidates)), timeZone);
}

/**
 * The most recent non-cancelled meeting that has already ENDED by `assignmentDueDate`, or null.
 * Callers fall back to the assignment's plain due date when this returns null, matching the
 * `IF most_recent_lab_meeting_date IS NULL THEN RETURN assignment_record.due_date` branch in SQL.
 */
export function selectMostRecentLabMeeting<T extends LabMeetingLike>(
  meetings: T[],
  endTime: string | null | undefined,
  timeZone: string,
  assignmentDueDate: Date
): T | null {
  let best: T | null = null;
  for (const meeting of meetings) {
    if (meeting.cancelled) {
      continue;
    }
    // `<=`, not `<`: a lab that ends exactly at the deadline counts, as it does in SQL.
    if (labMeetingEndTimestamp(meeting.meeting_date, endTime, timeZone) > assignmentDueDate) {
      continue;
    }
    if (best === null || meeting.meeting_date > best.meeting_date) {
      best = meeting;
    }
  }
  return best;
}

/**
 * The lab-based effective due date, or null when no meeting qualifies.
 * Does NOT apply due-date exceptions -- that is `calculate_final_due_date`'s job server-side, and
 * `useAssignmentDueDate` adds them on top of this client-side.
 */
export function calculateLabBasedDueDate({
  meetings,
  endTime,
  timeZone,
  assignmentDueDate,
  minutesDueAfterLab
}: {
  meetings: LabMeetingLike[];
  endTime: string | null | undefined;
  timeZone: string;
  assignmentDueDate: Date;
  minutesDueAfterLab: number;
}): Date | null {
  const meeting = selectMostRecentLabMeeting(meetings, endTime, timeZone, assignmentDueDate);
  if (!meeting) {
    return null;
  }
  return addMinutes(labMeetingEndTimestamp(meeting.meeting_date, endTime, timeZone), minutesDueAfterLab);
}
