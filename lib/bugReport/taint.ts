/**
 * The taint set: values from classified sources that the redaction pass removes from recorded
 * text. It lasts one page load (module state; a full load starts empty).
 *
 * The ingest points (`lib/bugReport/ingest.ts`: fetch wrapper, TableController, realtime, taint
 * block, auth session) add values as they reach the browser. `add` expands each value into the
 * strings the matcher looks for (`matchPatterns`: name variants, an email's local part) and stores
 * those, normalized. `values()` therefore returns match patterns, not the raw values.
 *
 * Free text is expanded incrementally. One response can carry megabytes of it (submission file
 * contents), and splitting and normalizing that in one go blocked the main thread for over a
 * second. `add` queues free text, and a background drain works through it a few milliseconds at a
 * time in idle callbacks. Every read (`values`, `has`, `size`, `stats`, `isSaturated`) drains the
 * queue first, synchronously, so the redaction snapshot (`taintSnapshot`) never misses a queued
 * value. Names, emails, and handles are small and are added at once.
 *
 * Memory is bounded, with separate budgets so free text can never crowd out identities: names,
 * emails, and handles share `MAX_IDENTITY_PATTERNS`; free text has `MAX_FREE_TEXT_PATTERNS` and a
 * character budget. A pattern longer than `MAX_PATTERN_LENGTH` is stored as overlapping chunks
 * (`chunkPattern`), which together cover all of it. Past a budget nothing more of that kind is added and the set reports itself saturated (`isSaturated()`),
 * so the review dialog can warn that the automatic redaction is incomplete.
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
  /** Of those, names, emails, and handles. */
  droppedIdentity: number;
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
  /**
   * True once a budget has dropped a pattern: some tainted text may then stay readable in the
   * recording, and the review dialog should say the automatic redaction is incomplete.
   */
  isSaturated(): boolean;
  /** Expands everything queued, now, on the calling thread. Every read does this itself. */
  flush(): void;
}

/** Longest pattern stored; longer ones are stored as overlapping chunks (`chunkPattern`). */
export const MAX_PATTERN_LENGTH = 512;
/** Cap on distinct name, email, and handle patterns together. Free text never counts against it. */
export const MAX_IDENTITY_PATTERNS = 200_000;
/** Cap on distinct free-text patterns. */
export const MAX_FREE_TEXT_PATTERNS = 200_000;
/** Cap on characters of free-text patterns, which are long and the most numerous. */
export const MAX_FREE_TEXT_CHARS = 4_000_000;
/** Longest stretch of main-thread time one step of the background drain takes. */
export const DRAIN_SLICE_MS = 8;
/** Raw values remembered to skip re-expanding a repeat; a cache, cleared when full. */
const MAX_SEEN = 100_000;

/**
 * Splits a normalized pattern longer than `MAX_PATTERN_LENGTH` into chunks of at most that length.
 * Each chunk ends at a space when there is one in its second half, and the next chunk starts about
 * halfway through the previous one, at a word start. So consecutive chunks overlap, every
 * character is in at least one chunk, and text showing the whole line has all of it matched.
 * A shorter pattern is returned as is.
 */
export function chunkPattern(pattern: string): string[] {
  if (pattern.length <= MAX_PATTERN_LENGTH) return [pattern];
  const out: string[] = [];
  const half = MAX_PATTERN_LENGTH / 2;
  let start = 0;
  for (;;) {
    let end = Math.min(start + MAX_PATTERN_LENGTH, pattern.length);
    if (end < pattern.length) {
      const space = pattern.lastIndexOf(" ", end);
      if (space > start + half) end = space;
    }
    const chunk = pattern.slice(start, end).trim();
    if (chunk.length > 0) out.push(chunk);
    if (end >= pattern.length) return out;
    // Start the next chunk at the first word start past the middle of this one. `next < end`, so
    // the chunks overlap and nothing between them is skipped.
    let next = start + Math.floor((end - start) / 2);
    const space = pattern.indexOf(" ", next);
    if (space !== -1 && space + 1 < end) next = space + 1;
    start = next;
  }
}

/** Free text waiting to be expanded, consumed line by line from `offset`. */
type QueuedText = { value: string; offset: number };

type IdleHandle = { cancel(): void };

/** `requestIdleCallback` where there is one (not Safari), else a zero-delay timeout. */
function scheduleIdle(fn: () => void): IdleHandle {
  const w = typeof window !== "undefined" ? window : undefined;
  if (w && typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout: 1_000 });
    return { cancel: () => w.cancelIdleCallback(id) };
  }
  const id = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(id) };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

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
  private identityPatterns = 0;
  private freeTextPatterns = 0;
  private freeTextChars = 0;
  private dropped = 0;
  private droppedIdentity = 0;
  private readonly queue: QueuedText[] = [];
  private scheduled: IdleHandle | null = null;

  get size(): number {
    this.flush();
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
    if (kind === "free_text") {
      this.queue.push({ value, offset: 0 });
      this.scheduleDrain();
      return;
    }
    for (const p of matchPatterns(value, kind)) this.addPatterns(kind, p);
  }

  /**
   * Expands queued free text until the queue is empty or `deadline` passes. Free text renders one
   * block element per line or paragraph, and the redaction walker matches per block, so each line
   * is its own pattern.
   */
  private drain(deadline: number): void {
    let lines = 0;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      const newline = item.value.indexOf("\n", item.offset);
      const end = newline === -1 ? item.value.length : newline;
      const line = item.value.slice(item.offset, end);
      item.offset = end + 1;
      if (item.offset > item.value.length) this.queue.shift();
      if (line.length > 0) this.addLine(line);
      // Reading the clock on every line would cost more than most lines; every 64 is enough.
      if (++lines % 64 === 0 && now() >= deadline) return;
    }
  }

  private addLine(line: string): void {
    for (const p of matchPatterns(line, "free_text")) this.addPatterns("free_text", p);
  }

  private addPatterns(kind: TaintKind, pattern: string): void {
    for (const chunk of chunkPattern(pattern)) this.addPattern(kind, chunk);
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = scheduleIdle(() => {
      this.scheduled = null;
      this.drain(now() + DRAIN_SLICE_MS);
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  flush(): void {
    if (this.queue.length === 0) return;
    this.drain(Infinity);
    this.scheduled?.cancel();
    this.scheduled = null;
  }

  private addPattern(kind: TaintKind, pattern: string): void {
    if (pattern.length === 0 || this.patterns.has(pattern)) return;
    const freeText = kind === "free_text";
    const full = freeText
      ? this.freeTextPatterns >= MAX_FREE_TEXT_PATTERNS || this.freeTextChars >= MAX_FREE_TEXT_CHARS
      : this.identityPatterns >= MAX_IDENTITY_PATTERNS;
    if (full) {
      this.dropped++;
      if (!freeText) this.droppedIdentity++;
      return;
    }
    this.patterns.set(pattern, kind);
    this.chars += pattern.length;
    if (freeText) {
      this.freeTextPatterns++;
      this.freeTextChars += pattern.length;
    } else {
      this.identityPatterns++;
    }
  }

  has(value: string): boolean {
    this.flush();
    return this.patterns.has(normalizeForMatch(value));
  }

  values(): Record<TaintKind, string[]> {
    this.flush();
    const out: Record<TaintKind, string[]> = { name: [], email: [], handle: [], free_text: [] };
    for (const [pattern, kind] of this.patterns) out[kind].push(pattern);
    return out;
  }

  clear(): void {
    this.queue.length = 0;
    this.scheduled?.cancel();
    this.scheduled = null;
    this.patterns.clear();
    for (const k of TAINT_KINDS) this.seen[k].clear();
    this.seenCount = 0;
    this.chars = 0;
    this.identityPatterns = 0;
    this.freeTextPatterns = 0;
    this.freeTextChars = 0;
    this.dropped = 0;
    this.droppedIdentity = 0;
  }

  isSaturated(): boolean {
    this.flush();
    return this.dropped > 0;
  }

  stats(): TaintStats {
    this.flush();
    const byKind: Record<TaintKind, number> = { name: 0, email: 0, handle: 0, free_text: 0 };
    for (const kind of this.patterns.values()) byKind[kind]++;
    return {
      patterns: this.patterns.size,
      chars: this.chars,
      byKind,
      dropped: this.dropped,
      droppedIdentity: this.droppedIdentity,
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
