import { isSelfViewAsScope, parseViewAsCookieValue } from "@/lib/viewAs";

/**
 * The scope predicate decides how far the Test Assignment self-preview reaches. The preview is
 * client state, so nothing can be stranded by getting this wrong — but a path that wrongly reads as
 * in-scope keeps the student view on pages it cannot represent (the assignments dashboard and the
 * course-home panel are keyed on a real `role = 'student'` enrollment and come back empty for staff,
 * which is issue #892), and one that wrongly reads as out-of-scope drops staff out of the preview
 * they just opened.
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

  it("reads the enrolled student being viewed", () => {
    expect(parseViewAsCookieValue(profileId)).toBe(profileId);
    expect(parseViewAsCookieValue(encodeURIComponent(profileId))).toBe(profileId);
  });

  it("rejects anything that is not a uuid rather than passing it to identity resolution", () => {
    expect(parseViewAsCookieValue(null)).toBeNull();
    expect(parseViewAsCookieValue("")).toBeNull();
    expect(parseViewAsCookieValue("not-a-uuid")).toBeNull();
    // Wrong length must not squeak through.
    expect(parseViewAsCookieValue("39dab5f1-3685-4d1a-8e9a-4b3abaee697")).toBeNull();
    // Leftovers from the previous scoped-preview payload are not valid targets either.
    expect(parseViewAsCookieValue(`${profileId}~34~abc`)).toBeNull();
  });

  it("does not throw on a value that cannot be decoded", () => {
    // decodeURIComponent throws URIError on an invalid percent escape, and this runs while reading
    // cookies during render.
    expect(parseViewAsCookieValue("%E0%A4%A")).toBeNull();
  });
});
