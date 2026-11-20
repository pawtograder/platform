/**
 * Types of the bug reporter's redaction pass (spec package 3). Type-only; see `./index.ts` for
 * `redactBuffer`.
 */
import type { FrozenBuffer } from "../types";
import type { TaintKind } from "../taint";

/**
 * The taint set in a form that can cross into the worker: every normalized match pattern
 * (`matchPatterns` variants) with the kind it came from.
 */
export type TaintSnapshot = { kind: TaintKind; pattern: string }[];

export type RedactOptions = {
  taintPatterns: TaintSnapshot;
  /**
   * Strings the user picked in review (click-to-redact), matched exactly, every occurrence. A
   * `*` in one matches any single non-space character, so a string copied from `remaining`
   * (where earlier redactions already show as `*`) still finds the original text.
   */
  extraRedactions?: string[];
  /**
   * Keep only the last this-many milliseconds. Whole segments are dropped from the front, so
   * the result still starts with Meta + FullSnapshot and spans at most this long (at least the
   * newest segment is always kept).
   */
  keepLastMs?: number;
};

export type RemainingKind = "text" | "attribute" | "input" | "console" | "breadcrumb" | "url" | "title";

/** A human-readable string still in the upload after redaction, for the review list (E2). */
export type RemainingString = { value: string; kind: RemainingKind; count: number };

export type RedactionStats = {
  /** Text nodes (and text changes) the walker looked at. */
  textNodes: number;
  /** Ranges replaced by mask characters, after merging overlapping detector spans. */
  redactedSpans: number;
  /** Wall time of the pass, in milliseconds. */
  ms: number;
};

export type RedactionResult = {
  /** A redacted deep copy; the input buffer is never modified. */
  buffer: FrozenBuffer;
  /** Grouped by kind, then most frequent first. Never holds a string made only of mask characters. */
  remaining: RemainingString[];
  stats: RedactionStats;
};

/** Half-open `[start, end)` range of the text a detector was given. */
export type Span = { start: number; end: number; kind: string };

/**
 * One stage of the detector chain: taint set, then the regex backstop, then the model if
 * package 4 ships. Async so a model can run on the GPU or in WASM.
 */
export type Detector = (text: string) => Promise<Span[]>;
