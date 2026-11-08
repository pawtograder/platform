// Pure geometry helpers shared by the exam grader UI and unit tests.
// (A Deno copy of `wordsInRegion` also lives in supabase/functions/_shared/examVision.ts;
// keep the two in sync.)

export type NormRect = { x: number; y: number; width: number; height: number };
export type WordBox = NormRect & { text: string };

/** True when the center of `box` falls inside `region` (all coords normalized 0..1). */
export function boxCenterInRegion(box: NormRect, region: NormRect): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height;
}

/** Text of the words whose center falls inside `region`, in reading order. */
export function wordsInRegion(words: WordBox[], region: NormRect): string {
  const inside = words.filter((w) => boxCenterInRegion(w, region));
  // Banded total order: group into ~0.02-tall rows (top-to-bottom), then left-to-right.
  // The pairwise `Math.abs(a.y-b.y) > 0.02 ? ... : ...` form is non-transitive, so it yields
  // engine-defined (and potentially inconsistent) ordering for words clustered within a row.
  inside.sort((a, b) => {
    const band = Math.round(a.y / 0.02) - Math.round(b.y / 0.02);
    return band !== 0 ? band : a.x - b.x;
  });
  return inside
    .map((w) => w.text)
    .join(" ")
    .trim();
}

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
