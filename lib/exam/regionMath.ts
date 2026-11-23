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
 * words inside a region get read as part of the answer. A tall region, like a drawn box, only gets
 * the margin.
 *
 * Two regions on the same page meet halfway across the gap between them instead of overlapping:
 * across it when they're side by side or diagonal, since sideways growth is only the margin, and
 * up or down when one is above the other. An edge doesn't grow toward a region it already overlaps.
 * Nothing grows off the page, and the page edge wins over MIN_REGION_HEIGHT, so a strip at the very
 * top of the page comes out shorter.
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
      if (otherRight <= region.x) left = Math.max(left, (otherRight + region.x) / 2);
      else if (other.x >= right) newRight = Math.min(newRight, (right + other.x) / 2);
      else if (otherBottom <= region.y) top = Math.max(top, (otherBottom + region.y) / 2);
      else if (other.y >= bottom) newBottom = Math.min(newBottom, (bottom + other.y) / 2);
      else {
        // Already overlapping: no edge grows toward the other region.
        if (other.y < region.y) top = Math.max(top, region.y);
        if (otherBottom > bottom) newBottom = Math.min(newBottom, bottom);
        if (other.x < region.x) left = Math.max(left, region.x);
        if (otherRight > right) newRight = Math.min(newRight, right);
      }
    }

    top = Math.max(0, top);
    left = Math.max(0, left);
    newBottom = Math.min(1, newBottom);
    newRight = Math.min(1, newRight);
    return { ...region, x: left, y: top, width: newRight - left, height: newBottom - top };
  });
}

/**
 * The width, in CSS px, that the grader view lays a whole scanned page out at.
 *
 * Only the ratio to the page matters, so this is not tied to any scan resolution: a 1224px scan
 * and a 1700px scan of the same sheet render identically.
 */
export const CROP_PAGE_RENDER_WIDTH = 1000;

/**
 * Rendered width in px for a crop of `region`, at the one zoom every crop on a page shares.
 *
 * #1263: the grader view fixed each crop's HEIGHT and let its width follow the aspect ratio, so
 * the rendered scale was `height / (region.height * page.height)`. That is a function of the box
 * the instructor drew: a short wide box came out magnified, a tall one came out a thumbnail. On
 * the seeded Midterm Exam 1 the numeric and true/false answers filled the panel while the
 * free-text answers, the ones that actually need reading, rendered smallest. A TA working down
 * 200 submissions got a different zoom on every row.
 *
 * Sizing from the region's width instead makes the scale `CROP_PAGE_RENDER_WIDTH / page.width`,
 * which is the same for every region on the page whatever its shape. `region.width` is already a
 * fraction of the page width, so the page's pixel size does not enter into it; `cropAspect` still
 * supplies the shape, and still needs the page, because width and height are fractions of
 * different dimensions.
 *
 * A region the instructor drew small therefore renders small. That is the point: it holds less.
 * "View original page" is still there for reading one closely.
 */
export function cropDisplayWidth(region: NormRect, pageRenderWidth: number = CROP_PAGE_RENDER_WIDTH): number {
  // A degenerate region has no width to scale from; fall back to the full page rather than 0px,
  // which would render an invisible box with no hint that anything is wrong.
  if (!(region.width > 0)) return pageRenderWidth;
  return Math.round(Math.min(1, region.width) * pageRenderWidth);
}
