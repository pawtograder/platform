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

/**
 * The instant a lab meeting ends, as a wall-clock time in the course's time zone.
 * `endTime` is a Postgres `time` ("HH:MM:SS") or an `<input type="time">` value ("HH:MM").
 */
export function labMeetingEndTimestamp(
  meetingDate: string,
  endTime: string | null | undefined,
  timeZone: string
): Date {
  const [year, month, day] = meetingDate.split("-").map(Number);
  const [hours = 0, minutes = 0, seconds = 0] = (endTime || DEFAULT_LAB_END_TIME).split(":").map(Number);
  // Numeric components, not a string -- see trap 2 above. Seconds are passed explicitly because
  // the default end time is 23:59:59 and the five-argument form would silently truncate to
  // 23:59:00.
  return new TZDate(year, month - 1, day, hours, minutes, Math.trunc(seconds), timeZone);
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
