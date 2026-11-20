/**
 * Unit test for wordsInRegion (examVision.ts), the region matcher the exam worker
 * actually runs. `finalize` calls it once per answer region to turn OCR word boxes
 * into the text a grader reads.
 *
 * The implementation lives in _shared/examRegionText.ts and examVision.ts re-exports
 * it. lib/exam/regionMath.ts re-exports the same function for the seeder and the UI;
 * tests/unit/exam-region-math.test.ts only checks that re-export, so this file is
 * where wordsInRegion's behavior is tested (#1188).
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
  // Deliberately shuffled across three lines at y = 0.3, 0.4 and 0.5. Catches rows emitted in the
  // order their first word was seen rather than top to bottom.
  const words = [
    word("world", 0.4, 0.3),
    word("third", 0.25, 0.5),
    word("line", 0.4, 0.4),
    word("hello", 0.25, 0.3),
    word("row", 0.4, 0.5),
    word("second", 0.25, 0.4)
  ];
  assertEquals(wordsInRegion(words, REGION), "hello world second line third row");
});

Deno.test("words on one line sort left to right", () => {
  const words = [word("c", 0.5, 0.3), word("a", 0.25, 0.3), word("b", 0.35, 0.3)];
  assertEquals(wordsInRegion(words, REGION), "a b c");
});

// Each case is one printed line that has to come back left to right.
const ONE_LINE: { name: string; words: WordBox[]; text: string }[] = [
  {
    // Centers 0.311 and 0.309 straddle the old 0.31 band edge. Catches rows cut at fixed
    // positions, which read "right left".
    name: "centers either side of a fixed band edge",
    words: [word("right", 0.45, 0.299), word("left", 0.25, 0.301)],
    text: "left right"
  },
  {
    // Both centers sit at y 0.301; the tall box (a long word on a tilted scan) has its top edge
    // higher. Catches rows keyed on the top edge (#1292).
    name: "boxes of different heights on one center line",
    words: [word("long", 0.45, 0.281, 0.15, 0.04), word("short", 0.25, 0.291, 0.05, 0.02)],
    text: "short long"
  },
  {
    // Centers rise 0.004 across the line, the noise left after a scan is lined up. Catches a
    // tolerance so tight that OCR jitter splits a line.
    name: "a line drifting slightly upward",
    words: [word("d", 0.5, 0.296), word("b", 0.3, 0.2987), word("a", 0.2, 0.3), word("c", 0.4, 0.2973)],
    text: "a b c d"
  }
];
for (const c of ONE_LINE) {
  Deno.test(`one line stays in order: ${c.name}`, () => {
    assertEquals(wordsInRegion(c.words, REGION), c.text);
  });
}

// Short glyphs (punctuation, quote marks) sit inside a line without sharing its center line.
const MARKS: { name: string; words: WordBox[]; text: string }[] = [
  {
    // All three boxes end at y 0.311, CodeRabbit's example on #1331. Catches a baseline comma
    // forced onto its own row, which read "first second ,".
    name: "a comma on the baseline",
    words: [word("second", 0.4, 0.291), word(",", 0.33, 0.307, 0.01, 0.004), word("first", 0.25, 0.291)],
    text: "first , second"
  },
  {
    // The quote mark hangs from the top of the second line, nearer the first line's bottom edge than
    // the second's. Catches marks measured only against the edge below them, which read "a ' b it s".
    name: "a quote mark at the top of the line",
    words: [
      word("s", 0.4, 0.315),
      word("'", 0.33, 0.315, 0.01, 0.006),
      word("it", 0.25, 0.315),
      word("b", 0.45, 0.291),
      word("a", 0.25, 0.291)
    ],
    text: "a b it ' s"
  },
  {
    // Nothing full-size to attach to. Catches dropping marks when no row has a word.
    name: "a region holding only punctuation",
    words: [word("!", 0.4, 0.3, 0.01, 0.004), word("?", 0.25, 0.3, 0.01, 0.004)],
    text: "? !"
  }
];
for (const c of MARKS) {
  Deno.test(`short glyphs stay on their line: ${c.name}`, () => {
    assertEquals(wordsInRegion(c.words, REGION), c.text);
  });
}

Deno.test("lines 1.2 word heights apart stay separate", () => {
  // Line two's words sit between line one's across the page. Catches a tolerance loose enough to
  // merge neighbouring lines, which would read "a c b d".
  const words = [word("d", 0.5, 0.324), word("b", 0.45, 0.3), word("c", 0.3, 0.324), word("a", 0.25, 0.3)];
  assertEquals(wordsInRegion(words, REGION), "a b c d");
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

Deno.test("the fake provider's words reach across the page, not just one column", async () => {
  // The full-width bands above cannot catch a provider that puts every box in one column.
  // Adhiraj found exactly that on review: the first fix tiled down only, every box was x 0.1..0.4,
  // so a region missing x = 0.25 still got "". These columns fail against that version.
  const { words } = await new FakeExamVisionProvider().ocrImage({
    name: "exam__sis-12345__page-0.png",
    bytes: new Uint8Array(),
    width: 1224,
    height: 1584
  });
  for (const x of [0.0, 0.4, 0.8]) {
    const column: NormRect = { x, y: 0, width: 0.2, height: 1 };
    assertNotEquals(wordsInRegion(words, column), "", `no words in the column at x=${x}`);
  }
});

Deno.test("a mid-page region well away from the old hot spot still matches", async () => {
  // The concrete shape of the bug: nothing at x 0.6, y 0.5 before the grid.
  const { words } = await new FakeExamVisionProvider().ocrImage({
    name: "exam__sis-12345__page-0.png",
    bytes: new Uint8Array(),
    width: 1224,
    height: 1584
  });
  assertNotEquals(wordsInRegion(words, { x: 0.55, y: 0.45, width: 0.25, height: 0.2 }), "");
});
