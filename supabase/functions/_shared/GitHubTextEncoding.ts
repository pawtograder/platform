// Base64 for GitHub text content, read and written through the same codec.
//
// The handout sync reads a student's file out of the Contents API and writes the merged
// result back as a blob. Both halves used to go through the Latin1 pair `atob` and
// `btoa`, which is wrong for any file that is not pure ASCII.
//
// `atob` returns one character per byte, so a UTF-8 file comes back as mojibake: the
// three-character string `Yāo` decodes to the four characters `Y`, `Ä`, U+0081, `o`.
// GitHub's patch text arrives over JSON and is decoded properly, so the base content and
// the patch disagree about every non-ASCII line, and `applyPatch` finds no matching
// context.
//
// `btoa` throws `InvalidCharacterError` on any code point above U+00FF. That is what
// killed the CS 4530 IP1 handout sync on 2026-09-10. The patch for
// server/src/services/user.service.ts did not apply, the fallback correctly fetched the
// template's full text, and encoding that text threw on the `ā` in it. A throw here is
// not retryable, so the message burned its five retries and dead-lettered, which left
// the student's repository without the handout update.
//
// Reading and writing have to agree, so a decode hands back the encoder that inverts it
// rather than leaving the caller to pick one. `btoa(atob(x))` reproduces the original
// bytes, so the old Latin1 pair was self-consistent even while it was wrong about what
// the characters meant. A UTF-8 encoder paired with a Latin1 decoder would write
// double-encoded text into student repositories, which is worse than the bug it replaces
// because it fails silently.
//
// Two decisions the pairing exists to hold:
//
//   * The decoder is `fatal`, and content that is not valid UTF-8 falls back to the
//     byte-preserving Latin1 codec instead of the replacement character. A lenient
//     decoder turns every invalid byte into U+FFFD, and re-encoding then writes `EF BF
//     BD` over it, corrupting a file the sync was only supposed to patch.
//   * The decoder keeps the byte-order mark (`ignoreBOM`, whose name means the opposite
//     of what it reads like). The default decoder swallows a leading BOM, so a file that
//     had one would come back three bytes shorter than it went in.
//
// Binary files do not come through here. `copyBlobBetweenRepos` moves them blob to blob
// and never decodes them to a string.

import { decodeBase64, encodeBase64 } from "https://deno.land/std@0.221.0/encoding/base64.ts";

/** A file's text, together with the encoder that reproduces the bytes it was read from. */
export type GitHubTextFile = {
  text: string;
  encode: (text: string) => string;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Encode text as UTF-8 base64. The codec for anything valid UTF-8, and for new files. */
export function encodeTextAsGitHubBase64(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}

// One character per byte, the codec `atob` and `btoa` implement. Reached only when a file
// is not valid UTF-8, where it is the one reading that preserves the bytes exactly. Note
// that `new TextDecoder("latin1")` is not this: the label is an alias for windows-1252,
// which maps 0x80 to U+20AC rather than to U+0080.
function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return text;
}

function encodeLatin1(text: string): string {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(
        `Cannot encode U+${code.toString(16).toUpperCase().padStart(4, "0")}: this file was read as raw bytes ` +
          `because it is not valid UTF-8, and the merged content now carries a character that has no byte to ` +
          `write it as. Convert the file to UTF-8 in the handout repository.`
      );
    }
    bytes[i] = code;
  }
  return encodeBase64(bytes);
}

/** Decode a file's raw bytes into text plus the encoder that inverts the decode. */
export function decodeGitHubTextBytes(bytes: Uint8Array): GitHubTextFile {
  try {
    return { text: utf8Decoder.decode(bytes), encode: encodeTextAsGitHubBase64 };
  } catch {
    return { text: decodeLatin1(bytes), encode: encodeLatin1 };
  }
}

/**
 * Decode base64 file content from the GitHub API.
 *
 * The Contents API wraps its base64 at 60 characters. This decoder tolerates the
 * newlines, but strip them anyway so the input is canonical and a stricter decoder in a
 * later std release cannot break the read path silently.
 */
export function decodeGitHubBase64Text(base64: string): GitHubTextFile {
  return decodeGitHubTextBytes(decodeBase64(base64.replace(/\s/g, "")));
}
