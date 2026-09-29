/**
 * Synchronous redaction of one URL, for the page URL that the feedback event carries. The
 * replay's URLs go through the walker; the feedback is sent from the main bundle, so this
 * stays small: the taint set and the regex backstop, no worker.
 */
import { getTaintSet, type TaintSet } from "../taint";
import { backstopDetector, mergeSpans, taintDetector } from "./detectors";
import { taintSnapshot } from "./taintSnapshot";
import { decodeUrlWithMap, toEncodedRange, urlDetectionText } from "./urlText";

/** `url` with every taint or backstop hit (matched raw and percent-decoded) masked with `*`. */
export function redactReportUrl(url: string, set: TaintSet = getTaintSet()): string {
  const detectors = [taintDetector(taintSnapshot(set)), backstopDetector];
  const ranges: { start: number; end: number }[] = [];
  for (const d of detectors) ranges.push(...d(urlDetectionText(url)));
  const map = decodeUrlWithMap(url);
  if (map.text !== url) {
    for (const d of detectors) {
      for (const s of d(urlDetectionText(map.text))) {
        const [start, end] = toEncodedRange(map, s.start, s.end);
        ranges.push({ start, end });
      }
    }
  }
  if (ranges.length === 0) return url;
  let out = "";
  let at = 0;
  for (const [start, end] of mergeSpans(ranges)) {
    out += url.slice(at, start) + "*".repeat(end - start);
    at = end;
  }
  return out + url.slice(at);
}
