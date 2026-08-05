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

import { appendTimezoneOffset, parseZonedFormDate } from "@/lib/utils";

const COURSE_TZ = "America/New_York";

describe("parseZonedFormDate", () => {
  it("runs under a browser zone that differs from the course zone", () => {
    // Guards the premise of every other test here: the assertions below only discriminate
    // between the fixed and buggy parse while the ambient zone is not the course zone. Jest
    // runs in UTC locally and in CI, so this holds; it is asserted rather than assumed so that
    // a runner configured to America/New_York fails loudly instead of passing vacuously.
    const browserAnchored = new Date("2026-09-01T09:00").toISOString();
    const courseAnchored = parseZonedFormDate("2026-09-01T09:00", COURSE_TZ)?.toISOString();
    expect(browserAnchored).not.toBe(courseAnchored);
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

  it("handles a course zone west of the browser zone", () => {
    // 9:00 AM PDT is 16:00 UTC.
    expect(parseZonedFormDate("2026-09-01T09:00", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-09-01T16:00:00.000Z"
    );
  });
});

describe("appendTimezoneOffset", () => {
  it("stamps the course-zone offset onto a naive value", () => {
    expect(appendTimezoneOffset("2026-09-01T09:00", COURSE_TZ)).toBe("2026-09-01T09:00-04:00");
  });

  it("leaves an already-offset value untouched", () => {
    expect(appendTimezoneOffset("2026-09-01T09:00-07:00", COURSE_TZ)).toBe("2026-09-01T09:00-07:00");
  });

  it("passes null through", () => {
    expect(appendTimezoneOffset(null, COURSE_TZ)).toBeNull();
  });
});
