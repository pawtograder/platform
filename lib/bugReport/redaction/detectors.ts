/**
 * The detector chain of the redaction pass: the taint set (Aho-Corasick), then the regex
 * backstop, then the model if package 4 ships. Also the user's click-to-redact strings.
 *
 * The walker calls the synchronous stages directly, because it runs them over tens of
 * thousands of strings and a promise per string adds up. `Detector` wrappers exist for the
 * contract and for async stages such as a model.
 */
import { AhoCorasick } from "../ahoCorasick";
import { findBackstopSpans } from "../regexBackstop";
import type { TaintKind } from "../taint";
import type { Detector, Span, TaintSnapshot } from "./types";

export type SyncDetector = (text: string) => Span[];

/** The stages the walker runs, in order. */
export type DetectorChain = {
  sync: SyncDetector[];
  /** Async stages (package 4's model). Run after the sync ones, on the same texts. */
  async: Detector[];
};

/** Finds every taint pattern, case- and whitespace-insensitively (see `normalizeForMatch`). */
export function taintDetector(snapshot: TaintSnapshot): SyncDetector {
  const ac = new AhoCorasick<TaintKind>();
  for (const { kind, pattern } of snapshot) ac.add(pattern, kind);
  if (ac.size === 0) return () => [];
  return (text) => ac.search(text).map((m) => ({ start: m.start, end: m.end, kind: m.values[0] ?? "name" }));
}

/** Emails, 9-digit NUIDs, and `mailto:` links (package 2's backstop). */
export const backstopDetector: SyncDetector = (text) => findBackstopSpans(text);

const MASK_ONLY = /^[\s*]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The user's click-to-redact strings: exact, case-sensitive, every occurrence. A `*` matches
 * any one non-space character, since review shows earlier redactions as `*` while the walker
 * matches the original text. Strings made only of `*` and spaces would match everything and
 * are ignored.
 */
export function extraRedactionDetector(strings: readonly string[] | undefined): SyncDetector {
  const plain: string[] = [];
  const patterns: RegExp[] = [];
  for (const s of new Set(strings ?? [])) {
    if (typeof s !== "string" || MASK_ONLY.test(s)) continue;
    if (s.includes("*")) patterns.push(new RegExp(escapeRegExp(s).replace(/\\\*/g, "\\S"), "g"));
    else plain.push(s);
  }
  if (plain.length === 0 && patterns.length === 0) return () => [];
  return (text) => {
    const spans: Span[] = [];
    for (const s of plain) {
      for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + 1)) {
        spans.push({ start: i, end: i + s.length, kind: "user" });
      }
    }
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, kind: "user" });
    }
    return spans;
  };
}

/** The chain for one redaction pass. `model` is package 4's slot; nothing passes it yet. */
export function buildDetectorChain(
  options: { taintPatterns: TaintSnapshot; extraRedactions?: string[] },
  model?: Detector
): DetectorChain {
  return {
    sync: [taintDetector(options.taintPatterns), backstopDetector, extraRedactionDetector(options.extraRedactions)],
    async: model ? [model] : []
  };
}

/** Wraps a synchronous stage as a contract `Detector`. */
export function asDetector(detector: SyncDetector): Detector {
  return async (text) => detector(text);
}

/** Sorted, merged, non-empty `[start, end)` ranges. */
export function mergeSpans(spans: readonly { start: number; end: number }[]): [number, number][] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last[1]) last[1] = Math.max(last[1], s.end);
    else out.push([s.start, s.end]);
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Drops spans that start or end inside a word. Used only for class names and CSS, where a
 * three-letter name matching inside an identifier ("Ann" in "banner") would break the replay's
 * styling without protecting anyone.
 */
export function onWordBoundaries(text: string, spans: Span[]): Span[] {
  return spans.filter(
    (s) => !(s.start > 0 && WORD_CHAR.test(text[s.start - 1])) && !(s.end < text.length && WORD_CHAR.test(text[s.end]))
  );
}
