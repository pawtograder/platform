// Base64 for GitHub text content, encoded and decoded as UTF-8.
//
// The handout sync reads a file out of the Contents API (base64) and writes the merged
// result back as a blob (base64). Both halves used to go through the Latin1 pair `atob`
// and `btoa`, which is wrong for any file that is not pure ASCII.
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
// The two halves have to move together. `btoa(atob(x))` reproduces the original bytes
// exactly, so today's read-then-write round trip is accidentally lossless. Fixing only
// the encoder would take a mojibake string from the decoder and encode those characters
// as UTF-8, writing double-encoded text into student repositories. That is worse than
// the current bug, which at least fails loudly.
//
// Binary files do not come through here. `copyBlobBetweenRepos` moves them blob to blob
// and never decodes them to a string.

import { decodeBase64, encodeBase64 } from "https://deno.land/std@0.221.0/encoding/base64.ts";

/**
 * Decode base64 file content from the GitHub API into text.
 *
 * The Contents API wraps its base64 at 60 characters. This decoder tolerates the
 * newlines, but strip them anyway so the input is canonical and a stricter decoder in a
 * later std release cannot break the read path silently.
 */
export function decodeGitHubBase64Text(base64: string): string {
  return new TextDecoder().decode(decodeBase64(base64.replace(/\s/g, "")));
}

/** Encode text as base64 for a GitHub blob or Contents API write. */
export function encodeTextAsGitHubBase64(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}
