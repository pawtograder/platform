/**
 * Unit tests for the base64 codec pair the handout sync reads and writes files through.
 *
 * The handout content below is verbatim from neu-cs4530/fa26-handout-ip1 at 3c1e979,
 * server/src/services/user.service.ts, which is the file that dead-lettered three handout
 * syncs on 2026-09-10. It carries one character inside the Latin1 range (`é`) and one
 * above it (`ā`), and the two used to fail differently: `é` corrupted quietly, `ā` threw.
 *
 * Run from supabase/functions:  deno test --allow-net _shared/GitHubTextEncoding.test.ts
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { applyPatch } from "https://esm.sh/diff@5.1.0";
import { encodeBase64 } from "https://deno.land/std@0.221.0/encoding/base64.ts";
import { decodeGitHubBase64Text, decodeGitHubTextBytes, encodeTextAsGitHubBase64 } from "./GitHubTextEncoding.ts";

const HANDOUT_LINES = [
  '  updateUser("user1", { display: "Yāo" });',
  '  updateUser("user2", { display: "Sénior Dos" });'
];
const HANDOUT_TEXT = HANDOUT_LINES.join("\n") + "\n";

Deno.test("text with a code point above U+00FF survives the round trip", () => {
  assertEquals(decodeGitHubBase64Text(encodeTextAsGitHubBase64(HANDOUT_TEXT)).text, HANDOUT_TEXT);
});

// The dead-letter itself: btoa is what the encoder used to be, and this is the exact
// throw that consumed all five retries of the sync message.
Deno.test("btoa throws on the handout text that the encoder now accepts", () => {
  assertThrows(() => btoa(HANDOUT_TEXT), DOMException, "outside of the Latin1 range");
  assert(encodeTextAsGitHubBase64(HANDOUT_TEXT).length > 0);
});

// The quiet half. atob decodes a Latin1 character to two characters, and nothing throws,
// so a file with only Latin1-range accents synced without complaint while every
// non-ASCII line of its base content was wrong.
Deno.test("the decoder returns characters, not one character per byte", () => {
  const encoded = encodeTextAsGitHubBase64("Sénior");
  assertEquals(atob(encoded), "SÃ©nior");
  assertEquals(decodeGitHubBase64Text(encoded).text, "Sénior");
});

Deno.test("base64 wrapped the way the Contents API wraps it decodes correctly", () => {
  const wrapped = encodeTextAsGitHubBase64(HANDOUT_TEXT).replace(/(.{60})/g, "$1\n");
  assert(wrapped.includes("\n"));
  assertEquals(decodeGitHubBase64Text(wrapped).text, HANDOUT_TEXT);
});

// Why a decode hands back its own encoder. Reading a file and writing it back unchanged
// has to reproduce the original bytes, which the old Latin1 pair also did. A UTF-8
// encoder paired with the old Latin1 decoder would double-encode here.
Deno.test("reading a file and writing it back unchanged reproduces the base64", () => {
  const fromGitHub = encodeTextAsGitHubBase64(HANDOUT_TEXT);
  const file = decodeGitHubBase64Text(fromGitHub);
  assertEquals(file.encode(file.text), fromGitHub);
  assertEquals(encodeTextAsGitHubBase64(atob(fromGitHub)) === fromGitHub, false);
});

// A file the decoder cannot read as UTF-8 keeps its bytes. A lenient decoder would hand
// back U+FFFD for the 0xE9 and the encoder would commit EF BF BD over it, which corrupts
// a file the sync was only asked to patch.
Deno.test("content that is not valid UTF-8 round trips byte for byte", () => {
  const latin1Bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "caf<0xe9>\n"
  const fromGitHub = encodeBase64(latin1Bytes);

  const file = decodeGitHubBase64Text(fromGitHub);
  assertEquals(file.text, "café\n");
  assertEquals(file.text.includes("�"), false);
  assertEquals(file.encode(file.text), fromGitHub);
  assertEquals(
    file.encode(file.text.replace("caf", "CAF")),
    encodeBase64(new Uint8Array([0x43, 0x41, 0x46, 0xe9, 0x0a]))
  );
});

// The one case the byte-preserving codec cannot serve. Failing here is deliberate: the
// file's encoding is unknown, so there is no byte to write the new character as.
Deno.test("patching a non-UTF-8 file with a character it cannot hold fails loudly", () => {
  const file = decodeGitHubTextBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assertThrows(() => file.encode(file.text + "Yāo"), Error, "not valid UTF-8");
});

// The default TextDecoder swallows a leading byte-order mark, which would silently drop
// three bytes from a file the sync only meant to patch.
Deno.test("a byte-order mark survives the round trip", () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(HANDOUT_TEXT)]);
  const fromGitHub = encodeBase64(withBom);

  const file = decodeGitHubBase64Text(fromGitHub);
  assertEquals(file.text, "﻿" + HANDOUT_TEXT);
  assertEquals(file.encode(file.text), fromGitHub);
  assertEquals(new TextDecoder().decode(withBom), HANDOUT_TEXT); // what the default decoder does
});

// The patch-failure half, which is what students saw before any message dead-lettered:
// GitHub hands us the patch as decoded text, so a base read through atob no longer
// matches its own context lines.
Deno.test("a patch applies against the decoded base content and not against the Latin1 one", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    ` ${HANDOUT_LINES[0]}`,
    ` ${HANDOUT_LINES[1]}`,
    '+  updateUser("user3", { display: "Ada" });',
    ""
  ].join("\n");
  const fromGitHub = encodeTextAsGitHubBase64(HANDOUT_TEXT);

  const applied = applyPatch(decodeGitHubBase64Text(fromGitHub).text, patch);
  assert(applied !== false, "patch should apply to the decoded base content");
  assert(applied.includes("Ada"));
  assert(applied.includes("Yāo"), "the untouched non-ASCII lines stay intact");

  assertEquals(applyPatch(atob(fromGitHub), patch), false);
});
