// Pure geometry helpers shared by the exam grader UI and unit tests.
// The word matching (`wordsInRegion`) is the exam worker's own implementation, re-exported from
// supabase/functions/_shared/examRegionText.ts so there is only one copy (#1188).

import type { NormRect } from "@/supabase/functions/_shared/examRegionText";
export {
  boxCenterInRegion,
  wordsInRegion,
  type NormRect,
  type WordBox
} from "@/supabase/functions/_shared/examRegionText";

/**
 * Aspect ratio (width / height) of the pixels `region` covers on a page that is
 * `page.width` x `page.height` pixels.
 *
 * `region.width` and `region.height` are fractions of *different* page dimensions, so dividing
 * one by the other is not the crop's shape. On the 1224x1584 pages finalize writes, the
 * uncorrected ratio comes out 1584/1224 = 1.294x too wide, which is why every answer crop in
 * the grader view looks stretched. Scale each fraction by the dimension it belongs to first.
 *
 * Falls back to the uncorrected ratio when the page size is unknown, so artifacts written
 * before finalize recorded pages[].width/height render exactly as they do today.
 */
export function cropAspect(region: NormRect, page?: { width?: number; height?: number }): number {
  // Matches the previous component default for a degenerate region.
  const FALLBACK = 4;
  if (!(region.width > 0) || !(region.height > 0)) return FALLBACK;
  const pageWidth = page?.width ?? 0;
  const pageHeight = page?.height ?? 0;
  if (pageWidth > 0 && pageHeight > 0) {
    return (region.width * pageWidth) / (region.height * pageHeight);
  }
  return region.width / region.height;
}

/** How tall a short region written on a line grows to, as a fraction of the page (about 0.4 inch on Letter). */
const MIN_REGION_HEIGHT = 0.035;
/** Room added on every side, for circles and descenders, as a fraction of the page. */
const REGION_MARGIN = 0.01;

/**
 * Makes Auto-extract's regions cover where a student writes, not just what's printed (#1371).
 *
 * Gemini boxes a line answer as a strip about 0.02 of the page tall sitting on the line, and a
 * true/false answer as a box around the printed "T F". Students write above the line and circle
 * outside the letters, so the crop cut off the handwriting, and OCR, which keeps a word only if its
 * center is in the region, dropped what was above the strip.
 *
 * Every region gets REGION_MARGIN on each side. A region `writtenOnALine` says is written on, and
 * shorter than MIN_REGION_HEIGHT, also grows upward to it, since handwriting sits on the line. Others,
 * like a circled true/false, don't grow upward: there's often a heading just above them, and printed
 * words inside a region get read as part of the answer. No edge grows past halfway to the nearest
 * region it faces on the same page, so stacked rows meet in the middle instead of overlapping, and
 * none grows off the page. A tall region, like a drawn box, only gets the margin.
 */
export function padRegions<T extends NormRect & { page_number: number }>(
  regions: T[],
  writtenOnALine: (region: T) => boolean
): T[] {
  return regions.map((region) => {
    const bottom = region.y + region.height;
    const right = region.x + region.width;
    const grownTop = writtenOnALine(region) ? Math.min(region.y, bottom - MIN_REGION_HEIGHT) : region.y;
    let top = grownTop - REGION_MARGIN;
    let newBottom = bottom + REGION_MARGIN;
    let left = region.x - REGION_MARGIN;
    let newRight = right + REGION_MARGIN;

    for (const other of regions) {
      if (other === region || other.page_number !== region.page_number) continue;
      const otherBottom = other.y + other.height;
      const otherRight = other.x + other.width;
      const sideBySide = other.y < bottom && otherBottom > region.y;
      const stacked = other.x < right && otherRight > region.x;
      if (stacked && otherBottom <= region.y) top = Math.max(top, (otherBottom + region.y) / 2);
      if (stacked && other.y >= bottom) newBottom = Math.min(newBottom, (bottom + other.y) / 2);
      if (sideBySide && otherRight <= region.x) left = Math.max(left, (otherRight + region.x) / 2);
      if (sideBySide && other.x >= right) newRight = Math.min(newRight, (right + other.x) / 2);
    }

    top = Math.max(0, top);
    left = Math.max(0, left);
    newBottom = Math.min(1, newBottom);
    newRight = Math.min(1, newRight);
    return { ...region, x: left, y: top, width: newRight - left, height: newBottom - top };
  });
}
