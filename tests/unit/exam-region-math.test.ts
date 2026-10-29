/**
 * @jest-environment node
 */

import { boxCenterInRegion, wordsInRegion, type WordBox } from "@/lib/exam/regionMath";

describe("boxCenterInRegion", () => {
  const region = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }; // covers 0.2..0.6
  it("includes a box whose center is inside", () => {
    expect(boxCenterInRegion({ x: 0.35, y: 0.35, width: 0.05, height: 0.05 }, region)).toBe(true);
  });
  it("excludes a box whose center is outside", () => {
    expect(boxCenterInRegion({ x: 0.7, y: 0.7, width: 0.05, height: 0.05 }, region)).toBe(false);
  });
  it("uses the center, not the corner", () => {
    // top-left corner inside region but center (0.62) outside
    expect(boxCenterInRegion({ x: 0.58, y: 0.3, width: 0.08, height: 0.02 }, region)).toBe(false);
  });
});

describe("wordsInRegion", () => {
  const region = { x: 0, y: 0, width: 0.5, height: 1 }; // left half
  const words: WordBox[] = [
    { text: "world", x: 0.1, y: 0.5, width: 0.1, height: 0.03 },
    { text: "hello", x: 0.1, y: 0.1, width: 0.1, height: 0.03 },
    { text: "RIGHT", x: 0.8, y: 0.1, width: 0.1, height: 0.03 }
  ];
  it("keeps only words inside the region", () => {
    const text = wordsInRegion(words, region);
    expect(text).not.toContain("RIGHT");
  });
  it("returns words in top-to-bottom reading order", () => {
    expect(wordsInRegion(words, region)).toBe("hello world");
  });
  it("returns empty string when nothing matches", () => {
    expect(wordsInRegion(words, { x: 0.9, y: 0.9, width: 0.05, height: 0.05 })).toBe("");
  });
});
