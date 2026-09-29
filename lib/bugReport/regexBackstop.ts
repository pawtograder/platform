/**
 * Pattern backstop for the redaction pass (bug reporter spec, package 2): catches emails, 9-digit
 * NUIDs, and `mailto:` links that the taint set missed, e.g. an address typed into a form or
 * rendered from a source nobody classified. It runs after the taint set and before any model.
 */

export type BackstopKind = "email" | "nuid" | "mailto";

/** Half-open [start, end) span of `text`. */
export type BackstopSpan = { start: number; end: number; kind: BackstopKind };

const PATTERNS: readonly [BackstopKind, RegExp][] = [
  // The whole href, including any ?subject=/&cc= query, up to whitespace, a quote, or an angle bracket.
  ["mailto", /mailto:[^\s"'<>]+/gi],
  [
    "email",
    /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,}/gu
  ],
  // Exactly nine digits, not part of a longer number.
  ["nuid", /(?<!\d)\d{9}(?!\d)/g]
];

/** Spans to redact, sorted by start; a span inside an earlier one (an email in a mailto:) is dropped. */
export function findBackstopSpans(text: string): BackstopSpan[] {
  const spans: BackstopSpan[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: BackstopSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) {
      if (s.end > prev.end) prev.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
