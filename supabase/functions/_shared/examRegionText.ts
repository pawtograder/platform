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
  // Banded total order: group into ~0.02-tall rows (top-to-bottom), then left-to-right.
  // The pairwise `Math.abs(a.y-b.y) > 0.02 ? ... : ...` form is non-transitive, so it yields
  // engine-defined ordering for words clustered within a row.
  inside.sort((a, b) => {
    const band = Math.round(a.y / 0.02) - Math.round(b.y / 0.02);
    return band !== 0 ? band : a.x - b.x;
  });
  return inside
    .map((w) => w.text)
    .join(" ")
    .trim();
}
