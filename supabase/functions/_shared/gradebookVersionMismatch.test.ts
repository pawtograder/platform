/**
 * Tests for the gradebook version-mismatch recovery decisions.
 *
 * These exist because the recovery path had no coverage at all, and it is the path that runs when
 * contention is highest — a submission deadline. The two failure modes it shipped with were an
 * unguarded `is_recalculating` clear (which released another worker's claim) and an unbounded
 * re-enqueue (which could keep gradebook_row_recalculate self-sustaining instead of draining).
 * Both decisions are pure functions here so they can be pinned.
 *
 * Run from supabase/functions:  deno test --no-check _shared/gradebookVersionMismatch.test.ts
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import {
  groupVersionScopedClears,
  MAX_VERSION_MISMATCH_ATTEMPTS,
  partitionVersionMismatchRetries,
  selectVersionMismatchedRows,
  versionMismatchBackoffSeconds,
  versionMismatchRowKey,
  type GradebookRowBatchResult
} from "./gradebookVersionMismatch.ts";

function row(overrides: Partial<GradebookRowBatchResult> = {}): GradebookRowBatchResult {
  return {
    student_id: "s1",
    is_private: true,
    version_matched: false,
    cleared: false,
    error: null,
    expected_version: 4,
    current_version: 5,
    ...overrides
  };
}

Deno.test("selectVersionMismatchedRows picks only rows that lost the race and were not cleared", () => {
  const rows = [
    row({ student_id: "mismatched" }),
    row({ student_id: "matched", version_matched: true, cleared: true }),
    row({ student_id: "errored", error: "boom" }),
    row({ student_id: "cleared-anyway", cleared: true })
  ];
  assertEquals(
    selectVersionMismatchedRows(rows).map((r) => r.student_id),
    ["mismatched"]
  );
});

Deno.test("groupVersionScopedClears collapses one statement per (is_private, version)", () => {
  const { clears, withoutVersion } = groupVersionScopedClears([
    row({ student_id: "a", current_version: 5 }),
    row({ student_id: "b", current_version: 5 }),
    row({ student_id: "c", current_version: 6 }),
    row({ student_id: "d", current_version: 5, is_private: false })
  ]);
  assertEquals(withoutVersion.length, 0);
  assertEquals(clears.length, 3);
  assertEquals(
    clears.find((c) => c.version === 5 && c.is_private)!.student_ids,
    ["a", "b"],
    "same version and privacy must batch into a single UPDATE"
  );
  assertEquals(clears.find((c) => c.version === 6)!.student_ids, ["c"]);
  assertEquals(clears.find((c) => !c.is_private)!.student_ids, ["d"]);
});

// A row with no version cannot be cleared safely: there is nothing to scope the predicate to, and
// guessing one is how the original bug released a claim it did not hold.
Deno.test("groupVersionScopedClears refuses to clear rows with no current_version", () => {
  const { clears, withoutVersion } = groupVersionScopedClears([
    row({ student_id: "no-state", current_version: null }),
    row({ student_id: "undefined-state", current_version: undefined }),
    row({ student_id: "ok", current_version: 9 })
  ]);
  assertEquals(
    withoutVersion.map((r) => r.student_id),
    ["no-state", "undefined-state"]
  );
  assertEquals(clears.length, 1);
  assertEquals(clears[0].student_ids, ["ok"]);
});

// Version 0 is a real version (the column defaults to 0), so it must not be treated as absent.
Deno.test("groupVersionScopedClears treats version 0 as a version, not as missing", () => {
  const { clears, withoutVersion } = groupVersionScopedClears([row({ current_version: 0 })]);
  assertEquals(withoutVersion.length, 0);
  assertEquals(clears.length, 1);
  assertEquals(clears[0].version, 0);
});

Deno.test("partitionVersionMismatchRetries increments the attempt carried in the payload", () => {
  const { retries, dead } = partitionVersionMismatchRetries([row({ student_id: "fresh" })], () => 0);
  assertEquals(dead.length, 0);
  assertEquals(retries.length, 1);
  assertEquals(retries[0].attempt, 1);
  assertEquals(
    retries[0].rows.map((r) => r.student_id),
    ["fresh"]
  );
});

Deno.test("partitionVersionMismatchRetries groups rows by attempt so each batch gets one delay", () => {
  const attempts: Record<string, number> = { a: 0, b: 0, c: 3 };
  const { retries } = partitionVersionMismatchRetries(
    [row({ student_id: "a" }), row({ student_id: "b" }), row({ student_id: "c" })],
    (r) => attempts[r.student_id]
  );
  assertEquals(
    retries.map((r) => [r.attempt, r.rows.map((x) => x.student_id)]),
    [
      [1, ["a", "b"]],
      [4, ["c"]]
    ]
  );
});

// THE CEILING. update_gradebook_rows_batch archives every message id it is handed, so send_batch
// mints a fresh message with read_ct back at 0 — without this the loop had no bound at all.
Deno.test("partitionVersionMismatchRetries dead-letters past the ceiling", () => {
  const { retries, dead } = partitionVersionMismatchRetries(
    [row({ student_id: "last-chance" }), row({ student_id: "exhausted" })],
    (r) => (r.student_id === "exhausted" ? MAX_VERSION_MISMATCH_ATTEMPTS : MAX_VERSION_MISMATCH_ATTEMPTS - 1)
  );
  assertEquals(retries.length, 1);
  assertEquals(retries[0].attempt, MAX_VERSION_MISMATCH_ATTEMPTS);
  assertEquals(
    retries[0].rows.map((r) => r.student_id),
    ["last-chance"]
  );
  assertEquals(dead.length, 1);
  assertEquals(dead[0].row.student_id, "exhausted");
  assertEquals(dead[0].attempt, MAX_VERSION_MISMATCH_ATTEMPTS);
});

Deno.test("a row that gives up is never silently dropped: it lands in dead, not in retries", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ student_id: `s${i}` }));
  const { retries, dead } = partitionVersionMismatchRetries(rows, () => 99);
  assertEquals(retries.length, 0);
  assertEquals(dead.length, rows.length, "every exhausted row must be accounted for as dead-lettered");
});

Deno.test("versionMismatchBackoffSeconds grows and then caps", () => {
  const noJitter = () => 0;
  assertEquals(versionMismatchBackoffSeconds(1, noJitter), 5);
  assertEquals(versionMismatchBackoffSeconds(2, noJitter), 10);
  assertEquals(versionMismatchBackoffSeconds(3, noJitter), 20);
  assertEquals(versionMismatchBackoffSeconds(7, noJitter), 300);
  assertEquals(versionMismatchBackoffSeconds(100, noJitter), 300, "capped so a retry is never parked for hours");
});

// The first retry has to be delayed, not immediate: an immediate re-enqueue is what turned recovery
// into a busy loop against exactly the rows already under version contention.
Deno.test("versionMismatchBackoffSeconds never returns 0 for a real attempt", () => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    assertNotEquals(
      versionMismatchBackoffSeconds(attempt, () => 0),
      0
    );
  }
});

Deno.test("versionMismatchBackoffSeconds adds bounded jitter", () => {
  const maxJitter = versionMismatchBackoffSeconds(3, () => 0.999);
  assertEquals(maxJitter <= 20 + 20 / 4, true, `expected <= 25, got ${maxJitter}`);
  assertEquals(maxJitter > 20, true, "jitter should spread retries apart");
});

Deno.test("versionMismatchRowKey distinguishes the two privacy variants of one student", () => {
  assertNotEquals(versionMismatchRowKey("s1", true), versionMismatchRowKey("s1", false));
});
