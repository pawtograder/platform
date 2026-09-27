/**
 * Unit test for the shared PR-state normalization helper (PrState.ts).
 *
 * Covers the four output states and the precedence between them, plus the two
 * input shapes the real callers pass (webhook payload signalling merge via
 * `merged_at`; REST result signalling merge via the `merged` boolean).
 *
 * Run from supabase/functions:  deno test _shared/PrState.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { prStateFromPullRequest } from "./PrState.ts";

Deno.test("merged via merged_at (webhook shape) -> merged", () => {
  assertEquals(prStateFromPullRequest({ merged_at: "2026-01-01T00:00:00Z", state: "closed", draft: false }), "merged");
});

Deno.test("merged via merged boolean (REST shape) -> merged", () => {
  assertEquals(prStateFromPullRequest({ merged: true, state: "closed", draft: false }), "merged");
});

Deno.test("closed (not merged) -> closed", () => {
  assertEquals(prStateFromPullRequest({ merged_at: null, merged: false, state: "closed", draft: false }), "closed");
});

Deno.test("open + draft -> draft", () => {
  assertEquals(prStateFromPullRequest({ merged_at: null, state: "open", draft: true }), "draft");
});

Deno.test("open + not draft -> open", () => {
  assertEquals(prStateFromPullRequest({ merged_at: null, state: "open", draft: false }), "open");
});

Deno.test("reopened arrives as state=open -> open", () => {
  assertEquals(prStateFromPullRequest({ merged_at: null, state: "open" }), "open");
});

Deno.test("merge takes precedence over a still-open/draft state", () => {
  // A merged PR can report draft=false/state=closed, but if a payload ever carries
  // merged_at alongside draft, merge must still win.
  assertEquals(prStateFromPullRequest({ merged_at: "2026-01-01T00:00:00Z", state: "open", draft: true }), "merged");
});

Deno.test("missing optional fields default to open", () => {
  assertEquals(prStateFromPullRequest({}), "open");
});
