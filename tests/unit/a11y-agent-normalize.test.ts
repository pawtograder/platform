/**
 * Wave-4 unit tests: phrase normalization + template matching, pinned by the
 * REAL cross-seed logs captured in Spike S3 (agent/__fixtures__/s3/).
 */
import fs from "fs";
import path from "path";
import { normalizePhrase, templateMatches, type Bindings } from "../../tools/a11y-judge/agent/normalize";

const FIXTURES = path.resolve(__dirname, "../../tools/a11y-judge/agent/__fixtures__/s3");

function load(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

describe("normalizePhrase", () => {
  const bindings: Bindings = { className: "Algorithms Fundamentals", courseId: "503" };

  it("substitutes seed bindings into placeholders (longest value first)", () => {
    expect(normalizePhrase("link, Algorithms Fundamentals", bindings)).toBe("link, {{classname}}".toLowerCase());
  });

  it("drops realtime noise phrases entirely", () => {
    expect(normalizePhrase("Realtime connection status: All realtime connections active", bindings)).toBeNull();
  });

  it("classifies numbers, dates, and times", () => {
    expect(normalizePhrase("Due Jul 15, 2026 at 11:59 PM — 5 of 10 points", {})).toBe(
      "due {{date}} at {{time}} — {{number}} of {{number}} points"
    );
  });

  it("makes the S3 cross-seed fixture logs identical", () => {
    const logA: string[] = load("survey-spoken-log.a.json");
    const logB: string[] = load("survey-spoken-log.b.json");
    const bindA: Bindings = load("bindings.a.json");
    const bindB: Bindings = load("bindings.b.json");
    const normA = logA.map((p) => normalizePhrase(p, bindA)).filter((p) => p !== null);
    const normB = logB.map((p) => normalizePhrase(p, bindB)).filter((p) => p !== null);
    expect(normA).toEqual(normB);
    expect(normA.length).toBeGreaterThan(100);
  });
});

describe("templateMatches", () => {
  it("matches a recorded template against a live phrase under fresh bindings", () => {
    const recorded = normalizePhrase("heading, Agent Assignment, level 2", { assignmentName: "Agent Assignment" })!;
    expect(
      templateMatches(recorded, "heading, Agent Assignment, level 2", { assignmentName: "Agent Assignment" })
    ).toBe(true);
  });

  it("lets {{number}} match any number, but not different text", () => {
    const template = normalizePhrase("radio, Just right, not checked, position 2, set size 3", {})!;
    expect(templateMatches(template, "radio, Just right, not checked, position 7, set size 9", {})).toBe(true);
    expect(templateMatches(template, "radio, Too slow, not checked, position 2, set size 3", {})).toBe(false);
  });

  it("never matches noise phrases", () => {
    expect(templateMatches("anything", "Realtime connection status: connecting", {})).toBe(false);
  });
});
