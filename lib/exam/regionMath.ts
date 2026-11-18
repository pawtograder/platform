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
