/**
 * Which OCR words fall inside an exam region, in reading order: the one implementation (#1188).
 *
 * The exam worker's `finalize` runs it through examVision.ts, and the Next.js side (the exam seeder
 * and the Jest tests) reaches it through lib/exam/regionMath.ts. Before this module the two sides
 * each kept a copy "in sync" by hand, and only the copy that never ran in the worker had tests.
 *
 * Keep this file free of imports and Deno globals. Deno imports it as `./examRegionText.ts` and
 * Node as `@/supabase/functions/_shared/examRegionText`, and anything Deno-only here breaks
 * `next build` (see stepTimings.ts).
 */

export type NormRect = { x: number; y: number; width: number; height: number };
export type WordBox = NormRect & { text: string };

/** True when the center of `box` falls inside `region` (all coords normalized 0..1). */
export function boxCenterInRegion(box: NormRect, region: NormRect): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height;
}

/** Text of the words whose center falls inside `region` (reading order: top-to-bottom, left-to-right). */
export function wordsInRegion(words: WordBox[], region: NormRect): string {
  const inside = words.filter((w) => boxCenterInRegion(w, region));
  const centerY = (w: WordBox) => w.y + w.height / 2;
  // Marks (punctuation, quote marks) sit at the baseline or the top of a line rather than on its
  // center line, so they join the row nearest them instead of starting one. A mark is a word under
  // half the height of a word it sits within, give or take half its own height, judged word by word
  // rather than against the region's median, which punctuation can outnumber the words in. Smaller
  // words near no taller word (a line of smaller text) are not marks and keep rows of their own.
  const gap = (span: { top: number; bottom: number }, y: number) => Math.max(span.top - y, y - span.bottom, 0);
  const isMark = (w: WordBox) =>
    inside.some(
      (t) => t.height > 2 * w.height && gap({ top: t.y, bottom: t.y + t.height }, centerY(w)) <= w.height / 2
    );
  // Rows are words whose center lines sit within half a word height of the row's average center
  // line, using the smaller of the two heights so a tall box cannot pull in the line below. Grouping
  // by distance rather than by fixed 0.02 bands keeps a line whole wherever it sits on the page, and
  // centers rather than top edges keep a tilted word's taller box on the line it belongs to (#1292).
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
  // A mark sits by a taller word, and the tallest of any such chain is not a mark, so rows is not empty.
  for (const mark of inside.filter(isMark)) {
    rows.reduce((best, row) => (gap(row, centerY(mark)) < gap(best, centerY(mark)) ? row : best)).words.push(mark);
  }
  return rows
    .flatMap((row) => row.words.sort((a, b) => a.x - b.x))
    .map((w) => w.text)
    .join(" ")
    .trim();
}
