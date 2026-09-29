/**
 * The taint set: values from classified sources that the redaction pass removes from recorded
 * text. It lasts one page load (module state; a full load starts empty).
 *
 * The ingest points (`lib/bugReport/ingest.ts`: fetch wrapper, TableController, realtime, taint
 * block, auth session) add values as they reach the browser. `add` expands each value into the
 * strings the matcher looks for (`matchPatterns`: name variants, an email's local part) and stores
 * those, normalized. `values()` therefore returns match patterns, not the raw values.
 *
 * Memory is bounded: patterns longer than `MAX_PATTERN_LENGTH` are cut to that length, free text
 * has its own character budget, and past `MAX_PATTERNS` nothing more is added. Both limits are far
 * above what a 1,000-student class produces (see the package 2 measurements); `stats()` reports
 * when one was reached, so a caller can tell a complete set from a truncated one.
 */
import { matchPatterns, normalizeForMatch } from "./variants";

/**
 * The kinds a taint value can have. Grades are blocked structurally and never string-matched.
 * Free text is blocked structurally too, and also matched as text, line by line, as a second line
 * of defense for places blocking can't reach (attributes, the document title, console output).
 */
export type TaintKind = "name" | "email" | "handle" | "free_text";

export const TAINT_KINDS: readonly TaintKind[] = ["name", "email", "handle", "free_text"];

export type TaintStats = {
  /** Distinct patterns held. */
  patterns: number;
  /** UTF-16 code units across all patterns. */
  chars: number;
  byKind: Record<TaintKind, number>;
  /** Patterns not added because a limit was reached. */
  dropped: number;
  /** True once any limit has dropped a pattern. */
  saturated: boolean;
};

export interface TaintSet {
  /** Adds `value` and its match variants. Values under 3 characters and initials add nothing. */
  add(kind: TaintKind, value: string): void;
  /** True when `value`, normalized, is one of the patterns. */
  has(value: string): boolean;
  /** Every pattern, grouped by kind. Patterns are normalized (`normalizeForMatch`). */
  values(): Record<TaintKind, string[]>;
  clear(): void;
  /** Number of distinct patterns. */
  readonly size: number;
  stats(): TaintStats;
}

/** Longest pattern kept; longer ones are cut, which still matches the text they start. */
export const MAX_PATTERN_LENGTH = 512;
/** Cap on distinct patterns of every kind. */
export const MAX_PATTERNS = 200_000;
/** Cap on characters of free-text patterns, which are long and the most numerous. */
export const MAX_FREE_TEXT_CHARS = 4_000_000;
/** Raw values remembered to skip re-expanding a repeat; a cache, cleared when full. */
const MAX_SEEN = 100_000;

class PatternTaintSet implements TaintSet {
  /** Pattern to the kind it was first added as. */
  private readonly patterns = new Map<string, TaintKind>();
  private readonly seen: Record<TaintKind, Set<string>> = {
    name: new Set(),
    email: new Set(),
    handle: new Set(),
    free_text: new Set()
  };
  private seenCount = 0;
  private chars = 0;
  private freeTextChars = 0;
  private dropped = 0;

  get size(): number {
    return this.patterns.size;
  }

  add(kind: TaintKind, value: string): void {
    if (typeof value !== "string" || !TAINT_KINDS.includes(kind)) return;
    const seen = this.seen[kind];
    if (seen.has(value)) return;
    if (this.seenCount >= MAX_SEEN) {
      for (const k of TAINT_KINDS) this.seen[k].clear();
      this.seenCount = 0;
    }
    seen.add(value);
    this.seenCount++;
    // Free text renders one block element per line or paragraph, and the redaction walker
    // matches per block, so each line is its own pattern.
    const parts = kind === "free_text" ? value.split(/\n+/) : [value];
    for (const part of parts) {
      for (const p of matchPatterns(part, kind)) this.addPattern(kind, p.slice(0, MAX_PATTERN_LENGTH).trim());
    }
  }

  private addPattern(kind: TaintKind, pattern: string): void {
    if (pattern.length === 0 || this.patterns.has(pattern)) return;
    if (this.patterns.size >= MAX_PATTERNS || (kind === "free_text" && this.freeTextChars >= MAX_FREE_TEXT_CHARS)) {
      this.dropped++;
      return;
    }
    this.patterns.set(pattern, kind);
    this.chars += pattern.length;
    if (kind === "free_text") this.freeTextChars += pattern.length;
  }

  has(value: string): boolean {
    return this.patterns.has(normalizeForMatch(value));
  }

  values(): Record<TaintKind, string[]> {
    const out: Record<TaintKind, string[]> = { name: [], email: [], handle: [], free_text: [] };
    for (const [pattern, kind] of this.patterns) out[kind].push(pattern);
    return out;
  }

  clear(): void {
    this.patterns.clear();
    for (const k of TAINT_KINDS) this.seen[k].clear();
    this.seenCount = 0;
    this.chars = 0;
    this.freeTextChars = 0;
    this.dropped = 0;
  }

  stats(): TaintStats {
    const byKind: Record<TaintKind, number> = { name: 0, email: 0, handle: 0, free_text: 0 };
    for (const kind of this.patterns.values()) byKind[kind]++;
    return {
      patterns: this.patterns.size,
      chars: this.chars,
      byKind,
      dropped: this.dropped,
      saturated: this.dropped > 0
    };
  }
}

let pageTaintSet: TaintSet | undefined;

/** This page load's taint set. */
export function getTaintSet(): TaintSet {
  pageTaintSet ??= new PatternTaintSet();
  return pageTaintSet;
}

/** A new, empty taint set, for tests. */
export function createTaintSet(): TaintSet {
  return new PatternTaintSet();
}

export const TAINT_BLOCK_ID = "report-taint";

/** The JSON inside `<script type="application/json" id="report-taint">` (spec section 4.3). */
export type TaintBlockPayload = {
  v: 1;
  values: Partial<Record<TaintKind, string[]>>;
};

/** Read every taint block in `doc` into `set`. Malformed blocks are skipped. */
export function readTaintBlocks(doc: Document, set: TaintSet): void {
  for (const el of Array.from(doc.querySelectorAll(`script#${TAINT_BLOCK_ID}[type="application/json"]`))) {
    try {
      const parsed = JSON.parse(el.textContent ?? "") as Partial<TaintBlockPayload>;
      if (parsed?.v !== 1 || !parsed.values || typeof parsed.values !== "object") continue;
      for (const kind of TAINT_KINDS) {
        const list = parsed.values[kind];
        if (Array.isArray(list)) for (const value of list) if (typeof value === "string") set.add(kind, value);
      }
    } catch {
      // A malformed block adds nothing; the regex backstop still runs.
    }
  }
}
