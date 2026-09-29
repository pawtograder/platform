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
 * changes the text, at most `MAX_DECODE_PASSES` times. A URL carried in a query parameter is
 * encoded twice (`%2540` for `@`), and one pass would leave it unreadable to the detectors. The
 * map always points into `encoded`: every character decoded from a run maps to the whole run, so
 * a span inside a multi-byte character masks all its bytes. A run that is not valid UTF-8 is left
 * as is.
 */
export function decodeUrlWithMap(encoded: string): DecodedUrl {
  let map = decodeOnce(encoded);
  for (let pass = 1; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeOnce(map.text);
    if (next.text === map.text) break;
    // Compose: a unit of `next` spans units of `map.text`, which span bytes of `encoded`.
    map = {
      text: next.text,
      starts: next.starts.map((start) => map.starts[start]),
      ends: next.ends.map((end) => map.ends[end - 1])
    };
  }
  return map;
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

/** Maps `[start, end)` in the decoded text back to the encoded string. */
export function toEncodedRange(map: DecodedUrl, start: number, end: number): [number, number] {
  return [map.starts[start], map.ends[end - 1]];
}
