/**
 * @jest-environment node
 */

import { boxCenterInRegion, cropAspect, padRegions, wordsInRegion, type NormRect } from "@/lib/exam/regionMath";
import { wordsInRegion as sharedWordsInRegion } from "@/supabase/functions/_shared/examRegionText";

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

// wordsInRegion's behavior is tested in supabase/functions/_shared/examVision.test.ts (Deno, run by
// CI deno-unit-tests). This file only checks that regionMath re-exports that one implementation (#1188).
describe("wordsInRegion", () => {
  it("is the worker's implementation, not a copy", () => {
    expect(wordsInRegion).toBe(sharedWordsInRegion);
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

describe("padRegions", () => {
  type PageRect = NormRect & { page_number: number; circled?: boolean };
  const r = (x: number, y: number, width: number, height: number, page_number = 1, circled = false): PageRect => ({
    x,
    y,
    width,
    height,
    page_number,
    circled
  });
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const rects = (regions: PageRect[]) =>
    padRegions(regions, (region) => !region.circled).map(({ x, y, width, height }) => ({
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height)
    }));

  it.each<[string, PageRect[], NormRect[]]>([
    // The bug in #1371: a line answer came back as a 0.02 strip on the line, so the crop cut off
    // the handwriting above it and OCR dropped the words whose center was above the strip.
    [
      "grows a line answer upward, with a margin",
      [r(0.5, 0.38, 0.3, 0.02)],
      [{ x: 0.49, y: 0.355, width: 0.32, height: 0.055 }]
    ],
    // Catches growing into the next row: line answers 0.035 apart would overlap, and one answer's
    // handwriting would be read as part of the next. They meet halfway instead.
    [
      "stops halfway to the region above or below",
      [r(0.5, 0.36, 0.3, 0.02), r(0.5, 0.395, 0.3, 0.02)],
      [
        { x: 0.49, y: 0.335, width: 0.32, height: 0.0525 },
        { x: 0.49, y: 0.3875, width: 0.32, height: 0.0375 }
      ]
    ],
    // Catches growing a circled true/false upward. On the #1371 quiz that put the heading's printed
    // "True" inside 1(a), where OCR would read it as the answer.
    [
      "only adds a margin to a circled answer",
      [r(0.1, 0.183, 0.057, 0.021, 1, true)],
      [{ x: 0.09, y: 0.173, width: 0.077, height: 0.041 }]
    ],
    // Catches stopping at a region that isn't above or below: this one is in the other column.
    [
      "ignores a region in another column",
      [r(0.5, 0.38, 0.3, 0.02), r(0.1, 0.3, 0.2, 0.02)],
      [
        { x: 0.49, y: 0.355, width: 0.32, height: 0.055 },
        { x: 0.09, y: 0.275, width: 0.22, height: 0.055 }
      ]
    ],
    // Catches comparing regions on different pages.
    [
      "ignores a region on another page",
      [r(0.5, 0.36, 0.3, 0.02, 1), r(0.5, 0.395, 0.3, 0.02, 2)],
      [
        { x: 0.49, y: 0.335, width: 0.32, height: 0.055 },
        { x: 0.49, y: 0.37, width: 0.32, height: 0.055 }
      ]
    ],
    // Catches coordinates off the page, and resizing a drawn box on a boxed template, which only
    // gets the margin.
    [
      "stays on the page and only adds a margin to a tall box",
      [r(0, 0, 0.2, 0.02), r(0.5, 0.5, 0.3, 0.2)],
      [
        { x: 0, y: 0, width: 0.21, height: 0.03 },
        { x: 0.49, y: 0.49, width: 0.32, height: 0.22 }
      ]
    ]
  ])("%s", (_name, regions, expected) => {
    expect(rects(regions)).toEqual(expected);
  });
});
