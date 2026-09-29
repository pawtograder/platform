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

/**
 * Decodes `%XX` runs (as UTF-8) and `+` (as a space, the form encoding). Every character decoded
 * from a run maps to the whole run, so a span inside a multi-byte character masks all its bytes.
 * A run that is not valid UTF-8 is left as is.
 */
export function decodeUrlWithMap(encoded: string): DecodedUrl {
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

/** Maps `[start, end)` in the decoded text back to the encoded string. */
export function toEncodedRange(map: DecodedUrl, start: number, end: number): [number, number] {
  return [map.starts[start], map.ends[end - 1]];
}
