/**
 * Pins the engine's copy of the binary-extension list to the REST sync's (spec §5.3). The REST
 * module cannot be imported here without Redis, Sentry and Supabase, so the two function bodies are
 * compared as source text.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { isBinaryPath } from "./binaryPath.ts";

function body(source: string): string {
  const start = source.indexOf("function isBinaryPath(path: string): boolean {");
  assert(start >= 0, "isBinaryPath not found");
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

Deno.test("the engine's isBinaryPath is the REST sync's, byte for byte", async () => {
  const ours = await Deno.readTextFile(new URL("./binaryPath.ts", import.meta.url));
  const theirs = await Deno.readTextFile(new URL("../GitHubSyncHelpers.ts", import.meta.url));
  assertEquals(body(ours), body(theirs));
});

Deno.test("isBinaryPath matches on extension, case-insensitively, and nothing else", () => {
  assert(isBinaryPath("docs/Spec.PDF"));
  assert(isBinaryPath("lib/x.class"));
  assert(!isBinaryPath("src/main.ts"));
  assert(!isBinaryPath("pdf"));
});
