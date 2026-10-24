import { assertEquals } from "jsr:@std/assert@^1";
import { describeSettledSummary, mergeSettledSummaries, summarizeSettled } from "./settledSummary.ts";

function fulfilled(value: unknown = null): PromiseSettledResult<unknown> {
  return { status: "fulfilled", value };
}
function rejected(reason: unknown): PromiseSettledResult<unknown> {
  return { status: "rejected", reason };
}

Deno.test("summarizeSettled: all fulfilled reports zero failures", () => {
  const s = summarizeSettled([fulfilled(), fulfilled()]);
  assertEquals(
    { attempted: s.attempted, succeeded: s.succeeded, failed: s.failed },
    {
      attempted: 2,
      succeeded: 2,
      failed: 0
    }
  );
  assertEquals(s.reasons, []);
});

Deno.test("summarizeSettled: mixed results count both sides", () => {
  const s = summarizeSettled([fulfilled(), rejected(new Error("boom")), fulfilled()]);
  assertEquals(
    { attempted: s.attempted, succeeded: s.succeeded, failed: s.failed },
    {
      attempted: 3,
      succeeded: 2,
      failed: 1
    }
  );
  assertEquals(s.reasons.length, 1);
  assertEquals(s.reasons[0].includes("boom"), true);
});

Deno.test("summarizeSettled: all rejected is not mistaken for success", () => {
  // The exact shape that used to report "All repositories created successfully".
  const s = summarizeSettled([rejected(new Error("a")), rejected(new Error("b"))]);
  assertEquals(s.succeeded, 0);
  assertEquals(s.failed, 2);
});

Deno.test("summarizeSettled: non-Error rejection reasons are described, not '[object Object]'", () => {
  // PostgREST and GoTrue reject with plain objects.
  const s = summarizeSettled([rejected({ message: "duplicate key", code: "23505" })]);
  assertEquals(s.reasons[0].includes("[object Object]"), false);
  assertEquals(s.reasons[0].includes("duplicate key"), true);
});

Deno.test("summarizeSettled: label prefixes each reason", () => {
  const s = summarizeSettled([rejected(new Error("nope"))], { label: "create" });
  assertEquals(s.reasons[0].startsWith("create: "), true);
});

Deno.test("summarizeSettled: reasons are capped and the remainder is counted, never silently dropped", () => {
  const s = summarizeSettled(
    Array.from({ length: 15 }, (_, i) => rejected(new Error(`e${i}`))),
    { maxReasons: 10 }
  );
  assertEquals(s.failed, 15);
  assertEquals(s.reasons.length, 10);
  assertEquals(s.truncatedReasons, 5);
});

Deno.test("mergeSettledSummaries: folds counts and preserves truncation", () => {
  const a = summarizeSettled([fulfilled(), rejected(new Error("x"))]);
  const b = summarizeSettled([rejected(new Error("y")), rejected(new Error("z"))]);
  const merged = mergeSettledSummaries([a, b]);
  assertEquals(
    { attempted: merged.attempted, succeeded: merged.succeeded, failed: merged.failed },
    {
      attempted: 4,
      succeeded: 1,
      failed: 3
    }
  );
  assertEquals(merged.reasons.length, 3);
});

Deno.test("describeSettledSummary: success and failure phrasing", () => {
  assertEquals(describeSettledSummary(summarizeSettled([fulfilled(), fulfilled()])), "2/2 succeeded");

  const failed = describeSettledSummary(summarizeSettled([fulfilled(), rejected(new Error("boom"))]));
  assertEquals(failed.startsWith("1/2 failed:"), true);
  assertEquals(failed.includes("boom"), true);
});

Deno.test("describeSettledSummary: names how many reasons were withheld", () => {
  const s = summarizeSettled(
    Array.from({ length: 12 }, (_, i) => rejected(new Error(`e${i}`))),
    { maxReasons: 2 }
  );
  assertEquals(describeSettledSummary(s).includes("(+10 more)"), true);
});
