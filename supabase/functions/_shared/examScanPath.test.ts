/**
 * Unit tests for the exam scan path ownership check (#1078).
 *
 * The worker-level behaviour (no read or copy of a foreign object, insert and update entry points,
 * real RLS and storage) is covered by tests/e2e/exam-scan-authorization.spec.ts.
 *
 * Run from supabase/functions:  deno test --no-check _shared/examScanPath.test.ts
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { assertScanPathInScope, parseScanPath, ScanPathRejectedError } from "./examScanPath.ts";

const SCOPE = { classId: 12, examId: 34, batchId: 56 };

Deno.test("parseScanPath: the uploader's key and the e2e fixture's key both parse", () => {
  assertEquals(parseScanPath("classes/12/exams/34/batches/56/page-0.png"), SCOPE);
  assertEquals(parseScanPath("classes/12/exams/34/batches/56/sis-100011__name-Alice_Smith__page-0.png"), SCOPE);
});

Deno.test("assertScanPathInScope: a path in the page's own class, exam and batch passes", () => {
  assertScanPathInScope("classes/12/exams/34/batches/56/page-3.png", SCOPE, "scan page 1");
});

Deno.test("assertScanPathInScope: another class, exam or batch is rejected", () => {
  for (const path of [
    "classes/99/exams/34/batches/56/page-0.png",
    "classes/12/exams/99/batches/56/page-0.png",
    "classes/12/exams/34/batches/99/page-0.png"
  ]) {
    assertThrows(() => assertScanPathInScope(path, SCOPE, "scan page 1"), ScanPathRejectedError, "does not belong");
  }
});

Deno.test("assertScanPathInScope: malformed and ambiguous paths are rejected", () => {
  for (const path of [
    "",
    "page-0.png",
    "/classes/12/exams/34/batches/56/page-0.png",
    "classes/12/exams/34/batches/56/",
    "classes/12/exams/34/batches/56/page-0.jpg",
    "classes/12/exams/34/batches/56/sub/page-0.png",
    "classes/12/exams/34/batches/56/../57/page-0.png",
    "classes/12/exams/34/batches/56/..png",
    "classes/12/exams/34/batches/56/.hidden.png",
    "classes//12/exams/34/batches/56/page-0.png",
    "classes/12/exams/34/batches/56/page%2F0.png",
    "classes/12/exams/34/batches/56/page 0.png",
    "classes/12/exams/34/batches/56/page\\0.png",
    "classes/12/exams/34/batches/56/page-0.png\n",
    "classes/012/exams/34/batches/56/page-0.png",
    "classes/+12/exams/34/batches/56/page-0.png",
    "classes/12.0/exams/34/batches/56/page-0.png",
    "classes/12/exams/34/batches/9999999999999999/page-0.png",
    "classes/12/templates/34/batches/56/page-0.png",
    "Classes/12/exams/34/batches/56/page-0.png"
  ]) {
    assertEquals(parseScanPath(path), null, `parsed: ${JSON.stringify(path)}`);
    assertThrows(
      () => assertScanPathInScope(path, SCOPE, "scan page 1"),
      ScanPathRejectedError,
      "not a canonical exam scan path"
    );
  }
});
