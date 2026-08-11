import { assertEquals } from "jsr:@std/assert@^1";
import { describeHandoutSeedResult, isExpectedHandoutSeedSkip, type HandoutSeedResult } from "./handoutFileHashes.ts";

Deno.test("a seeded result is not a skip", () => {
  assertEquals(isExpectedHandoutSeedSkip({ seeded: true }), false);
});

Deno.test("the three expected skips are skips", () => {
  for (const skipReason of ["no_template_repo", "no_commit_sha", "no_submission_files"] as const) {
    assertEquals(isExpectedHandoutSeedSkip({ seeded: false, skipReason }), true, skipReason);
  }
});

Deno.test("a caught failure is not a skip", () => {
  assertEquals(isExpectedHandoutSeedSkip({ seeded: false, failureReason: "boom" }), false);
});

// The reason the two live in separate fields. While both shared one `reason` string, an exception
// whose message happened to read like an expected skip would have been classified as one, and the
// grader-config pointer would have advanced over hashes that were never rebuilt. The type now makes
// that state unrepresentable; this pins the behaviour that motivated it.
Deno.test("a failure whose message looks like a skip reason is still a failure", () => {
  const result: HandoutSeedResult = { seeded: false, failureReason: "no_commit_sha" };
  assertEquals(isExpectedHandoutSeedSkip(result), false);
  assertEquals(describeHandoutSeedResult(result), "no_commit_sha");
});

Deno.test("describeHandoutSeedResult reports whichever reason is present", () => {
  assertEquals(describeHandoutSeedResult({ seeded: true }), "seeded");
  assertEquals(describeHandoutSeedResult({ seeded: false, skipReason: "no_commit_sha" }), "no_commit_sha");
  assertEquals(describeHandoutSeedResult({ seeded: false, failureReason: "timeout" }), "timeout");
});
