/**
 * Unit tests for thrown-value descriptions.
 *
 * The PostgREST case is the reason this exists: its errors are plain objects, so an `instanceof Error`
 * test renders them `[object Object]` and an outage arrives with nothing to diagnose it by.
 *
 * Run from supabase/functions:  deno test --no-check _shared/ErrorDetail.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { describeCause, isDuplicateKey } from "./ErrorDetail.ts";

Deno.test("describeCause: a PostgREST error object keeps its message and code", () => {
  // Verbatim shape from a Dev-project event.
  assertEquals(
    describeCause({
      code: "PGRST116",
      details: "The result contains 0 rows",
      hint: null,
      message: "Cannot coerce the result to a single JSON object"
    }),
    "Cannot coerce the result to a single JSON object (PGRST116)"
  );
});

Deno.test("describeCause: a message without a code is returned as-is", () => {
  assertEquals(
    describeCause({ message: "An invalid response was received from the upstream server" }),
    "An invalid response was received from the upstream server"
  );
});

Deno.test("describeCause: a real Error uses its message", () => {
  assertEquals(describeCause(new Error("boom")), "boom");
});

Deno.test("describeCause: an object with no message falls back to JSON, never [object Object]", () => {
  assertEquals(describeCause({ status: 502 }), '{"status":502}');
});

Deno.test("describeCause: a circular object does not throw from the error path", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assertEquals(describeCause(circular), "[object Object]");
});

Deno.test("describeCause: primitives stringify", () => {
  assertEquals(describeCause("plain string"), "plain string");
  assertEquals(describeCause(null), "null");
  assertEquals(describeCause(undefined), "undefined");
});

Deno.test("isDuplicateKey: a PostgREST unique violation matches", () => {
  // Verbatim shape from the prod `handleDelete` events (revoked_token_ids_pkey).
  assertEquals(
    isDuplicateKey({
      code: "23505",
      details: "Key (token_id)=(d30dc25a-839c-4fe3-ae82-1ab815227eb6) already exists.",
      hint: null,
      message: 'duplicate key value violates unique constraint "revoked_token_ids_pkey"'
    }),
    true
  );
});

Deno.test("isDuplicateKey: other Postgres errors do not match", () => {
  // 23503 is a foreign-key violation — a real inconsistency, not an idempotent repeat.
  assertEquals(isDuplicateKey({ code: "23503", message: "violates foreign key constraint" }), false);
  assertEquals(isDuplicateKey({ code: "PGRST116", message: "no rows" }), false);
  // A transport failure has no code at all and must never be mistaken for a benign duplicate.
  assertEquals(isDuplicateKey({ message: "An invalid response was received from the upstream server" }), false);
});

Deno.test("isDuplicateKey: non-objects are safe", () => {
  assertEquals(isDuplicateKey(null), false);
  assertEquals(isDuplicateKey(undefined), false);
  assertEquals(isDuplicateKey("23505"), false);
  assertEquals(isDuplicateKey(new Error("duplicate key value violates unique constraint")), false);
});
