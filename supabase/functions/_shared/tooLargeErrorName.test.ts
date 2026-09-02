/**
 * Unit tests for buildTooLargeErrorName.
 *
 * The invariant under test is the one the database enforces: length <= 500. Getting it wrong
 * is not a one-off failure — the message is deterministic, so an over-long value fails
 * identically on every webhook retry, the retained submission is cleaned up each time, and
 * the student never learns their push was rejected.
 *
 * Run from supabase/functions:  deno test --no-check _shared/tooLargeErrorName.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  buildTooLargeErrorName,
  MAX_ERROR_NAME_LENGTH,
  MAX_ERROR_NAME_PATH_LENGTH,
  shortenPathForErrorName
} from "./tooLargeErrorName.ts";

const SHORT_SHA = "abc1234";

Deno.test("an ordinary path is left alone", () => {
  const name = buildTooLargeErrorName({
    kind: "file_too_large",
    shortSha: SHORT_SHA,
    fileName: "src/main/resources/dataset.zip",
    fileSize: 60 * 1024 * 1024,
    perFileLimitMb: 50
  });
  assertStringIncludes(name, '"src/main/resources/dataset.zip"');
  assertStringIncludes(name, "60.0 MB");
  assert(name.length <= MAX_ERROR_NAME_LENGTH);
});

// The case that motivated this: a deeply nested path, which used to push the finished
// message past the constraint.
Deno.test("a pathological path still fits the length constraint", () => {
  const deepPath = `${"nested-directory/".repeat(60)}enormous-dataset.zip`;
  assert(deepPath.length > 1000, "fixture should exceed the limit on its own");
  const name = buildTooLargeErrorName({
    kind: "file_too_large",
    shortSha: SHORT_SHA,
    fileName: deepPath,
    fileSize: 120 * 1024 * 1024,
    perFileLimitMb: 50
  });
  assert(name.length <= MAX_ERROR_NAME_LENGTH, `name was ${name.length} characters`);
});

// The sha is what keeps two oversized pushes from collapsing onto one upsert row, so no
// amount of bounding may drop it.
Deno.test("the commit sha survives bounding", () => {
  const name = buildTooLargeErrorName({
    kind: "file_too_large",
    shortSha: SHORT_SHA,
    fileName: "x/".repeat(5000) + "blob.bin",
    fileSize: 999 * 1024 * 1024,
    perFileLimitMb: 50
  });
  assertStringIncludes(name, SHORT_SHA);
  assert(name.length <= MAX_ERROR_NAME_LENGTH);
});

// Both ends of the path are what let a student find the file.
Deno.test("shortening keeps the leading directories and the file name", () => {
  const deepPath = `top-level/${"middle/".repeat(80)}the-actual-file.zip`;
  const shortened = shortenPathForErrorName(deepPath);
  assert(shortened.length <= MAX_ERROR_NAME_PATH_LENGTH);
  assertStringIncludes(shortened, "top-level/");
  assertStringIncludes(shortened, "the-actual-file.zip");
  assertStringIncludes(shortened, "…");
});

Deno.test("a path at exactly the limit is not shortened", () => {
  const exact = "a".repeat(MAX_ERROR_NAME_PATH_LENGTH);
  assertEquals(shortenPathForErrorName(exact), exact);
});

Deno.test("the repository-too-large message fits and names the commit", () => {
  const name = buildTooLargeErrorName({
    kind: "submission_too_large",
    shortSha: SHORT_SHA,
    observedMb: 812,
    limitMb: 200
  });
  assertStringIncludes(name, SHORT_SHA);
  assertStringIncludes(name, "812 MB");
  assertStringIncludes(name, "limit 200 MB");
  assert(name.length <= MAX_ERROR_NAME_LENGTH);
});

// Two oversized pushes of the SAME file must not produce the same name, or the upsert moves
// one row's submission_id instead of recording both rejections.
Deno.test("different commits produce different names for the same file", () => {
  const forSha = (shortSha: string) =>
    buildTooLargeErrorName({
      kind: "file_too_large",
      shortSha,
      fileName: "data/big.zip",
      fileSize: 60 * 1024 * 1024,
      perFileLimitMb: 50
    });
  assert(forSha("abc1234") !== forSha("def5678"));
});
