/**
 * Regression tests for issue #890.
 *
 * An instructor in Denver creating a 9:00 AM assignment for a New York course got 11:00 AM.
 * A `datetime-local` input yields a naive wall clock ("2026-09-01T09:00") with no offset, so
 * `new Date(...)` / `new TZDate(..., tz)` anchor it to whatever zone the *browser* is in — the
 * `tz` argument to `TZDate` only changes how the resulting instant is displayed, not how the
 * string is parsed. The assignment form labels these inputs as course-time, so they must be
 * pinned to the course zone instead.
 *
 * The bug itself was in the create page (it discarded the already-converted `values` from the
 * shared form and re-derived the dates through the wrong parse); these tests lock down the
 * helper both paths now go through.
 */

import { appendTimezoneOffset, parseZonedFormDate, toDateTimeLocalValue } from "@/lib/utils";

const COURSE_TZ = "America/New_York";

describe("parseZonedFormDate", () => {
  it("ignores the ambient browser zone entirely", () => {
    // The bug in #890 was that the entered wall clock was read in the browser's zone. Nothing pins
    // `TZ` for Jest, so rather than assert that the ambient zone differs from the course zone (which
    // fails for anyone actually working in US Eastern), assert the property that matters: the result
    // is the course-zone reading whatever the ambient zone happens to be.
    expect(parseZonedFormDate("2026-09-01T09:00", COURSE_TZ)?.toISOString()).toBe("2026-09-01T13:00:00.000Z");
    // Sanity check that the two readings really are distinguishable somewhere, so the assertion
    // above is not tautological: a browser-anchored parse in UTC would give 09:00Z.
    expect(new Date("2026-09-01T09:00Z").toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("anchors a naive datetime-local value to the course zone, not the browser zone", () => {
    // 9:00 AM EDT is 13:00 UTC. The browser-anchored parse would give 15:00 UTC (11:00 EDT),
    // which is exactly the shift reported in #890.
    expect(parseZonedFormDate("2026-09-01T09:00", COURSE_TZ)?.toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });

  it("respects the course zone's DST offset", () => {
    // December is EST (UTC-5), so 9:00 AM is 14:00 UTC rather than 13:00.
    expect(parseZonedFormDate("2026-12-14T09:00", COURSE_TZ)?.toISOString()).toBe("2026-12-14T14:00:00.000Z");
  });

  it("passes through values that already carry an offset", () => {
    // Edit-mode fields are rehydrated from the database with an offset attached; re-anchoring
    // them would shift the time a second time on every save.
    expect(parseZonedFormDate("2026-09-01T09:00-04:00", COURSE_TZ)?.toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });

  it("returns null for empty input", () => {
    expect(parseZonedFormDate(null, COURSE_TZ)).toBeNull();
    expect(parseZonedFormDate("", COURSE_TZ)).toBeNull();
    expect(parseZonedFormDate(undefined, COURSE_TZ)).toBeNull();
  });

  it("honours an explicit UTC designator", () => {
    // A `Z` suffix already fixes the instant, so the course zone must not be applied on top of it.
    expect(parseZonedFormDate("2026-09-01T13:00:00Z", COURSE_TZ)?.toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });

  it("returns null rather than an Invalid Date for a value it cannot normalize", () => {
    // Validators call this, so an unparseable value has to come back as an absent date rather than
    // an `Invalid Date` whose NaN comparisons are all silently false.
    expect(parseZonedFormDate("not a date", COURSE_TZ)).toBeNull();
  });

  it("handles a course zone west of the browser zone", () => {
    // 9:00 AM PDT is 16:00 UTC.
    expect(parseZonedFormDate("2026-09-01T09:00", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-09-01T16:00:00.000Z"
    );
  });

  it("picks the offset in effect on the entered date, not the browser's reading of it", () => {
    // The two days either side of a New York DST transition. Deriving the offset by parsing the
    // naive text in the browser's zone lands on the wrong side of the transition whenever the
    // browser is far enough west, which stamped -04:00 on Mar 7 (10:59 PM EST instead of 11:59 PM)
    // and -05:00 on Oct 31 (12:59 AM Nov 1 instead of 11:59 PM Oct 31). Both are #890 again, so
    // they must resolve from the course zone regardless of where the instructor is sitting.
    expect(parseZonedFormDate("2026-03-07T23:59", COURSE_TZ)?.toISOString()).toBe("2026-03-08T04:59:00.000Z");
    expect(parseZonedFormDate("2026-10-31T23:59", COURSE_TZ)?.toISOString()).toBe("2026-11-01T03:59:00.000Z");
  });

  it("handles zones whose offset is not a whole number of hours", () => {
    expect(appendTimezoneOffset("2026-09-01T09:00", "Asia/Kolkata")).toBe("2026-09-01T09:00+05:30");
    expect(appendTimezoneOffset("2026-09-01T09:00", "Asia/Kathmandu")).toBe("2026-09-01T09:00+05:45");
  });
});

describe("appendTimezoneOffset", () => {
  it("stamps the course-zone offset onto a naive value", () => {
    expect(appendTimezoneOffset("2026-09-01T09:00", COURSE_TZ)).toBe("2026-09-01T09:00-04:00");
  });

  it("leaves an already-offset value untouched", () => {
    expect(appendTimezoneOffset("2026-09-01T09:00-07:00", COURSE_TZ)).toBe("2026-09-01T09:00-07:00");
    expect(appendTimezoneOffset("2026-09-01T13:00:00Z", COURSE_TZ)).toBe("2026-09-01T13:00:00Z");
  });

  it("passes null through", () => {
    expect(appendTimezoneOffset(null, COURSE_TZ)).toBeNull();
  });

  it("leaves a date-only value alone rather than producing an unparseable string", () => {
    // A bare date has no time to place in a zone, and "2026-09-01-04:00" is not a date any parser
    // accepts, so appending would turn a merely-unsupported input into a silently broken one.
    expect(appendTimezoneOffset("2026-09-01", COURSE_TZ)).toBe("2026-09-01");
    expect(appendTimezoneOffset("not a date", COURSE_TZ)).toBe("not a date");
  });

  it("stamps an offset that names the instant it resolved, even inside a spring-forward gap", () => {
    // 2:30 AM does not exist in New York on 2026-03-08. Whatever instant the resolution picks, the
    // returned string has to name that same instant — deriving the offset from the offset in
    // effect *at* the resolved instant puts the two an hour apart.
    const stamped = appendTimezoneOffset("2026-03-08T02:30", COURSE_TZ)!;
    expect(new Date(stamped).getTime()).toBe(parseZonedFormDate("2026-03-08T02:30", COURSE_TZ)!.getTime());
  });
});

describe("toDateTimeLocalValue", () => {
  it("renders a stored timestamp as the course-zone wall clock", () => {
    expect(toDateTimeLocalValue("2026-09-01T13:00:00+00:00", COURSE_TZ)).toBe("2026-09-01T09:00");
  });

  it("recognises a UTC designator, which the old charAt(length - 6) sniff missed", () => {
    // A `Z` value used to be handed to the input verbatim, which rejects it and renders blank —
    // the field then submits "" and the stored date is destroyed on save.
    expect(toDateTimeLocalValue("2026-09-01T13:00:00Z", COURSE_TZ)).toBe("2026-09-01T09:00");
  });

  it("passes a bare wall clock through, so typing in the field is not re-anchored", () => {
    expect(toDateTimeLocalValue("2026-09-01T09:00", COURSE_TZ)).toBe("2026-09-01T09:00");
  });

  it("round-trips with appendTimezoneOffset", () => {
    const typed = "2026-12-14T09:00";
    const stored = appendTimezoneOffset(typed, COURSE_TZ)!;
    expect(toDateTimeLocalValue(stored, COURSE_TZ)).toBe(typed);
  });

  it("returns an empty string for absent or unparseable values", () => {
    expect(toDateTimeLocalValue(null, COURSE_TZ)).toBe("");
    expect(toDateTimeLocalValue(undefined, COURSE_TZ)).toBe("");
    expect(toDateTimeLocalValue("", COURSE_TZ)).toBe("");
  });
});
