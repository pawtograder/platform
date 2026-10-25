/**
 * Unit test for wordsInRegion (examVision.ts), the region matcher the exam worker
 * actually runs. `finalize` calls it once per answer region to turn OCR word boxes
 * into the text a grader reads.
 *
 * There is a second copy of this logic in lib/exam/regionMath.ts, and that copy is
 * the one covered by tests/unit/exam-region-math.test.ts. Nothing imports it at
 * runtime, so until now the shipped implementation here had no test at all.
 *
 * Coordinates are normalized 0..1 with the origin at the top-left of the page.
 *
 * Run from supabase/functions:  deno test _shared/examVision.test.ts
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { FakeExamVisionProvider, wordsInRegion, type NormRect, type WordBox } from "./examVision.ts";

/** Quarter of the page, from (0.2, 0.2) to (0.6, 0.6). */
const REGION: NormRect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

function word(text: string, x: number, y: number, width = 0.05, height = 0.02): WordBox {
  return { text, x, y, width, height };
}

Deno.test("a word whose center is inside the region is kept", () => {
  assertEquals(wordsInRegion([word("inside", 0.35, 0.35)], REGION), "inside");
});

Deno.test("a word whose center is outside the region is dropped", () => {
  assertEquals(wordsInRegion([word("outside", 0.8, 0.8)], REGION), "");
});

Deno.test("membership is decided by the center, not by overlap", () => {
  // Starts inside the region and overlaps it, but its center (0.62) is past the right edge.
  assertEquals(wordsInRegion([word("overlapping", 0.58, 0.3, 0.08)], REGION), "");
});

Deno.test("a center exactly on the edge counts as inside", () => {
  // center lands on x = 0.2 and y = 0.2, the region's top-left corner
  assertEquals(wordsInRegion([word("corner", 0.15, 0.19, 0.1, 0.02)], REGION), "corner");
  // center lands on x = 0.6 and y = 0.6, the bottom-right corner
  assertEquals(wordsInRegion([word("far", 0.55, 0.59, 0.1, 0.02)], REGION), "far");
});

Deno.test("words come back in reading order: top to bottom, then left to right", () => {
  // Deliberately shuffled: the first row is y = 0.3, the second is y = 0.4.
  const words = [word("world", 0.4, 0.3), word("line", 0.4, 0.4), word("hello", 0.25, 0.3), word("second", 0.25, 0.4)];
  assertEquals(wordsInRegion(words, REGION), "hello world second line");
});

Deno.test("words on one line sort left to right", () => {
  const words = [word("c", 0.5, 0.3), word("a", 0.25, 0.3), word("b", 0.35, 0.3)];
  assertEquals(wordsInRegion(words, REGION), "a b c");
});

Deno.test("rows are bucketed, so a small vertical wobble stays on one line", () => {
  // Both centers round into the same 0.02-tall band, so x decides the order.
  // A larger tilt can split one printed line across two bands and reorder it: see #1089.
  const words = [word("right", 0.45, 0.3005), word("left", 0.25, 0.3)];
  assertEquals(wordsInRegion(words, REGION), "left right");
});

Deno.test("an empty word list returns empty text", () => {
  assertEquals(wordsInRegion([], REGION), "");
});

Deno.test("a region with no words in it returns empty text", () => {
  const words = [word("far", 0.9, 0.9), word("away", 0.05, 0.05)];
  assertEquals(wordsInRegion(words, REGION), "");
});

// The fake provider is the OCR backend every offline test runs against, so where it puts its
// word boxes decides whether those tests exercise the region matcher at all.
Deno.test("the fake provider puts words under a region like the e2e fixture's", async () => {
  // tests/e2e/exam-grading.spec.ts places its answer region at y 0.3..0.5. The provider used to
  // pin its two tokens at y 0.10 and 0.15, so that region matched nothing, ocr_text was always
  // "" and an assertion that it is non-empty could never have passed.
  const E2E_ANSWER_REGION: NormRect = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };
  const { words } = await new FakeExamVisionProvider().ocrImage({
    name: "exam__sis-12345__page-0.png",
    bytes: new Uint8Array(),
    width: 1224,
    height: 1584
  });
  assertNotEquals(wordsInRegion(words, E2E_ANSWER_REGION), "");
});

Deno.test("the fake provider's words reach the whole page, not just the top", async () => {
  const { words } = await new FakeExamVisionProvider().ocrImage({
    name: "exam__sis-12345__page-0.png",
    bytes: new Uint8Array(),
    width: 1224,
    height: 1584
  });
  // A band in each third of the page should contain something.
  for (const y of [0.05, 0.4, 0.8]) {
    const band: NormRect = { x: 0, y, width: 1, height: 0.1 };
    assertNotEquals(wordsInRegion(words, band), "", `no words in the band at y=${y}`);
  }
});
