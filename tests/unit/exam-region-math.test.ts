/**
 * @jest-environment node
 */

import { boxCenterInRegion, cropAspect, wordsInRegion, type WordBox } from "@/lib/exam/regionMath";

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

describe("cropAspect", () => {
  // What finalize writes for a US Letter page rendered at scale 2 (index.ts, pages[].width/height).
  const LETTER = { width: 1224, height: 1584 };

  it("uses the page's pixel size, not the bare ratio of the two fractions", () => {
    // A band 80% of the page wide and 20% tall covers 979.2 x 316.8 real pixels.
    const region = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };
    expect(cropAspect(region, LETTER)).toBeCloseTo(979.2 / 316.8, 5);
  });

  it("is narrower than the uncorrected ratio by exactly the page's own aspect", () => {
    // This is the bug: the old code returned region.width / region.height, which is too wide
    // by pageHeight / pageWidth = 1584 / 1224 = 1.294, so every crop looked stretched.
    const region = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };
    const uncorrected = region.width / region.height;
    expect(uncorrected / cropAspect(region, LETTER)).toBeCloseTo(1584 / 1224, 5);
  });

  it("returns a square for a region that covers the same pixels each way", () => {
    // 0.2 of 1224 = 244.8px wide, and 244.8 / 1584 = 0.1545 of the height.
    const region = { x: 0.1, y: 0.1, width: 0.2, height: 244.8 / 1584 };
    expect(cropAspect(region, LETTER)).toBeCloseTo(1, 5);
  });

  it("falls back to the uncorrected ratio when the page size is unknown", () => {
    // Artifacts written before finalize recorded pages[].width/height render as they do today.
    const region = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };
    expect(cropAspect(region, undefined)).toBe(4);
    expect(cropAspect(region, { width: 0, height: 0 })).toBe(4);
  });

  it("falls back to 4 for a degenerate region rather than collapsing the box", () => {
    expect(cropAspect({ x: 0, y: 0, width: 0.5, height: 0 }, LETTER)).toBe(4);
    expect(cropAspect({ x: 0, y: 0, width: 0, height: 0.5 }, LETTER)).toBe(4);
  });
});
