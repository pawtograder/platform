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

// Measured with `SELECT (('<date> <time>')::timestamp AT TIME ZONE '<zone>') AT TIME ZONE 'UTC'`
// on local Supabase. Covers both DST transitions in a northern zone (America/New_York), a zone
// that falls back at midnight so the 23:59:59 default lands in the repeated hour
// (America/Santiago 2026-04-04), a zone whose repeated hour is 01:00-01:59 UTC
// (Europe/London), and a southern-hemisphere spring-forward (Australia/Sydney 2026-04-05).
const PG_DST_REFERENCE: Array<[timeZone: string, meetingDate: string, endTime: string, pgUtc: string]> = [
  ["America/New_York", "2026-03-08", "00:00:00", "2026-03-08T05:00:00Z"],
  ["America/New_York", "2026-03-08", "00:30:00", "2026-03-08T05:30:00Z"],
  ["America/New_York", "2026-03-08", "01:00:00", "2026-03-08T06:00:00Z"],
  ["America/New_York", "2026-03-08", "01:30:00", "2026-03-08T06:30:00Z"],
  ["America/New_York", "2026-03-08", "01:59:59", "2026-03-08T06:59:59Z"],
  ["America/New_York", "2026-03-08", "02:00:00", "2026-03-08T07:00:00Z"],
  ["America/New_York", "2026-03-08", "02:30:00", "2026-03-08T07:30:00Z"],
  ["America/New_York", "2026-03-08", "02:59:59", "2026-03-08T07:59:59Z"],
  ["America/New_York", "2026-03-08", "03:00:00", "2026-03-08T07:00:00Z"],
  ["America/New_York", "2026-03-08", "03:30:00", "2026-03-08T07:30:00Z"],
  ["America/New_York", "2026-03-08", "22:59:59", "2026-03-09T02:59:59Z"],
  ["America/New_York", "2026-03-08", "23:00:00", "2026-03-09T03:00:00Z"],
  ["America/New_York", "2026-03-08", "23:30:00", "2026-03-09T03:30:00Z"],
  ["America/New_York", "2026-03-08", "23:59:59", "2026-03-09T03:59:59Z"],
  ["America/New_York", "2026-11-01", "00:00:00", "2026-11-01T04:00:00Z"],
  ["America/New_York", "2026-11-01", "00:30:00", "2026-11-01T04:30:00Z"],
  ["America/New_York", "2026-11-01", "01:00:00", "2026-11-01T06:00:00Z"],
  ["America/New_York", "2026-11-01", "01:30:00", "2026-11-01T06:30:00Z"],
  ["America/New_York", "2026-11-01", "01:59:59", "2026-11-01T06:59:59Z"],
  ["America/New_York", "2026-11-01", "02:00:00", "2026-11-01T07:00:00Z"],
  ["America/New_York", "2026-11-01", "02:30:00", "2026-11-01T07:30:00Z"],
  ["America/New_York", "2026-11-01", "02:59:59", "2026-11-01T07:59:59Z"],
  ["America/New_York", "2026-11-01", "03:00:00", "2026-11-01T08:00:00Z"],
  ["America/New_York", "2026-11-01", "03:30:00", "2026-11-01T08:30:00Z"],
  ["America/New_York", "2026-11-01", "22:59:59", "2026-11-02T03:59:59Z"],
  ["America/New_York", "2026-11-01", "23:00:00", "2026-11-02T04:00:00Z"],
  ["America/New_York", "2026-11-01", "23:30:00", "2026-11-02T04:30:00Z"],
  ["America/New_York", "2026-11-01", "23:59:59", "2026-11-02T04:59:59Z"],
  ["America/Santiago", "2026-04-04", "00:00:00", "2026-04-04T03:00:00Z"],
  ["America/Santiago", "2026-04-04", "00:30:00", "2026-04-04T03:30:00Z"],
  ["America/Santiago", "2026-04-04", "01:00:00", "2026-04-04T04:00:00Z"],
  ["America/Santiago", "2026-04-04", "01:30:00", "2026-04-04T04:30:00Z"],
  ["America/Santiago", "2026-04-04", "01:59:59", "2026-04-04T04:59:59Z"],
  ["America/Santiago", "2026-04-04", "02:00:00", "2026-04-04T05:00:00Z"],
  ["America/Santiago", "2026-04-04", "02:30:00", "2026-04-04T05:30:00Z"],
  ["America/Santiago", "2026-04-04", "02:59:59", "2026-04-04T05:59:59Z"],
  ["America/Santiago", "2026-04-04", "03:00:00", "2026-04-04T06:00:00Z"],
  ["America/Santiago", "2026-04-04", "03:30:00", "2026-04-04T06:30:00Z"],
  ["America/Santiago", "2026-04-04", "22:59:59", "2026-04-05T01:59:59Z"],
  ["America/Santiago", "2026-04-04", "23:00:00", "2026-04-05T03:00:00Z"],
  ["America/Santiago", "2026-04-04", "23:30:00", "2026-04-05T03:30:00Z"],
  ["America/Santiago", "2026-04-04", "23:59:59", "2026-04-05T03:59:59Z"],
  ["Australia/Sydney", "2026-04-05", "00:00:00", "2026-04-04T13:00:00Z"],
  ["Australia/Sydney", "2026-04-05", "00:30:00", "2026-04-04T13:30:00Z"],
  ["Australia/Sydney", "2026-04-05", "01:00:00", "2026-04-04T14:00:00Z"],
  ["Australia/Sydney", "2026-04-05", "01:30:00", "2026-04-04T14:30:00Z"],
  ["Australia/Sydney", "2026-04-05", "01:59:59", "2026-04-04T14:59:59Z"],
  ["Australia/Sydney", "2026-04-05", "02:00:00", "2026-04-04T16:00:00Z"],
  ["Australia/Sydney", "2026-04-05", "02:30:00", "2026-04-04T16:30:00Z"],
  ["Australia/Sydney", "2026-04-05", "02:59:59", "2026-04-04T16:59:59Z"],
  ["Australia/Sydney", "2026-04-05", "03:00:00", "2026-04-04T17:00:00Z"],
  ["Australia/Sydney", "2026-04-05", "03:30:00", "2026-04-04T17:30:00Z"],
  ["Australia/Sydney", "2026-04-05", "22:59:59", "2026-04-05T12:59:59Z"],
  ["Australia/Sydney", "2026-04-05", "23:00:00", "2026-04-05T13:00:00Z"],
  ["Australia/Sydney", "2026-04-05", "23:30:00", "2026-04-05T13:30:00Z"],
  ["Australia/Sydney", "2026-04-05", "23:59:59", "2026-04-05T13:59:59Z"],
  ["Europe/London", "2026-10-25", "00:00:00", "2026-10-24T23:00:00Z"],
  ["Europe/London", "2026-10-25", "00:30:00", "2026-10-24T23:30:00Z"],
  ["Europe/London", "2026-10-25", "01:00:00", "2026-10-25T01:00:00Z"],
  ["Europe/London", "2026-10-25", "01:30:00", "2026-10-25T01:30:00Z"],
  ["Europe/London", "2026-10-25", "01:59:59", "2026-10-25T01:59:59Z"],
  ["Europe/London", "2026-10-25", "02:00:00", "2026-10-25T02:00:00Z"],
  ["Europe/London", "2026-10-25", "02:30:00", "2026-10-25T02:30:00Z"],
  ["Europe/London", "2026-10-25", "02:59:59", "2026-10-25T02:59:59Z"],
  ["Europe/London", "2026-10-25", "03:00:00", "2026-10-25T03:00:00Z"],
  ["Europe/London", "2026-10-25", "03:30:00", "2026-10-25T03:30:00Z"],
  ["Europe/London", "2026-10-25", "22:59:59", "2026-10-25T22:59:59Z"],
  ["Europe/London", "2026-10-25", "23:00:00", "2026-10-25T23:00:00Z"],
  ["Europe/London", "2026-10-25", "23:30:00", "2026-10-25T23:30:00Z"],
  ["Europe/London", "2026-10-25", "23:59:59", "2026-10-25T23:59:59Z"]
];

describe("labMeetingEndTimestamp DST parity with Postgres", () => {
  test.each(PG_DST_REFERENCE)("%s %s %s", (timeZone, meetingDate, endTime, pgUtc) => {
    expect(labMeetingEndTimestamp(meetingDate, endTime, timeZone).getTime()).toBe(Date.parse(pgUtc));
  });

  test("resolves an ambiguous fall-back wall clock to the later, standard-time instant", () => {
    // 2026-11-01 01:30 in New York exists twice. Postgres returns 06:30Z (EST); the bare
    // TZDate constructor returns 05:30Z (EDT), the first occurrence.
    expect(labMeetingEndTimestamp("2026-11-01", "01:30:00", "America/New_York").getTime()).toBe(
      Date.parse("2026-11-01T06:30:00Z")
    );
  });

  test("resolves the 23:59:59 default when the repeated hour covers it", () => {
    // Chile falls back at midnight, so local 23:00-23:59:59 on 2026-04-04 repeats -- which is
    // exactly where a section with no end_time sits. Postgres returns 03:59:59Z, TZDate 02:59:59Z.
    expect(labMeetingEndTimestamp("2026-04-04", null, "America/Santiago").getTime()).toBe(
      Date.parse("2026-04-05T03:59:59Z")
    );
  });

  test("resolves a nonexistent spring-forward wall clock the way Postgres does", () => {
    // 2026-03-08 02:30 in New York does not exist. Postgres uses the pre-transition offset,
    // landing on 07:30Z (03:30 EDT). TZDate already agreed here; this pins it.
    expect(labMeetingEndTimestamp("2026-03-08", "02:30:00", "America/New_York").getTime()).toBe(
      Date.parse("2026-03-08T07:30:00Z")
    );
  });

  test("the ambiguity changes which meeting is selected, not just the time shown", () => {
    // Measured: a lab ending 01:30 on Sundays, minutes_due_after_lab = 60, deadline
    // 2026-11-01 06:00Z -- after the daylight reading of the 2026-11-01 lab end (05:30Z) but
    // before the standard one (06:30Z). calculate_effective_due_date returns
    // 2026-10-25 06:30:00Z, i.e. it rejects the 2026-11-01 meeting and falls back a week.
    // Reading the lab end as 05:30Z instead accepts it and lands on 2026-11-01T06:30:00Z --
    // the same clock time, seven days late.
    const sundays = [
      { meeting_date: "2026-10-18" },
      { meeting_date: "2026-10-25" },
      { meeting_date: "2026-11-01" },
      { meeting_date: "2026-11-08" }
    ];
    expect(
      selectMostRecentLabMeeting(sundays, "01:30:00", "America/New_York", new Date("2026-11-01T06:00:00Z"))
        ?.meeting_date
    ).toBe("2026-10-25");
    expect(
      calculateLabBasedDueDate({
        meetings: sundays,
        endTime: "01:30:00",
        timeZone: "America/New_York",
        assignmentDueDate: new Date("2026-11-01T06:00:00Z"),
        minutesDueAfterLab: 60
      })?.getTime()
    ).toBe(Date.parse("2026-10-25T06:30:00Z"));
  });
});
