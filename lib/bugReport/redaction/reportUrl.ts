/**
 * Synchronous redaction of one URL, for the page URL that the feedback event carries. The
 * replay's URLs go through the walker; the feedback is sent from the main bundle, so this
 * stays small: the taint set and the regex backstop over the same views of the URL as the
 * walker's (`urlViews`), no worker.
 */
import { MIN_MATCH_LENGTH, normalizeForMatch } from "../ahoCorasick";
import { getTaintSet, type TaintSet } from "../taint";
import { backstopDetector, extraRedactionDetector, maskRanges, mergeSpans, type SyncDetector } from "./detectors";
import { taintSnapshot } from "./taintSnapshot";
import type { Span, TaintSnapshot } from "./types";
import { toEncodedRange, urlViews } from "./urlText";

/**
 * The taint set's matches in a few short strings, found by looking each pattern up in the
 * normalized text directly. Building the Aho-Corasick automaton over a full taint set (up to
 * hundreds of thousands of patterns) takes seconds and hundreds of megabytes on the main thread.
 * This takes milliseconds per URL. The patterns are normalized already (`TaintSet.values()`), so
 * the spans are the ones the automaton finds.
 */
function scanDetector(patterns: TaintSnapshot): SyncDetector {
  return (input) => {
    const { text, starts, ends } = normalizeForMatch(input);
    const spans: Span[] = [];
    for (const { kind, pattern } of patterns) {
      if (pattern.length > text.length || pattern.trim().length < MIN_MATCH_LENGTH) continue;
      for (let i = text.indexOf(pattern); i !== -1; i = text.indexOf(pattern, i + 1)) {
        spans.push({ start: starts[i], end: ends[i + pattern.length - 1], kind });
      }
    }
    return spans;
  };
}

/**
 * `url` with every taint or backstop hit (matched raw and percent-decoded) masked with `*`, and
 * every occurrence of the strings the user redacted in review (`extraRedactions`), as the walker
 * masks the replay's URLs.
 */
export function redactReportUrl(
  url: string,
  set: TaintSet = getTaintSet(),
  extraRedactions?: readonly string[]
): string {
  const taint = scanDetector(taintSnapshot(set));
  const extra = extraRedactionDetector(extraRedactions);
  const ranges: { start: number; end: number }[] = [];
  for (const view of urlViews(url)) {
    for (const d of view.exact ? [taint, extra] : [taint, backstopDetector, extra]) {
      for (const s of d(view.text)) {
        const [start, end] = view.map ? toEncodedRange(view.map, s.start, s.end) : [s.start, s.end];
        ranges.push({ start, end });
      }
    }
  }
  return ranges.length === 0 ? url : maskRanges(url, mergeSpans(ranges));
}
