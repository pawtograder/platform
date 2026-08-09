import { isSelfViewAsScope } from "@/lib/viewAs";

/**
 * The scope predicate is the whole of the #892 fix: the server (getEffectiveCourseIdentity) and the
 * client (ClassProfileProvider) both decide whether staff self view-as still applies from it, and
 * they have to agree. A path that wrongly reads as in-scope puts the synthetic student identity
 * back on pages that cannot serve it; one that wrongly reads as out-of-scope drops staff out of the
 * Test Assignment preview they just entered.
 */
describe("isSelfViewAsScope", () => {
  it("covers an assignment and everything beneath it", () => {
    expect(isSelfViewAsScope("/course/12/assignments/34", 12)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/", 12)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/submissions/56", 12)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments/34/submissions/56/files", 12)).toBe(true);
  });

  it("excludes the assignments list, which is the page that came back empty", () => {
    expect(isSelfViewAsScope("/course/12/assignments", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/", 12)).toBe(false);
  });

  it("excludes the rest of the course", () => {
    expect(isSelfViewAsScope("/course/12", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/gradebook", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/discussion", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/office-hours", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/manage/assignments/34", 12)).toBe(false);
    expect(isSelfViewAsScope("/", 12)).toBe(false);
  });

  it("is scoped to the course the cookie belongs to", () => {
    expect(isSelfViewAsScope("/course/13/assignments/34", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34", "12")).toBe(true);
  });

  it("requires a numeric assignment segment, so sibling routes do not qualify", () => {
    expect(isSelfViewAsScope("/course/12/assignments/new", 12)).toBe(false);
    expect(isSelfViewAsScope("/course/12/assignments/34x", 12)).toBe(false);
  });

  it("ignores query strings and fragments", () => {
    expect(isSelfViewAsScope("/course/12/assignments/34?tab=results", 12)).toBe(true);
    expect(isSelfViewAsScope("/course/12/assignments?q=lab", 12)).toBe(false);
  });
});
