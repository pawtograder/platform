import { clearStalePreviewCookies, getTabId, isSelfViewAsScope, parseViewAsCookieValue } from "@/lib/viewAs";

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
    expect(parseViewAsCookieValue(profileId)).toEqual({
      profileId,
      previewAssignmentId: null,
      previewTabId: null
    });
  });

  it("reads an assignment-scoped self preview with the tab that opened it", () => {
    expect(parseViewAsCookieValue(`${profileId}~34~ab12cd34`)).toEqual({
      profileId,
      previewAssignmentId: 34,
      previewTabId: "ab12cd34"
    });
  });

  it("treats a value written before tab tracking as owned by no tab", () => {
    // Such a cookie is cleanable by any mount, rather than sticky until the browser closes.
    expect(parseViewAsCookieValue(`${profileId}~34`)).toEqual({
      profileId,
      previewAssignmentId: 34,
      previewTabId: null
    });
    expect(parseViewAsCookieValue(`${profileId}~34~`)).toEqual({
      profileId,
      previewAssignmentId: 34,
      previewTabId: null
    });
  });

  it("uses a delimiter that survives URI encoding unchanged", () => {
    // The client writes through encodeURIComponent and reads back through decodeURIComponent, while
    // the server parses whatever `cookies()` hands it. A delimiter that encoding rewrites would let
    // those two disagree, and the server would read every path as out of scope.
    const raw = `${profileId}~34~ab12cd34`;
    expect(encodeURIComponent(raw)).toBe(raw);
    expect(parseViewAsCookieValue(encodeURIComponent(raw))).toEqual({
      profileId,
      previewAssignmentId: 34,
      previewTabId: "ab12cd34"
    });
  });

  it("rejects empty and malformed values rather than widening them", () => {
    expect(parseViewAsCookieValue(null)).toBeNull();
    expect(parseViewAsCookieValue("")).toBeNull();
    // A non-numeric assignment must not degrade into a course-wide target for that profile.
    expect(parseViewAsCookieValue(`${profileId}~not-a-number`)).toBeNull();
    expect(parseViewAsCookieValue(`${profileId}~`)).toBeNull();
    expect(parseViewAsCookieValue(`~34`)).toBeNull();
    // More segments than this module ever writes: reject rather than salvage a prefix.
    expect(parseViewAsCookieValue(`${profileId}~34~tab~extra`)).toBeNull();
  });
});

describe("clearStalePreviewCookies", () => {
  const profileId = "39dab5f1-3685-4d1a-8e9a-4b3abaee6971";
  const otherProfile = "e860f42d-f381-4404-902c-79d222b23c69";

  beforeEach(() => {
    for (const row of document.cookie.split("; ")) {
      const name = row.split("=")[0];
      if (name) document.cookie = `${name}=; path=/; max-age=0`;
    }
    window.sessionStorage.clear();
  });

  it("ends a self preview this tab left behind in another course", () => {
    const tabId = getTabId();
    document.cookie = `view_as_12=${profileId}~34~${tabId}; path=/`;
    expect(clearStalePreviewCookies("99")).toEqual(["12"]);
    expect(document.cookie).not.toContain("view_as_12");
  });

  it("leaves a preview another tab is still using alone", () => {
    // Cookies are shared across tabs, so an unconditional sweep would end that tab's preview the
    // moment this one opened a different course.
    document.cookie = `view_as_12=${profileId}~34~someothertab; path=/`;
    expect(clearStalePreviewCookies("99")).toEqual([]);
    expect(document.cookie).toContain("view_as_12");
  });

  it("leaves the course currently being rendered to the provider's own scope check", () => {
    const tabId = getTabId();
    document.cookie = `view_as_12=${profileId}~34~${tabId}; path=/`;
    // Inside course 12 the current path decides, and it may well be inside the preview.
    expect(clearStalePreviewCookies("12")).toEqual([]);
    expect(document.cookie).toContain("view_as_12");
  });

  it("never touches a course-wide enrolled-student target", () => {
    document.cookie = `view_as_12=${otherProfile}; path=/`;
    expect(clearStalePreviewCookies("99")).toEqual([]);
    expect(document.cookie).toContain("view_as_12");
  });

  it("cleans up a scoped cookie that carries no tab id", () => {
    document.cookie = `view_as_12=${profileId}~34; path=/`;
    expect(clearStalePreviewCookies("99")).toEqual(["12"]);
    expect(document.cookie).not.toContain("view_as_12");
  });
});
