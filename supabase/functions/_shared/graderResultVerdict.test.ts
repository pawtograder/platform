import { assertEquals } from "jsr:@std/assert@^1";
import {
  hasGradeableContent,
  resolveGraderResultConflictVerdict,
  type GraderResultConflictInputs
} from "./graderResultVerdict.ts";

const WINDOW = 60_000;

function verdict(overrides: Partial<GraderResultConflictInputs>) {
  return resolveGraderResultConflictVerdict({
    retCode: 0,
    gradeable: true,
    allowStaleOverwrite: false,
    existingAgeMs: 0,
    resetWindowMs: WINDOW,
    ...overrides
  });
}

// --- hasGradeableContent ---------------------------------------------------

Deno.test("hasGradeableContent: tests count as content", () => {
  assertEquals(hasGradeableContent({ tests: [{ name: "t" }] }), true);
});

Deno.test("hasGradeableContent: a positive score counts as content", () => {
  assertEquals(hasGradeableContent({ score: 3 }), true);
});

Deno.test("hasGradeableContent: a zero score does not — indistinguishable from 'no score computed'", () => {
  assertEquals(hasGradeableContent({ score: 0 }), false);
});

Deno.test("hasGradeableContent: artifacts and annotations count", () => {
  assertEquals(hasGradeableContent({ artifacts: [{ name: "a" }] }), true);
  assertEquals(hasGradeableContent({ annotations: [{}] }), true);
});

Deno.test("hasGradeableContent: empty and missing feedback are not content", () => {
  assertEquals(hasGradeableContent({}), false);
  assertEquals(hasGradeableContent({ tests: [], artifacts: [], annotations: [] }), false);
  assertEquals(hasGradeableContent(null), false);
  assertEquals(hasGradeableContent(undefined), false);
});

// --- resolveGraderResultConflictVerdict ------------------------------------

Deno.test("conflict: failed run with no gradeable content preserves the existing result", () => {
  // The regression this guard exists for: the action's own catch re-submits
  // ret_code 1 with tests [] and would otherwise reset a real grade to zero.
  assertEquals(verdict({ retCode: 1, gradeable: false }), "preserve");
});

Deno.test("conflict: a failed run that still produced tests overwrites", () => {
  // A grader exits non-zero simply because student tests failed. That is a real result.
  assertEquals(verdict({ retCode: 1, gradeable: true }), "overwrite");
});

Deno.test("conflict: a successful empty re-submit still overwrites", () => {
  assertEquals(verdict({ retCode: 0, gradeable: false }), "overwrite");
});

Deno.test("conflict: preserve outranks allowStaleOverwrite", () => {
  // A regression rerun that crashed must not destroy the result it was meant to replace.
  assertEquals(
    verdict({ retCode: 1, gradeable: false, allowStaleOverwrite: true, existingAgeMs: 10 * WINDOW }),
    "preserve"
  );
});

Deno.test("conflict: a successful rerun promotion overwrites at any age", () => {
  assertEquals(
    verdict({ retCode: 0, gradeable: true, allowStaleOverwrite: true, existingAgeMs: 10 * WINDOW }),
    "overwrite"
  );
});

Deno.test("conflict: a stale rewrite without promotion is rejected", () => {
  assertEquals(verdict({ gradeable: true, existingAgeMs: WINDOW + 1 }), "reject_stale");
});

Deno.test("conflict: exactly at the window boundary still overwrites", () => {
  assertEquals(verdict({ gradeable: true, existingAgeMs: WINDOW }), "overwrite");
});

Deno.test("conflict: a stale failed-and-empty payload is rejected, not preserved", () => {
  // The replay guard outranks the preserve guard. `preserve` is not a no-op — it stamps a
  // student-visible message onto grader_results.errors, inserts a public workflow_run_error row,
  // completes the check run and answers 200 — so letting it win here would let a replayed request
  // of any age reach a write path that SecurityError used to refuse outright.
  assertEquals(
    verdict({ retCode: 1, gradeable: false, allowStaleOverwrite: false, existingAgeMs: WINDOW + 1 }),
    "reject_stale"
  );
});

Deno.test("conflict: a missing ret_code is not read as failure", () => {
  // Conservative: an older or non-conforming runner keeps today's behavior rather
  // than having its writes silently dropped.
  assertEquals(verdict({ retCode: undefined, gradeable: false }), "overwrite");
  assertEquals(verdict({ retCode: null, gradeable: false }), "overwrite");
});
