/**
 * @jest-environment node
 */

/**
 * Due dates for `reviews assign` are interpreted in the class's time zone.
 *
 * `new Date("2026-09-15")` is midnight UTC, which for a New York course is the
 * evening of the 14th — so a deadline entered as a bare date silently landed on
 * the wrong day, a day earlier than the instructor typed. These tests pin the
 * zone handling, including the DST transitions where a naive fixed-offset
 * implementation goes wrong.
 */

import { resolveDueDate, resolveReleaseDate, ZonedDateError } from "../../supabase/functions/cli/utils/zonedDate";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

/** What a given instant looks like on the wall clock in `tz`. */
function wallClock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

describe("resolveDueDate — date-only input", () => {
  it("keeps the date the instructor typed, in the class's zone", () => {
    const iso = resolveDueDate("2026-09-15", NY);
    // The bug: this used to resolve to 2026-09-14 in New York.
    expect(wallClock(iso, NY)).toBe("2026-09-15, 23:59:59");
  });

  it("resolves to end of day rather than the start", () => {
    const iso = resolveDueDate("2026-09-15", NY);
    expect(iso).toBe(new Date("2026-09-16T03:59:59.999Z").toISOString());
  });

  it("handles a zone ahead of UTC, where the naive reading is a day late", () => {
    const iso = resolveDueDate("2026-09-15", TOKYO);
    expect(wallClock(iso, TOKYO)).toBe("2026-09-15, 23:59:59");
  });

  it("treats a missing class time zone as UTC", () => {
    expect(resolveDueDate("2026-09-15", null)).toBe("2026-09-15T23:59:59.999Z");
    expect(resolveDueDate("2026-09-15", "")).toBe("2026-09-15T23:59:59.999Z");
  });

  it("uses the correct offset on each side of a DST boundary", () => {
    // EDT (UTC-4) before the November transition, EST (UTC-5) after.
    expect(resolveDueDate("2026-11-01", NY)).toBe("2026-11-02T04:59:59.999Z");
    expect(resolveDueDate("2026-11-02", NY)).toBe("2026-11-03T04:59:59.999Z");
    expect(resolveDueDate("2026-06-15", NY)).toBe("2026-06-16T03:59:59.999Z");
    expect(resolveDueDate("2026-01-15", NY)).toBe("2026-01-16T04:59:59.999Z");
  });
});

describe("resolveDueDate — wall-clock date and time", () => {
  it("interprets a bare date-time in the class's zone", () => {
    const iso = resolveDueDate("2026-09-15T17:00", NY);
    expect(wallClock(iso, NY)).toBe("2026-09-15, 17:00:00");
    expect(iso).toBe("2026-09-15T21:00:00.000Z");
  });

  it("accepts seconds", () => {
    expect(resolveDueDate("2026-09-15T17:00:30", NY)).toBe("2026-09-15T21:00:30.000Z");
  });

  it("accepts fractional seconds in the class's zone, not UTC", () => {
    // The client forwards `.\d+`, so this must be recognized as a *local*
    // timestamp. Falling through to `new Date(raw)` read it as UTC, turning a
    // requested 5 PM Eastern into 1 PM.
    expect(resolveDueDate("2026-09-15T17:00:00.500", NY)).toBe("2026-09-15T21:00:00.500Z");
    expect(wallClock(resolveDueDate("2026-09-15T17:00:00.500", NY), NY)).toBe("2026-09-15, 17:00:00");
  });

  it("reads a single fractional digit as tenths, not milliseconds", () => {
    expect(resolveDueDate("2026-09-15T17:00:00.5", NY)).toBe("2026-09-15T21:00:00.500Z");
  });

  it("truncates sub-millisecond precision rather than rejecting it", () => {
    expect(resolveDueDate("2026-09-15T17:00:00.123456", NY)).toBe("2026-09-15T21:00:00.123Z");
  });

  it("does not shift a spring-forward gap time into a wildly wrong instant", () => {
    // 02:30 on 2026-03-08 does not exist in New York. It should resolve to a
    // stable instant near the transition rather than throwing or jumping a day.
    const iso = resolveDueDate("2026-03-08T02:30", NY);
    const ms = new Date(iso).getTime();
    expect(Math.abs(ms - new Date("2026-03-08T07:30:00Z").getTime())).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe("resolveDueDate — explicit offsets are respected", () => {
  it("passes through a Z timestamp unchanged", () => {
    expect(resolveDueDate("2026-09-15T12:00:00Z", NY)).toBe("2026-09-15T12:00:00.000Z");
  });

  it("honors an explicit numeric offset over the class zone", () => {
    expect(resolveDueDate("2026-09-15T12:00:00+09:00", NY)).toBe("2026-09-15T03:00:00.000Z");
  });
});

describe("resolveDueDate — rejections", () => {
  it("rejects empty input", () => {
    expect(() => resolveDueDate("   ", NY)).toThrow(ZonedDateError);
  });

  it("rejects unparseable input with an actionable message", () => {
    expect(() => resolveDueDate("next tuesday", NY)).toThrow(/Could not parse date/);
  });

  it("rejects an out-of-range wall clock instead of rolling it over", () => {
    // Date.UTC turned 25:00 into the next day at 01:00, storing a deadline the
    // caller never asked for.
    expect(() => resolveDueDate("2026-09-15T25:00", NY)).toThrow(/Invalid time of day/);
    expect(() => resolveDueDate("2026-09-15T12:60", NY)).toThrow(/Invalid time of day/);
    expect(() => resolveDueDate("2026-09-15T12:00:60", NY)).toThrow(/Invalid time of day/);
    expect(() => resolveReleaseDate("2026-09-15T99:99", NY)).toThrow(/Invalid time of day/);
    // The boundaries themselves stay valid.
    expect(resolveDueDate("2026-09-15T23:59:59.999", NY)).toBe("2026-09-16T03:59:59.999Z");
  });

  it("rejects offset-less formats rather than reading them in the runtime's zone", () => {
    // The Edge runtime's local zone is UTC, so anything Date accepts without an
    // offset would be silently shifted out of the class's zone. Better to refuse
    // than to set a deadline hours off.
    expect(() => resolveDueDate("09/15/2026", NY)).toThrow(/explicit offset/);
    expect(() => resolveDueDate("Sep 15 2026 17:00", NY)).toThrow(/explicit offset/);
    expect(() => resolveDueDate("2026-09-15T17:00:00.123456789", NY)).not.toThrow();
  });

  it("rejects an unknown class time zone instead of quietly using UTC", () => {
    expect(() => resolveDueDate("2026-09-15", "Mars/Olympus_Mons")).toThrow(/Unknown time zone/);
  });

  it("rejects an impossible calendar date", () => {
    expect(() => resolveDueDate("2026-02-30", NY)).toThrow(ZonedDateError);
  });

  it("rejects an impossible date even when it carries an explicit offset", () => {
    // V8 normalizes rather than rejecting, so this used to schedule March 2.
    expect(() => resolveDueDate("2026-02-30T17:00:00-05:00", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("2026-13-01T00:00:00Z", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("2026-02-28T17:00:00-05:00", NY)).not.toThrow();
  });
});

describe("resolveReleaseDate", () => {
  it("puts a bare date at the start of that day, not the end", () => {
    // A release date at 23:59:59.999 would keep the assignment hidden for
    // essentially the whole day the operator named.
    const iso = resolveReleaseDate("2026-01-15", NY);
    expect(wallClock(iso, NY)).toBe("2026-01-15, 00:00:00");
    expect(iso).toBe("2026-01-15T05:00:00.000Z");
  });

  it("differs from a due date on the same input", () => {
    expect(resolveReleaseDate("2026-01-15", NY)).not.toBe(resolveDueDate("2026-01-15", NY));
    expect(new Date(resolveReleaseDate("2026-01-15", NY)).getTime()).toBeLessThan(
      new Date(resolveDueDate("2026-01-15", NY)).getTime()
    );
  });

  it("uses the same wall-clock handling as due dates once a time is given", () => {
    expect(resolveReleaseDate("2026-01-15T09:00", NY)).toBe(resolveDueDate("2026-01-15T09:00", NY));
  });

  it("respects DST on the start boundary", () => {
    expect(resolveReleaseDate("2026-06-15", NY)).toBe("2026-06-15T04:00:00.000Z");
  });
});

/**
 * Zones whose DST jump lands at 00:00 put the start of the day inside the gap, so
 * resolving to the wrong side of it moves a release date to the *previous calendar day* —
 * an assignment named for the 8th going live on the 7th. `America/New_York` cannot catch
 * this because its gap is 02:00-03:00, well away from either boundary.
 */
describe("a DST transition at midnight", () => {
  const localDay = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso)
    );

  // Havana and Santiago jump forward at 00:00; Cairo and Beirut do too, but sit east of
  // UTC, so the offset arithmetic runs the other way.
  const midnightJumps: Array<[string, string]> = [
    ["America/Havana", "2026-03-08"],
    ["America/Santiago", "2026-09-06"],
    ["Africa/Cairo", "2026-04-24"],
    ["Asia/Beirut", "2026-03-29"]
  ];

  it.each(midnightJumps)("keeps a start-of-day release date on the named day in %s", (zone, day) => {
    expect(localDay(resolveReleaseDate(day, zone), zone)).toBe(day);
  });

  it.each(midnightJumps)("keeps an end-of-day due date on the named day in %s", (zone, day) => {
    expect(localDay(resolveDueDate(day, zone), zone)).toBe(day);
  });

  it("resolves a nonexistent wall clock forward past the gap, not back before it", () => {
    // 02:00-03:00 does not exist in New York on 2026-03-08; 02:30 means 03:30 EDT.
    expect(resolveDueDate("2026-03-08T02:30", NY)).toBe("2026-03-08T07:30:00.000Z");
    // Half-hour jump: Lord Howe goes 02:00 -> 02:30, so 02:15 means 02:45.
    expect(resolveDueDate("2026-10-04T02:15", "Australia/Lord_Howe")).toBe("2026-10-03T15:45:00.000Z");
  });

  it("still picks the first occurrence of an ambiguous fall-back hour", () => {
    // 01:30 happens twice in New York on 2026-11-01; the earlier (EDT) one is chosen.
    expect(resolveDueDate("2026-11-01T01:30", NY)).toBe("2026-11-01T05:30:00.000Z");
  });
});

/**
 * An offset-bearing timestamp is matched in full, not just checked for an offset
 * suffix. Delegating the rest of the string to `new Date` let V8's legacy parser
 * reinterpret junk into a plausible-looking instant, so a due date could land months
 * from where the operator wrote it with no error anywhere.
 */
describe("resolveDueDate — offset-bearing input", () => {
  it("rejects a timestamp that only ends in an offset", () => {
    // The bug: this parsed as 2026-06-09T00:00:00.000Z — three months early.
    expect(() => resolveDueDate("2026-09-15junkZ", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("2026-09-15T17:00:00 and then some+05:00", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("garbage 2026-09-15T17:00:00Z", NY)).toThrow(ZonedDateError);
  });

  it.each([
    ["2026-09-15T17:00:00Z", "2026-09-15T17:00:00.000Z"],
    ["2026-09-15T17:00Z", "2026-09-15T17:00:00.000Z"],
    ["2026-09-15T17:00:00.5Z", "2026-09-15T17:00:00.500Z"],
    ["2026-09-15T17:00:00-04:00", "2026-09-15T21:00:00.000Z"],
    // Offset without the colon, and a half-hour offset east of UTC.
    ["2026-09-15T17:00:00-0400", "2026-09-15T21:00:00.000Z"],
    ["2026-09-15T17:00:00+05:30", "2026-09-15T11:30:00.000Z"]
  ])("honors the stated offset in %s", (input, expected) => {
    expect(resolveDueDate(input, NY)).toBe(expected);
  });

  it("applies the stated offset rather than the class zone", () => {
    // Same instant regardless of which class reads it — the offset wins.
    expect(resolveDueDate("2026-09-15T17:00:00-04:00", TOKYO)).toBe("2026-09-15T21:00:00.000Z");
  });

  it("rejects an impossible calendar date even with an offset", () => {
    expect(() => resolveDueDate("2026-02-30T17:00:00-05:00", NY)).toThrow(ZonedDateError);
  });

  it("rejects an out-of-range wall clock or offset", () => {
    expect(() => resolveDueDate("2026-09-15T25:00:00Z", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("2026-09-15T17:60:00Z", NY)).toThrow(ZonedDateError);
    expect(() => resolveDueDate("2026-09-15T17:00:00+99:99", NY)).toThrow(ZonedDateError);
  });
});
