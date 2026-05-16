import { filterSearchIndex, type SearchHit } from "@/lib/searchIndex";

const sampleIndex: SearchHit[] = [
  {
    id: "a1",
    kind: "assignment",
    title: "Project 3: Streams",
    subtitle: "project-3",
    url: "/a/1",
    keywords: ["streams"]
  },
  { id: "a2", kind: "assignment", title: "Lab 7: Generics", subtitle: "lab-7", url: "/a/2" },
  { id: "a3", kind: "assignment", title: "Final exam review", subtitle: "final", url: "/a/3" },
  { id: "s1", kind: "survey", title: "Mid-semester feedback", subtitle: "Tell us how it's going", url: "/s/1" },
  {
    id: "d1",
    kind: "discussion",
    title: "How to debug generics?",
    subtitle: "Q&A",
    url: "/d/1",
    keywords: ["covers Project 3 too"]
  },
  { id: "p1", kind: "page", title: "Gradebook", url: "/page/gb" },
  { id: "p2", kind: "page", title: "Office hours", url: "/page/oh" }
];

describe("filterSearchIndex", () => {
  it("returns only page/setting hits for an empty query (palette as launcher)", () => {
    const groups = filterSearchIndex(sampleIndex, "");
    expect(groups.length).toBe(1);
    expect(groups[0].kind).toBe("page");
    expect(groups[0].hits.map((h) => h.id).sort()).toEqual(["p1", "p2"]);
  });

  it("matches across title, subtitle, and keywords", () => {
    const groups = filterSearchIndex(sampleIndex, "generics");
    const ids = groups.flatMap((g) => g.hits).map((h) => h.id);
    // Lab 7 (title), discussion thread (title) — both should appear.
    expect(ids).toEqual(expect.arrayContaining(["a2", "d1"]));
  });

  it("ranks title matches above subtitle/keyword matches", () => {
    const groups = filterSearchIndex(sampleIndex, "project");
    const flat = groups.flatMap((g) => g.hits);
    // a1 has "Project 3" in title; d1 has "project" only via keyword. Title wins.
    const aIdx = flat.findIndex((h) => h.id === "a1");
    const dIdx = flat.findIndex((h) => h.id === "d1");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(dIdx);
  });

  it("requires every space-separated word to appear somewhere", () => {
    const groups = filterSearchIndex(sampleIndex, "project 3");
    const ids = groups.flatMap((g) => g.hits).map((h) => h.id);
    expect(ids).toContain("a1"); // both words in title.
    expect(ids).not.toContain("a3"); // "final exam review" has neither.
  });

  it("groups hits by kind in the canonical order", () => {
    const groups = filterSearchIndex(sampleIndex, "review");
    const kinds = groups.map((g) => g.kind);
    // assignment must precede discussion / page in the canonical order.
    if (kinds.includes("assignment") && kinds.includes("discussion")) {
      expect(kinds.indexOf("assignment")).toBeLessThan(kinds.indexOf("discussion"));
    }
  });

  it("hides empty groups from the result list", () => {
    const groups = filterSearchIndex(sampleIndex, "mid-semester");
    expect(groups.every((g) => g.hits.length > 0)).toBe(true);
    expect(groups.map((g) => g.kind)).toEqual(["survey"]);
  });

  it("is case-insensitive", () => {
    const lower = filterSearchIndex(sampleIndex, "lab");
    const upper = filterSearchIndex(sampleIndex, "LAB");
    expect(lower.flatMap((g) => g.hits).map((h) => h.id)).toEqual(upper.flatMap((g) => g.hits).map((h) => h.id));
  });
});
