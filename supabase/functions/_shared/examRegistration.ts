// Lines a scan page up with its template page (#1292).
//
// The printed text on a scan (question prompts, headers, instructions) is also on the template, so
// pairing those words gives a rotation, scale and shift from template pixels to scan pixels. The
// worker uses it in both directions: template regions onto the scan for the identity read, and
// scan words back into template space before wordsInRegion reads an answer.
//
// Only word centers are used. The provider stores a straight box around each (possibly rotated)
// word, and the center of that box is still the word's true center, so OCR stored before this
// change registers just as well.
//
// Everything is fitted in pixels. A rotation in normalized 0..1 units is not a rotation on a
// non-square page, and the scan is usually a different DPI from the template.

import type { NormRect, WordBox } from "./examVision.ts";

/** Fewest paired words a page needs before its fit is trusted. */
export const MIN_PAIRS = 6;
/** Shortest word used for pairing; "a", "of" and "is" repeat too often to place a page. */
const MIN_WORD_LENGTH = 3;
/** A pair agrees with a fit when its scan center is within this share of the scan's diagonal. */
const INLIER_TOLERANCE = 0.01;
/** Share of a page's paired words its fit has to agree with. */
const MIN_AGREEING_SHARE = 0.6;
/** Share of the paired words' spread, across and down the page, the agreeing words have to cover. */
const MIN_COVERAGE = 0.5;
/** Hypotheses come from pairs among at most this many words, spread through the list. */
const MAX_SEED_WORDS = 40;

export type PageWords = { words: WordBox[]; width: number; height: number };
type Size = { width: number; height: number };
type Point = { x: number; y: number };

type Fit = { a: number; b: number; tx: number; ty: number };

/**
 * Template pixels to scan pixels: u = a*x - b*y + tx, v = b*x + a*y + ty, with the two page sizes
 * that convert to and from normalized coordinates. The rotation is atan2(b, a), the scale hypot(a, b).
 */
export type Registration = Fit & { template: Size; scan: Size };

export type WordPair = { text: string; template: WordBox; scan: WordBox };

function pairKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function uniqueWords(words: WordBox[]): Map<string, WordBox> {
  const seen = new Map<string, WordBox | null>();
  for (const w of words) {
    const key = pairKey(w.text);
    if (key.length < MIN_WORD_LENGTH) continue;
    seen.set(key, seen.has(key) ? null : w);
  }
  const unique = new Map<string, WordBox>();
  for (const [key, w] of seen) if (w) unique.set(key, w);
  return unique;
}

/** Words that appear exactly once on both pages, matched by text ignoring case and punctuation. */
export function pairWords(template: WordBox[], scan: WordBox[]): WordPair[] {
  const onScan = uniqueWords(scan);
  const pairs: WordPair[] = [];
  for (const [text, t] of uniqueWords(template)) {
    const s = onScan.get(text);
    if (s) pairs.push({ text, template: t, scan: s });
  }
  return pairs;
}

function centerPx(w: WordBox, size: Size): Point {
  return { x: (w.x + w.width / 2) * size.width, y: (w.y + w.height / 2) * size.height };
}

function apply(f: Fit, p: Point): Point {
  return { x: f.a * p.x - f.b * p.y + f.tx, y: f.b * p.x + f.a * p.y + f.ty };
}

function centroid(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Least-squares similarity from `from` to `to`. Null when the points are all in one place. */
function fitSimilarity(from: Point[], to: Point[]): Fit | null {
  const m = centroid(from);
  const c = centroid(to);
  let sxx = 0;
  let sa = 0;
  let sb = 0;
  from.forEach((p, i) => {
    const dx = p.x - m.x;
    const dy = p.y - m.y;
    const du = to[i].x - c.x;
    const dv = to[i].y - c.y;
    sxx += dx * dx + dy * dy;
    sa += dx * du + dy * dv;
    sb += dx * dv - dy * du;
  });
  if (sxx < 1e-9) return null;
  const a = sa / sxx;
  const b = sb / sxx;
  return { a, b, tx: c.x - (a * m.x - b * m.y), ty: c.y - (b * m.x + a * m.y) };
}

function span(points: Point[], axis: "x" | "y"): number {
  const values = points.map((p) => p[axis]);
  return Math.max(...values) - Math.min(...values);
}

// Whether one similarity explains the whole page rather than one part of it: a fit that only half
// the words agree with, or that only the top of the page agrees with, would misplace the rest.
function explainsPage(agreeing: Point[], all: Point[]): boolean {
  return (
    agreeing.length >= MIN_AGREEING_SHARE * all.length &&
    span(agreeing, "x") >= MIN_COVERAGE * span(all, "x") &&
    span(agreeing, "y") >= MIN_COVERAGE * span(all, "y")
  );
}

function inliersOf(f: Fit, from: Point[], to: Point[], tolerance: number): number[] {
  const kept: number[] = [];
  for (let i = 0; i < from.length; i++) {
    const p = apply(f, from[i]);
    if (Math.hypot(p.x - to[i].x, p.y - to[i].y) <= tolerance) kept.push(i);
  }
  return kept;
}

/**
 * Fit the template-to-scan transform for one page from its printed words, or null when no single
 * fit explains the page: fewer than MIN_PAIRS words agree on one (a blank page, only handwriting, a
 * different page), or the words that agree are too few or bunched in one part of the page.
 *
 * A plain least-squares fit lets one misplaced OCR word drag every region, so the fit starts from
 * the two-word hypothesis most other pairs agree with, then refits on the pairs that agree.
 */
export function registerPage(template: PageWords, scan: PageWords): Registration | null {
  if (!(template.width > 0 && template.height > 0 && scan.width > 0 && scan.height > 0)) return null;
  const pairs = pairWords(template.words, scan.words);
  if (pairs.length < MIN_PAIRS) return null;
  const from = pairs.map((p) => centerPx(p.template, template));
  const to = pairs.map((p) => centerPx(p.scan, scan));
  const tolerance = INLIER_TOLERANCE * Math.hypot(scan.width, scan.height);

  const stride = Math.max(1, Math.ceil(pairs.length / MAX_SEED_WORDS));
  const seeds = from.map((_, i) => i).filter((i) => i % stride === 0);
  let best: number[] = [];
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const [p, q] = [seeds[i], seeds[j]];
      const guess = fitSimilarity([from[p], from[q]], [to[p], to[q]]);
      if (!guess) continue;
      const kept = inliersOf(guess, from, to, tolerance);
      if (kept.length > best.length) best = kept;
    }
  }
  if (best.length < MIN_PAIRS) return null;

  // Refit on the pairs that agree with the best guess, then once more on the pairs that agree with
  // that refit, which drops any the first guess let in by luck.
  const refit = (kept: number[]) =>
    fitSimilarity(
      kept.map((i) => from[i]),
      kept.map((i) => to[i])
    );
  const first = refit(best);
  if (!first) return null;
  const kept = inliersOf(first, from, to, tolerance);
  if (kept.length < MIN_PAIRS) return null;
  const fit = refit(kept);
  if (!fit) return null;
  const agreeing = inliersOf(fit, from, to, tolerance).map((i) => from[i]);
  if (!explainsPage(agreeing, from)) return null;
  return {
    ...fit,
    template: { width: template.width, height: template.height },
    scan: { width: scan.width, height: scan.height }
  };
}

/** The registration that leaves regions and words where they are: a scan read as drawn. */
export const AS_DRAWN: Registration = {
  a: 1,
  b: 0,
  tx: 0,
  ty: 0,
  template: { width: 1, height: 1 },
  scan: { width: 1, height: 1 }
};

/**
 * How to read one scan page against its template page. AS_DRAWN when the template page has too
 * little printed text to place a scan by (an answer sheet of empty boxes) or does not exist; null
 * when it does have printed text and the scan does not line up with it, which is a page to refuse.
 */
export function alignPage(template: PageWords | undefined, scan: PageWords): Registration | null {
  if (!template || uniqueWords(template.words).size < MIN_PAIRS) return AS_DRAWN;
  return registerPage(template, scan);
}

/** The straight box on the scan around a template region's four corners. */
export function mapRectToScan(rect: NormRect, reg: Registration): NormRect {
  // Exact, so a page read as drawn stores the region exactly as drawn. A copy of just the box, as
  // callers pass whole region rows and the result goes to the model as JSON.
  if (reg === AS_DRAWN) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height]
  ].map(([x, y]) => apply(reg, { x: x * reg.template.width, y: y * reg.template.height }));
  const xs = corners.map((c) => c.x / reg.scan.width);
  const ys = corners.map((c) => c.y / reg.scan.height);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Scan words moved into template space, so template regions and wordsInRegion apply as drawn. */
export function wordsToTemplate(words: WordBox[], reg: Registration): WordBox[] {
  if (reg === AS_DRAWN) return words;
  const det = reg.a * reg.a + reg.b * reg.b;
  const scale = Math.sqrt(det);
  return words.map((w) => {
    const c = centerPx(w, reg.scan);
    const du = c.x - reg.tx,
      dv = c.y - reg.ty;
    const cx = (reg.a * du + reg.b * dv) / det;
    const cy = (-reg.b * du + reg.a * dv) / det;
    const width = (w.width * reg.scan.width) / scale / reg.template.width;
    const height = (w.height * reg.scan.height) / scale / reg.template.height;
    return {
      ...w,
      x: cx / reg.template.width - width / 2,
      y: cy / reg.template.height - height / 2,
      width,
      height
    };
  });
}
