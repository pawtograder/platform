/**
 * Truth-table tests for resolveEmptySubmissionVerdict.
 *
 * These exist because the inline version of this decision had NO coverage: the only
 * suite touching the push-direct path (push-no-autograder.test.tsx) takes the
 * E2E_MOCK_GITHUB shortcut, which writes a canned file and returns before ingestion,
 * so the empty-check branch never executed in any test. A regression there silently
 * broke every push on repo-only assignments.
 *
 * Run from supabase/functions:  deno test --no-check _shared/emptySubmissionVerdict.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { resolveEmptySubmissionVerdict } from "./emptySubmissionVerdict.ts";

// THE REGRESSION CASE. An assignment with no submissionFiles yields isEmpty=null by
// design, and permit_empty_submissions defaults to false. Treating that as a failed
// check deleted and retried every push forever — on exactly the assignments the
// repo-only feature is for.
Deno.test("no submissionFiles + empty prohibited -> accept (never retry)", () => {
  assertEquals(
    resolveEmptySubmissionVerdict({ permitEmptySubmissions: false, canDetectEmpty: false, isEmpty: null }),
    "accept"
  );
});

Deno.test("check ran, verified non-empty, empty prohibited -> accept", () => {
  assertEquals(
    resolveEmptySubmissionVerdict({ permitEmptySubmissions: false, canDetectEmpty: true, isEmpty: false }),
    "accept"
  );
});

Deno.test("check ran, verified empty, empty prohibited -> reject_empty", () => {
  assertEquals(
    resolveEmptySubmissionVerdict({ permitEmptySubmissions: false, canDetectEmpty: true, isEmpty: true }),
    "reject_empty"
  );
});

// Fail closed only when the check was actually asked for and could not conclude.
Deno.test("check ran but lookup failed, empty prohibited -> retry_unknown", () => {
  assertEquals(
    resolveEmptySubmissionVerdict({ permitEmptySubmissions: false, canDetectEmpty: true, isEmpty: null }),
    "retry_unknown"
  );
});

// permit_empty_submissions short-circuits everything: there is no policy to enforce.
Deno.test("empty permitted -> accept regardless of the check outcome", () => {
  for (const canDetectEmpty of [true, false]) {
    for (const isEmpty of [true, false, null]) {
      assertEquals(
        resolveEmptySubmissionVerdict({ permitEmptySubmissions: true, canDetectEmpty, isEmpty }),
        "accept",
        `permitEmptySubmissions=true should accept (canDetectEmpty=${canDetectEmpty}, isEmpty=${isEmpty})`
      );
    }
  }
});

// Guards the invariant that matters most: nothing but a CONFIRMED empty verdict may
// reject, and nothing but a FAILED check may ask GitHub to retry.
Deno.test("only a confirmed-empty verdict rejects, only a failed check retries", () => {
  const rejecting: EmptyCase[] = [];
  const retrying: EmptyCase[] = [];
  for (const permitEmptySubmissions of [true, false]) {
    for (const canDetectEmpty of [true, false]) {
      for (const isEmpty of [true, false, null]) {
        const v = resolveEmptySubmissionVerdict({ permitEmptySubmissions, canDetectEmpty, isEmpty });
        if (v === "reject_empty") rejecting.push({ permitEmptySubmissions, canDetectEmpty, isEmpty });
        if (v === "retry_unknown") retrying.push({ permitEmptySubmissions, canDetectEmpty, isEmpty });
      }
    }
  }
  assertEquals(rejecting, [{ permitEmptySubmissions: false, canDetectEmpty: true, isEmpty: true }]);
  assertEquals(retrying, [{ permitEmptySubmissions: false, canDetectEmpty: true, isEmpty: null }]);
});

type EmptyCase = { permitEmptySubmissions: boolean; canDetectEmpty: boolean; isEmpty: boolean | null };
