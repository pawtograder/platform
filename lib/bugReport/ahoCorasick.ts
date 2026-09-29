/**
 * Multi-pattern string search (Aho-Corasick) with case- and whitespace-normalized matching.
 *
 * Used by the redaction worker to find tainted values in recorded text, and by the E2E canary
 * scan. Both need every occurrence of any of thousands of patterns in one pass, and the worker
 * needs the spans in the ORIGINAL text so it can map them back to rrweb nodes, so matching runs
 * on a normalized copy that keeps an offset map back to the input.
 *
 * Normalization: NFKC per code point (so fullwidth or ligature forms match their plain spelling),
 * lower case, and every run of whitespace becomes one space. Patterns shorter
 * than MIN_MATCH_LENGTH after normalization are dropped; short strings (initials, grades like
 * "A") are blocked structurally instead, because matching them as text would redact half the page.
 */

export const MIN_MATCH_LENGTH = 3;

export type NormalizedText = {
  text: string;
  /** For each code unit of `text`, the index in the original string where it starts */
  starts: number[];
  /** For each code unit of `text`, the index in the original string just past it */
  ends: number[];
};

const WHITESPACE = /\s/;

/** NFKC-normalizes, lower-cases, and collapses whitespace runs, keeping a map back to the original offsets. */
export function normalizeForMatch(input: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < input.length) {
    const codePoint = input.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    const width = char.length;
    if (WHITESPACE.test(char)) {
      let j = i + width;
      while (j < input.length && WHITESPACE.test(input[j])) j++;
      text += " ";
      starts.push(i);
      ends.push(j);
      i = j;
      continue;
    }
    // NFKC and toLowerCase can change length ("ﬁ" becomes "fi", "İ" two code units); every
    // resulting unit maps back to the whole original character.
    const lowered = char.normalize("NFKC").toLowerCase();
    for (let k = 0; k < lowered.length; k++) {
      starts.push(i);
      ends.push(i + width);
    }
    text += lowered;
    i += width;
  }
  return { text, starts, ends };
}

/** Normalizes a pattern the same way as searched text, without the offset map. */
export function normalizePattern(pattern: string): string {
  let out = "";
  for (const char of pattern) out += char.normalize("NFKC").toLowerCase();
  return out.replace(/\s+/g, " ");
}

export type Match<T> = {
  /** Start offset in the original (un-normalized) text */
  start: number;
  /** End offset (exclusive) in the original text */
  end: number;
  /** The normalized pattern that matched */
  pattern: string;
  /** The values registered for that pattern */
  values: readonly T[];
};

/**
 * An Aho-Corasick automaton over normalized patterns. Each pattern carries values; patterns that
 * normalize to the same string share one entry with all their values.
 */
export class AhoCorasick<T = string> {
  private readonly goto: Map<string, number>[] = [new Map()];
  private readonly fail: number[] = [0];
  /** Pattern indexes that end at each state, including those reached through failure links */
  private readonly out: number[][] = [[]];
  private readonly patterns: string[] = [];
  private readonly values: T[][] = [];
  private readonly patternIndex = new Map<string, number>();
  private built = false;

  constructor(entries: Iterable<[pattern: string, value: T]> = []) {
    for (const [pattern, value] of entries) this.add(pattern, value);
  }

  /** Number of distinct normalized patterns. */
  get size(): number {
    return this.patterns.length;
  }

  /** Adds a pattern. Returns false if it was too short to match and was dropped. */
  add(pattern: string, value: T): boolean {
    const normalized = normalizePattern(pattern);
    if (normalized.trim().length < MIN_MATCH_LENGTH) return false;
    const existing = this.patternIndex.get(normalized);
    if (existing !== undefined) {
      this.values[existing].push(value);
      return true;
    }
    this.built = false;
    const index = this.patterns.length;
    this.patterns.push(normalized);
    this.values.push([value]);
    this.patternIndex.set(normalized, index);
    let state = 0;
    for (const char of normalized) {
      let next = this.goto[state].get(char);
      if (next === undefined) {
        next = this.goto.length;
        this.goto.push(new Map());
        this.fail.push(0);
        this.out.push([]);
        this.goto[state].set(char, next);
      }
      state = next;
    }
    this.out[state].push(index);
    return true;
  }

  private build(): void {
    // Rebuilding from scratch after an add is simplest: reset the failure links and the merged
    // output lists, then recompute them breadth first.
    for (let s = 0; s < this.goto.length; s++) this.fail[s] = 0;
    const own: number[][] = this.out.map(() => []);
    for (let p = 0; p < this.patterns.length; p++) {
      let state = 0;
      for (const char of this.patterns[p]) state = this.goto[state].get(char)!;
      own[state].push(p);
    }
    const queue: number[] = [];
    for (const next of this.goto[0].values()) queue.push(next);
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head];
      for (const [char, next] of this.goto[state]) {
        let f = this.fail[state];
        while (f !== 0 && !this.goto[f].has(char)) f = this.fail[f];
        const target = this.goto[f].get(char);
        this.fail[next] = target !== undefined && target !== next ? target : 0;
        queue.push(next);
      }
    }
    // Merge outputs in BFS order so a state's failure target is always finished first.
    this.out[0] = own[0];
    for (const state of queue) this.out[state] = own[state].concat(this.out[this.fail[state]]);
    this.built = true;
  }

  /** Every occurrence of every pattern in `input`, overlapping ones included, in end order. */
  search(input: string): Match<T>[] {
    if (!this.built) this.build();
    const { text, starts, ends } = normalizeForMatch(input);
    const matches: Match<T>[] = [];
    let state = 0;
    // Walk by code point, the same way `add` inserted patterns; `i` tracks the code-unit index
    // into `text` so the offset maps line up.
    let i = 0;
    for (const char of text) {
      while (state !== 0 && !this.goto[state].has(char)) state = this.fail[state];
      state = this.goto[state].get(char) ?? 0;
      const last = i + char.length - 1;
      for (const p of this.out[state]) {
        const pattern = this.patterns[p];
        const first = last - pattern.length + 1;
        matches.push({ start: starts[first], end: ends[last], pattern, values: this.values[p] });
      }
      i += char.length;
    }
    return matches;
  }

  /** True if `input` contains any pattern. */
  test(input: string): boolean {
    return this.search(input).length > 0;
  }
}
