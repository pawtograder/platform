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
  // Each case is one printed line that has to come back left to right.
  it.each<[string, WordBox[], string]>([
    [
      // Centers 0.311 and 0.309 straddle the old 0.31 band edge; catches rows cut at fixed positions.
      "centers either side of a fixed band edge",
      [
        { text: "right", x: 0.25, y: 0.299, width: 0.05, height: 0.02 },
        { text: "left", x: 0.05, y: 0.301, width: 0.05, height: 0.02 }
      ],
      "left right"
    ],
    [
      // Same center line, top edges at different heights; catches rows keyed on the top edge (#1292).
      "boxes of different heights on one center line",
      [
        { text: "long", x: 0.25, y: 0.281, width: 0.15, height: 0.04 },
        { text: "short", x: 0.05, y: 0.291, width: 0.05, height: 0.02 }
      ],
      "short long"
    ],
    [
      // Centers rise 0.004 across the line; catches a tolerance so tight that OCR jitter splits it.
      "a line drifting slightly upward",
      [
        { text: "d", x: 0.4, y: 0.296, width: 0.05, height: 0.02 },
        { text: "b", x: 0.2, y: 0.2987, width: 0.05, height: 0.02 },
        { text: "a", x: 0.1, y: 0.3, width: 0.05, height: 0.02 },
        { text: "c", x: 0.3, y: 0.2973, width: 0.05, height: 0.02 }
      ],
      "a b c d"
    ]
  ])("keeps one line in order: %s", (_name, line, text) => {
    expect(wordsInRegion(line, region)).toBe(text);
  });
  // Short glyphs (punctuation, quote marks) sit inside a line without sharing its center line.
  it.each<[string, WordBox[], string]>([
    [
      // All three boxes end at y 0.311; catches a baseline comma forced onto its own row.
      "a comma on the baseline",
      [
        { text: "second", x: 0.25, y: 0.291, width: 0.05, height: 0.02 },
        { text: ",", x: 0.18, y: 0.307, width: 0.01, height: 0.004 },
        { text: "first", x: 0.1, y: 0.291, width: 0.05, height: 0.02 }
      ],
      "first , second"
    ],
    [
      // Hangs from the top of line two, nearer line one's bottom; catches measuring only the edge below.
      "a quote mark at the top of the line",
      [
        { text: "s", x: 0.25, y: 0.315, width: 0.05, height: 0.02 },
        { text: "'", x: 0.18, y: 0.315, width: 0.01, height: 0.006 },
        { text: "it", x: 0.1, y: 0.315, width: 0.05, height: 0.02 },
        { text: "b", x: 0.3, y: 0.291, width: 0.05, height: 0.02 },
        { text: "a", x: 0.1, y: 0.291, width: 0.05, height: 0.02 }
      ],
      "a b it ' s"
    ],
    [
      // Nothing full-size to attach to; catches dropping marks when no row has a word.
      "a region holding only punctuation",
      [
        { text: "!", x: 0.25, y: 0.3, width: 0.01, height: 0.004 },
        { text: "?", x: 0.1, y: 0.3, width: 0.01, height: 0.004 }
      ],
      "? !"
    ]
  ])("keeps short glyphs on their line: %s", (_name, line, text) => {
    expect(wordsInRegion(line, region)).toBe(text);
  });
  it("keeps lines 1.2 word heights apart separate", () => {
    // Line two's words sit between line one's; catches a tolerance loose enough to merge lines.
    const lines: WordBox[] = [
      { text: "d", x: 0.35, y: 0.324, width: 0.05, height: 0.02 },
      { text: "b", x: 0.3, y: 0.3, width: 0.05, height: 0.02 },
      { text: "c", x: 0.15, y: 0.324, width: 0.05, height: 0.02 },
      { text: "a", x: 0.1, y: 0.3, width: 0.05, height: 0.02 }
    ];
    expect(wordsInRegion(lines, region)).toBe("a b c d");
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

  it("uses the page it is given, not Letter (A4 at scale 2 is 1191x1684)", () => {
    // Replaces an algebraic rearrangement of the test above, which added no coverage: Aryan showed
    // on review that a cropAspect hardcoding Letter -- (region.width * 1224) / (region.height * 1584)
    // -- passed all 14 tests, because every one of them used the Letter page. rasterizePdf renders
    // each scanned page at 2x its PDF size, so an A4 scan arrives at 1191x1684 and that mutant is
    // wrong for it.
    const region = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };
    expect(cropAspect(region, { width: 1191, height: 1684 })).toBeCloseTo((0.8 * 1191) / (0.2 * 1684), 5);
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
