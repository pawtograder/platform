/**
 * @jest-environment node
 */

import {
  boxCenterInRegion,
  CROP_PAGE_RENDER_WIDTH,
  cropAspect,
  cropDisplayWidth,
  padRegions,
  wordsInRegion,
  type NormRect,
  type WordBox
} from "@/lib/exam/regionMath";
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
    ],
    // Catches growing through a region that already overlaps: the halfway stop only applied with a
    // gap between them, so the lower line grew up to 0.115 and took in most of the prompt above it.
    [
      "doesn't grow into a region it already overlaps",
      [r(0.5, 0.1, 0.3, 0.06), r(0.5, 0.15, 0.3, 0.01)],
      [
        { x: 0.49, y: 0.09, width: 0.32, height: 0.08 },
        { x: 0.49, y: 0.15, width: 0.32, height: 0.02 }
      ]
    ],
    // Catches overlapping corners: regions with a small gap both across and down were neither side
    // by side nor stacked, so nothing stopped their margins meeting at the corner.
    [
      "diagonal neighbors meet halfway across their side gap",
      [r(0.1, 0.3, 0.2, 0.02, 1, true), r(0.305, 0.335, 0.2, 0.02, 1, true)],
      [
        { x: 0.09, y: 0.29, width: 0.2125, height: 0.04 },
        { x: 0.3025, y: 0.325, width: 0.2125, height: 0.04 }
      ]
    ],
    // Catches a negative height: stopping at the midpoint of a box this region sits inside puts the
    // top below the bottom.
    [
      "a region inside a drawn box stays as drawn",
      [r(0.4, 0.3, 0.4, 0.3), r(0.5, 0.4, 0.1, 0.01)],
      [
        { x: 0.39, y: 0.29, width: 0.42, height: 0.32 },
        { x: 0.5, y: 0.4, width: 0.1, height: 0.01 }
      ]
    ]
  ])("%s", (_name, regions, expected) => {
    expect(rects(regions)).toEqual(expected);
  });
});

describe("cropDisplayWidth (#1263)", () => {
  const LETTER = { width: 1224, height: 1584 };
  // The two shapes from the report: Q1 a wide short box, Q2 a tall narrow one.
  const WIDE_SHORT: NormRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.05 };
  const TALL_NARROW: NormRect = { x: 0.1, y: 0.3, width: 0.15, height: 0.4 };

  /** Rendered px per source px: what "zoom" means here. */
  const scale = (region: NormRect) => cropDisplayWidth(region) / (region.width * LETTER.width);

  it("renders two differently shaped regions at the same zoom", () => {
    expect(scale(WIDE_SHORT)).toBeCloseTo(scale(TALL_NARROW), 10);
  });

  it("would not have, when the height was what was fixed", () => {
    // The old sizing, verbatim: width = round(height * cropAspect(region, page)) with height=120.
    // Kept here because the point of #1263 is that this was shape-dependent, and a test that only
    // checked the new behavior would pass just as happily against the bug.
    const oldScale = (region: NormRect) => Math.round(120 * cropAspect(region, LETTER)) / (region.width * LETTER.width);
    expect(oldScale(WIDE_SHORT) / oldScale(TALL_NARROW)).toBeGreaterThan(5);
  });

  it("is the region's share of the page width", () => {
    expect(cropDisplayWidth({ x: 0, y: 0, width: 0.5, height: 0.2 }, 1000)).toBe(500);
    expect(cropDisplayWidth({ x: 0, y: 0, width: 1, height: 0.2 }, 1000)).toBe(1000);
  });

  it("does not move when the same sheet is scanned at a different resolution", () => {
    // region coordinates are normalized, so a 200dpi rescan of the same page is the same call.
    expect(cropDisplayWidth(WIDE_SHORT)).toBe(cropDisplayWidth(WIDE_SHORT));
    expect(scale(WIDE_SHORT)).toBeCloseTo(CROP_PAGE_RENDER_WIDTH / LETTER.width, 10);
  });

  it("falls back to the full page width rather than 0px for a degenerate region", () => {
    expect(cropDisplayWidth({ x: 0, y: 0, width: 0, height: 0.2 }, 1000)).toBe(1000);
    expect(cropDisplayWidth({ x: 0, y: 0, width: Number.NaN, height: 0.2 }, 1000)).toBe(1000);
  });

  it("clamps a region wider than its page", () => {
    expect(cropDisplayWidth({ x: 0, y: 0, width: 1.4, height: 0.2 }, 1000)).toBe(1000);
  });
});
