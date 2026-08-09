import { isSelfViewAsScope, parseViewAsCookieValue } from "@/lib/viewAs";

/**
 * The scope predicate is the whole of the #892 fix: the server (getEffectiveCourseIdentity) and the
 * client (ClassProfileProvider) both decide whether staff self view-as still applies from it, and
 * they have to agree. A path that wrongly reads as in-scope puts the synthetic student identity
 * back on pages that cannot serve it; one that wrongly reads as out-of-scope drops staff out of the
 * Test Assignment preview they just entered.
 */
describe("isSelfViewAsScope", () => {
  it("covers the originating assignment and everything beneath it", () => {
    expect(isSelfViewAsScope("/course/12/assignments/34", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/submissions/56", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/submissions/56/files", 12, 34)).toBe(true);
  });

  it("excludes a different assignment, so a deep link cannot carry the preview along", () => {
    expect(isSelfViewAsScope("/course/12/assignments/35", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/35/submissions/56", 12, 34)).toBe(false);
    // Not a prefix match: assignment 340 is a different assignment from 34.
    expect(isSelfViewAsScope("/course/12/assignments/340", 12, 34)).toBe(false);
  });

  it("excludes the assignments list, which is the page that came back empty", () => {
    expect(isSelfViewAsScope("/course/12/assignments", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/", 12, 34)).toBe(false);
  });

  it("excludes the rest of the course", () => {
    expect(isSelfViewAsScope("/course/12", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/gradebook", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/discussion", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/office-hours", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/manage/assignments/34", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/", 12, 34)).toBe(false);
    // ClassProfileProvider passes `pathname ?? ""`, so the empty string reaches this function and
    // decides whether the preview cookie is cleared.
    expect(isSelfViewAsScope("", 12, 34)).toBe(false);
  });

  it("is scoped to the course the cookie belongs to", () => {
    expect(isSelfViewAsScope("/course/13/assignments/34", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34", "12", 34)).toBe(true);
  });

  it("requires a numeric assignment segment, so sibling routes do not qualify", () => {
    expect(isSelfViewAsScope("/course/12/assignments/new", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34x", 12, 34)).toBe(false);
  });

  it("treats a preview with no recorded assignment as out of scope everywhere", () => {
    expect(isSelfViewAsScope("/course/12/assignments/34", 12, null)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34/submissions/56", 12, null)).toBe(false);
  });

  it("ignores query strings and fragments", () => {
    expect(isSelfViewAsScope("/course/12/assignments/34?tab=results", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments?q=lab", 12, 34)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34#test-9", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34?tab=results#test-9", 12, 34)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments#top", 12, 34)).toBe(false);
  });
});

describe("parseViewAsCookieValue", () => {
  const profileId = "39dab5f1-3685-4d1a-8e9a-4b3abaee6971";

  it("reads a bare profile id as a course-wide target", () => {
    expect(parseViewAsCookieValue(profileId)).toEqual({ profileId, previewAssignmentId: null });
  });

  it("reads an assignment-scoped self preview", () => {
    expect(parseViewAsCookieValue(`${profileId}~34`)).toEqual({ profileId, previewAssignmentId: 34 });
  });

  it("uses a delimiter that survives URI encoding unchanged", () => {
    // The client writes through encodeURIComponent and reads back through decodeURIComponent, while
    // the server parses whatever `cookies()` hands it. A delimiter that encoding rewrites would let
    // those two disagree, and the server would read every path as out of scope.
    const raw = `${profileId}~34`;
    expect(encodeURIComponent(raw)).toBe(raw);
    expect(parseViewAsCookieValue(encodeURIComponent(raw))).toEqual({ profileId, previewAssignmentId: 34 });
  });

  it("rejects empty and malformed values rather than widening them", () => {
    expect(parseViewAsCookieValue(null)).toBeNull();
    expect(parseViewAsCookieValue("")).toBeNull();
    // A non-numeric suffix must not degrade into a course-wide target for that profile.
    expect(parseViewAsCookieValue(`${profileId}~not-a-number`)).toBeNull();
    expect(parseViewAsCookieValue(`${profileId}~`)).toBeNull();
    expect(parseViewAsCookieValue(`~34`)).toBeNull();
    // Extra segments are a shape this function never writes: reject rather than salvage a prefix,
    // which would turn a scoped preview into a course-wide target.
    expect(parseViewAsCookieValue(`${profileId}~34~99`)).toBeNull();
  });
});
