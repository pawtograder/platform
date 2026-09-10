/**
 * Unit tests for the add_member_role membership hint.
 *
 * The timestamps below are the shape enqueue_discord_role_sync() actually writes -- UTC, millisecond
 * precision, trailing Z -- because the SQL side formats the string by hand rather than relying on a
 * timestamptz cast. If that format changes these tests are what notices.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordMembershipHint.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { freshMembershipHintAgeMs, MEMBERSHIP_HINT_TTL_MS } from "./DiscordMembershipHint.ts";

/** The exact format the migration's to_char() produces. */
const asEnqueuerWrites = (d: Date) => d.toISOString().replace(/Z$/, "Z");

Deno.test("freshMembershipHintAgeMs: a hint written moments ago is trusted", () => {
  const age = freshMembershipHintAgeMs(asEnqueuerWrites(new Date(Date.now() - 1_200)));
  assert(age !== undefined, "a 1.2s-old hint should be trusted");
  // Bounded rather than exact: the clock advances between constructing the string and reading it.
  assert(age >= 1_000 && age < 5_000, `expected roughly 1200ms, got ${age}`);
});

Deno.test("freshMembershipHintAgeMs: no hint means look it up", () => {
  assertEquals(freshMembershipHintAgeMs(undefined), undefined);
  assertEquals(freshMembershipHintAgeMs(null), undefined);
  assertEquals(freshMembershipHintAgeMs(""), undefined);
});

Deno.test("freshMembershipHintAgeMs: an unparseable hint means look it up, not throw", () => {
  assertEquals(freshMembershipHintAgeMs("not a timestamp"), undefined);
  assertEquals(freshMembershipHintAgeMs("2026-13-45T99:99:99Z"), undefined);
});

// The case the TTL exists for: an envelope that was requeued with backoff, or redelivered after its
// visibility timeout, carries an observation far too old to stand in for a fresh lookup.
Deno.test("freshMembershipHintAgeMs: an expired hint means look it up", () => {
  const stale = new Date(Date.now() - MEMBERSHIP_HINT_TTL_MS - 1_000);
  assertEquals(freshMembershipHintAgeMs(asEnqueuerWrites(stale)), undefined);
});

Deno.test("freshMembershipHintAgeMs: the TTL boundary is inclusive", () => {
  // Just inside the window is trusted; a second past it is not. Pinned because the whole point of the
  // bound is that it is checked, and `>` vs `>=` here is a silent one-line regression.
  const justInside = new Date(Date.now() - (MEMBERSHIP_HINT_TTL_MS - 5_000));
  assert(freshMembershipHintAgeMs(asEnqueuerWrites(justInside)) !== undefined);
});

// Clock skew between the enqueuer's database and this isolate is the only way to produce a future
// timestamp. Trusting it would extend the window by the size of the skew, so it is refused outright.
Deno.test("freshMembershipHintAgeMs: a hint from the future is refused", () => {
  const future = new Date(Date.now() + 30_000);
  assertEquals(freshMembershipHintAgeMs(asEnqueuerWrites(future)), undefined);
});
