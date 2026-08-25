/**
 * Regression tests for the lab-based due date rule (lib/labDueDate.ts).
 *
 * This logic previously existed as three hand-rolled copies -- useAssignmentDueDate,
 * CourseController.calculateEffectiveDueDate and the assignment form's Lab Section Due Date
 * Preview -- which disagreed with public.calculate_effective_due_date and with each other. The
 * expected values below were measured against the database function on a local Supabase for the
 * same fixtures, so this suite is a client/DB parity check, not a restatement of the code.
 *
 * Note: TZDate overrides toISOString() to render in its own zone, so these assertions compare
 * instants (getTime) rather than formatted strings.
 *
 * All fixtures sit in October 2026, comfortably inside EDT (UTC-4), so the expectations are not
 * DST-boundary trivia.
 */
import { calculateLabBasedDueDate, labMeetingEndTimestamp, selectMostRecentLabMeeting } from "@/lib/labDueDate";

const TZ = "America/New_York";
// Exactly the meetings the database generated for these fixtures, including 2026-10-26, which
// falls after every deadline used below and must always be rejected.
const MEETINGS = [
  { meeting_date: "2026-10-05" },
  { meeting_date: "2026-10-12" },
  { meeting_date: "2026-10-19" },
  { meeting_date: "2026-10-26" }
];

describe("labMeetingEndTimestamp", () => {
  test("builds the end time as a wall clock in the course time zone, not as UTC", () => {
    // The trap: new TZDate("2026-10-12T23:59:59", tz) parses the string as UTC and renders it in
    // the zone, landing on 19:59:59 EDT -- four hours early.
    expect(labMeetingEndTimestamp("2026-10-12", "23:59:59", TZ).getTime()).toBe(Date.parse("2026-10-13T03:59:59Z"));
    expect(labMeetingEndTimestamp("2026-10-12", "16:00:00", TZ).getTime()).toBe(Date.parse("2026-10-12T20:00:00Z"));
  });

  test("defaults a missing end time to the end of the meeting day, seconds included", () => {
    // Seconds matter: the five-argument TZDate form silently truncated 23:59:59 to 23:59:00.
    expect(labMeetingEndTimestamp("2026-10-12", null, TZ).getTime()).toBe(Date.parse("2026-10-13T03:59:59Z"));
    expect(labMeetingEndTimestamp("2026-10-12", undefined, TZ).getTime()).toBe(Date.parse("2026-10-13T03:59:59Z"));
    expect(labMeetingEndTimestamp("2026-10-12", "", TZ).getTime()).toBe(Date.parse("2026-10-13T03:59:59Z"));
  });

  test('accepts an <input type="time"> value with no seconds', () => {
    expect(labMeetingEndTimestamp("2026-10-12", "16:00", TZ).getTime()).toBe(Date.parse("2026-10-12T20:00:00Z"));
  });
});

describe("selectMostRecentLabMeeting", () => {
  // Mon 2026-10-19 12:00 EDT. The lab also meets that Monday.
  const noonOnAMeetingDay = new Date("2026-10-19T16:00:00Z");

  test("rejects a meeting that has not ended yet, even though its calendar date is the deadline's", () => {
    // The P1 case: with no end_time the section is treated as ending at 23:59:59, which is after
    // a noon deadline, so the same-day meeting cannot be the "most recent lab before the
    // deadline". Filtering on the date alone selected it and pushed the deadline a week out.
    expect(selectMostRecentLabMeeting(MEETINGS, null, TZ, noonOnAMeetingDay)?.meeting_date).toBe("2026-10-12");
  });

  test("rejects a same-day meeting that ends after a midday deadline", () => {
    // Lab meets 14:00-16:00; a noon deadline lands before the lab ends.
    expect(selectMostRecentLabMeeting(MEETINGS, "16:00:00", TZ, noonOnAMeetingDay)?.meeting_date).toBe("2026-10-12");
  });

  test("accepts a same-day meeting that has already ended by the deadline", () => {
    // The opposite error: a date-only string comparison excluded every same-day meeting, so a
    // lab ending at 11:00 with a 23:00 deadline wrongly fell back to the previous week.
    const lateEvening = new Date("2026-10-20T03:00:00Z"); // Mon 2026-10-19 23:00 EDT
    expect(selectMostRecentLabMeeting(MEETINGS, "11:00:00", TZ, lateEvening)?.meeting_date).toBe("2026-10-19");
  });

  test("counts a lab that ends exactly at the deadline", () => {
    // SQL compares with <=.
    const exactly = new Date("2026-10-19T20:00:00Z"); // Mon 2026-10-19 16:00 EDT
    expect(selectMostRecentLabMeeting(MEETINGS, "16:00:00", TZ, exactly)?.meeting_date).toBe("2026-10-19");
  });

  test("skips cancelled meetings", () => {
    const withCancellation = [
      { meeting_date: "2026-10-05", cancelled: false },
      { meeting_date: "2026-10-12", cancelled: true }
    ];
    const deadline = new Date("2026-10-19T16:00:00Z");
    expect(selectMostRecentLabMeeting(withCancellation, "11:00:00", TZ, deadline)?.meeting_date).toBe("2026-10-05");
  });

  test("returns null when no meeting has ended by the deadline", () => {
    const beforeTheTerm = new Date("2026-09-01T16:00:00Z");
    expect(selectMostRecentLabMeeting(MEETINGS, null, TZ, beforeTheTerm)).toBeNull();
  });
});

describe("calculateLabBasedDueDate", () => {
  test("matches calculate_effective_due_date for a NULL end_time section with a midday deadline", () => {
    // Measured from the database for these exact fixtures:
    //   due_date            = 2026-10-19 12:00:00 EDT
    //   effective due date  = 2026-10-13 00:59:59 EDT = 2026-10-13T04:59:59Z
    // The pre-fix client answer was 2026-10-20T04:59:00Z -- a week later, and 59 seconds short.
    const result = calculateLabBasedDueDate({
      meetings: MEETINGS,
      endTime: null,
      timeZone: TZ,
      assignmentDueDate: new Date("2026-10-19T16:00:00Z"),
      minutesDueAfterLab: 60
    });
    expect(result?.getTime()).toBe(Date.parse("2026-10-13T04:59:59Z"));
  });

  test("matches calculate_effective_due_date for a 14:00-16:00 lab with a midday deadline", () => {
    // Measured from the database: a Mon 12:00 EDT deadline against a lab ending 16:00 resolves to
    // the previous Monday's lab end plus the offset, 2026-10-12 17:00 EDT.
    const result = calculateLabBasedDueDate({
      meetings: MEETINGS,
      endTime: "16:00:00",
      timeZone: TZ,
      assignmentDueDate: new Date("2026-10-19T16:00:00Z"),
      minutesDueAfterLab: 60
    });
    expect(result?.getTime()).toBe(Date.parse("2026-10-12T21:00:00Z"));
  });

  test("applies the lab rule when the offset is zero", () => {
    // Measured from the database: with minutes_due_after_lab = 0 and a lab ending 16:00,
    // a Mon 12:00 EDT deadline resolves to the previous Monday's lab end, 2026-10-12 16:00 EDT.
    // A falsy `!minutes_due_after_lab` check in CourseController used to skip the rule entirely
    // and return the plain due date, a week later.
    const result = calculateLabBasedDueDate({
      meetings: MEETINGS,
      endTime: "16:00:00",
      timeZone: TZ,
      assignmentDueDate: new Date("2026-10-19T16:00:00Z"),
      minutesDueAfterLab: 0
    });
    expect(result?.getTime()).toBe(Date.parse("2026-10-12T20:00:00Z"));
  });

  test("returns null so callers fall back to the plain due date", () => {
    const result = calculateLabBasedDueDate({
      meetings: MEETINGS,
      endTime: null,
      timeZone: TZ,
      assignmentDueDate: new Date("2026-09-01T16:00:00Z"),
      minutesDueAfterLab: 60
    });
    expect(result).toBeNull();
  });
});
