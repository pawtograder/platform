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
  // Exactly nine digits, not part of a longer number.
  ["nuid", /(?<!\d)\d{9}(?!\d)/g]
];

/** A character of an email's local part. */
const LOCAL_CHAR = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]$/u;
/** An email's domain, read from just after the `@`. */
const DOMAIN =
  /[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,}/uy;

/**
 * The matches of `local+@domain`, left to right, as a global regex finds them. A regex retries
 * the local part from every character of a long run, which is quadratic on text with no `@` (a
 * base64 token, a stylesheet). This starts from each `@` and walks back over the local part once.
 */
function findEmails(text: string, spans: BackstopSpan[]): void {
  let floor = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > floor) {
      // A character outside the BMP is a surrogate pair; step over it whole.
      const pair = start - 2 >= floor && /[\uDC00-\uDFFF]/.test(text[start - 1]) ? 2 : 1;
      if (!LOCAL_CHAR.test(text.slice(start - pair, start))) break;
      start -= pair;
    }
    if (start === at) continue;
    DOMAIN.lastIndex = at + 1;
    const m = DOMAIN.exec(text);
    if (!m) continue;
    const end = at + 1 + m[0].length;
    spans.push({ start, end, kind: "email" });
    floor = end;
    at = end - 1;
  }
}

/** Spans to redact, sorted by start; a span inside an earlier one (an email in a mailto:) is dropped. */
export function findBackstopSpans(text: string): BackstopSpan[] {
  const spans: BackstopSpan[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }
  findEmails(text, spans);
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
