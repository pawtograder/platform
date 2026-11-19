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
  // Rows are words whose center lines sit within half a word height of the row's average center
  // line, using the smaller of the two heights so a tall box cannot pull in the line below. Grouping
  // by distance rather than by fixed 0.02 bands keeps a line whole wherever it sits on the page, and
  // centers rather than top edges keep a tilted word's taller box on the line it belongs to (#1292).
  // Marks under half the median height (punctuation, quote marks) sit at the baseline or the top of
  // a line rather than on its center line, so they join the row whose span is nearest them instead.
  const centerY = (w: WordBox) => w.y + w.height / 2;
  const heights = inside.map((w) => w.height).sort((a, b) => a - b);
  const isMark = (w: WordBox) => w.height < heights[Math.floor(heights.length / 2)] / 2;
  const rows: { words: WordBox[]; centerSum: number; minHeight: number; top: number; bottom: number }[] = [];
  for (const w of inside.filter((w) => !isMark(w)).sort((a, b) => centerY(a) - centerY(b))) {
    const row = rows[rows.length - 1];
    if (row && centerY(w) - row.centerSum / row.words.length <= Math.min(w.height, row.minHeight) / 2) {
      row.words.push(w);
      row.centerSum += centerY(w);
      row.minHeight = Math.min(row.minHeight, w.height);
      row.top = Math.min(row.top, w.y);
      row.bottom = Math.max(row.bottom, w.y + w.height);
    } else {
      rows.push({ words: [w], centerSum: centerY(w), minHeight: w.height, top: w.y, bottom: w.y + w.height });
    }
  }
  // A mark is never the median, so whenever there is one there is a row of words to put it on.
  for (const mark of inside.filter(isMark)) {
    const gap = (row: (typeof rows)[number]) => Math.max(row.top - centerY(mark), centerY(mark) - row.bottom, 0);
    rows.reduce((best, row) => (gap(row) < gap(best) ? row : best)).words.push(mark);
  }
  return rows
    .flatMap((row) => row.words.sort((a, b) => a.x - b.x))
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
