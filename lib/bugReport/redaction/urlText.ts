/**
 * Percent-decoding with a map back to the encoded string, so detectors can match
 * `name=Jane%20Doe` as "Jane Doe" and the walker can mask the encoded bytes.
 */
export type DecodedUrl = {
  text: string;
  /** For each code unit of `text`, the offset in the encoded string where its source starts */
  starts: number[];
  /** For each code unit of `text`, the offset just past its source */
  ends: number[];
};

const ESCAPE = /%[0-9a-fA-F]{2}/y;

/** Most decoding passes: enough for a URL nested in a query parameter of a URL in another. */
export const MAX_DECODE_PASSES = 3;

/**
 * Decodes `%XX` runs (as UTF-8) and `+` (as a space, the form encoding), repeatedly while that
 * changes the text, at most `MAX_DECODE_PASSES` times, and returns the text after each pass that
 * changed it. A URL carried in a query parameter is encoded twice (`%2540` for `@`), and one pass
 * would leave it unreadable to the detectors. Every pass counts, not only the last. A later pass
 * reads a `+` that an earlier one decoded from `%2B` as a space, so `jdoe%2Bta%40x.org` reads as
 * one address only after the first pass. It also reads `%25001234567`, decoded once to
 * `%001234567`, as an escape and seven digits, which hides the nine-digit number.
 * Each map points into `encoded`. Every character decoded from a run maps to the whole run, so a
 * span inside a multi-byte character masks all its bytes. A run that is not valid UTF-8 is left
 * as is.
 */
export function decodeUrlPasses(encoded: string): DecodedUrl[] {
  const passes: DecodedUrl[] = [];
  let map: DecodedUrl | undefined;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const input = map?.text ?? encoded;
    const next = decodeOnce(input);
    if (next.text === input) break;
    // Compose the maps. A unit of `next` spans units of the previous text, which span bytes of
    // `encoded`.
    const prev = map;
    map = prev
      ? {
          text: next.text,
          starts: next.starts.map((start) => prev.starts[start]),
          ends: next.ends.map((end) => prev.ends[end - 1])
        }
      : next;
    passes.push(map);
  }
  return passes;
}

/** The last of `decodeUrlPasses`, or `encoded` itself, mapped to itself, when nothing decodes. */
export function decodeUrlWithMap(encoded: string): DecodedUrl {
  const passes = decodeUrlPasses(encoded);
  return passes[passes.length - 1] ?? decodeOnce(encoded);
}

/** One decoding pass, mapped to its own input. */
function decodeOnce(encoded: string): DecodedUrl {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    ESCAPE.lastIndex = i;
    if (encoded[i] === "%" && ESCAPE.test(encoded)) {
      let j = i;
      for (;;) {
        ESCAPE.lastIndex = j;
        if (encoded[j] !== "%" || !ESCAPE.test(encoded)) break;
        j += 3;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded.slice(i, j));
      } catch {
        decoded = encoded.slice(i, j);
      }
      for (let k = 0; k < decoded.length; k++) {
        starts.push(i);
        ends.push(j);
      }
      text += decoded;
      i = j;
      continue;
    }
    text += encoded[i] === "+" ? " " : encoded[i];
    starts.push(i);
    ends.push(i + 1);
    i++;
  }
  return { text, starts, ends };
}

/**
 * The text detectors see for a URL: URL delimiters become spaces, same length, so a match
 * can't run across components. Without this the email backstop, whose local part allows `/`,
 * `?`, `=`, and `&`, takes `//host/path?q=a&mail=x@y.org` for one address and masks the URL.
 */
export function urlDetectionText(text: string): string {
  return text.replace(/[/?&=#;:]/g, " ");
}

/** One text a URL is matched as. */
export type UrlView = {
  text: string;
  /** Maps `text` back to the URL; absent when `text` has the URL's own offsets. */
  map?: DecodedUrl;
  /** Read by exact matchers only (the taint set and the user's strings), not the regex backstop. */
  exact: boolean;
};

/**
 * The texts a URL is matched as. The URL as written and its text after each decoding pass
 * (`decodeUrlPasses`) each appear twice: as they are, for exact matchers, so a taint line holding
 * `?` or `:` still matches, and with delimiters as spaces (`urlDetectionText`), for the regex
 * backstop. The first view is the URL as written.
 */
export function urlViews(url: string): UrlView[] {
  const views: UrlView[] = [
    { text: url, exact: true },
    { text: urlDetectionText(url), exact: false }
  ];
  for (const map of decodeUrlPasses(url)) {
    views.push({ text: map.text, map, exact: true }, { text: urlDetectionText(map.text), map, exact: false });
  }
  return views;
}

/** Maps `[start, end)` in the decoded text back to the encoded string. */
export function toEncodedRange(map: DecodedUrl, start: number, end: number): [number, number] {
  return [map.starts[start], map.ends[end - 1]];
}
