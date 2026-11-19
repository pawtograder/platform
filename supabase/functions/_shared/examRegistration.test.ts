/**
 * Unit tests for examRegistration.ts, which lines a scan page up with its template page (#1292).
 *
 * Run from supabase/functions:  deno test _shared/examRegistration.test.ts
 */
import { assertAlmostEquals, assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@^1";
import { FakeExamVisionProvider, wordsInRegion, type NormRect, type WordBox } from "./examVision.ts";
import {
  alignPage,
  AS_DRAWN,
  MIN_PAIRS,
  mapRectToScan,
  pairWords,
  registerPage,
  wordsToTemplate,
  type Registration
} from "./examRegistration.ts";

const TEMPLATE = { width: 850, height: 1100 };

const degrees = (r: Registration) => (Math.atan2(r.b, r.a) * 180) / Math.PI;
const scaleOf = (r: Registration) => Math.hypot(r.a, r.b);

type Tilt = { deg: number; scale: number; dx: number; dy: number };

/** Where a template pixel lands on the scan: rotate about the top-left corner, scale, then shift. */
function toScanPx(x: number, y: number, t: Tilt): { x: number; y: number } {
  const r = (t.deg * Math.PI) / 180;
  return {
    x: t.scale * (x * Math.cos(r) - y * Math.sin(r)) + t.dx,
    y: t.scale * (x * Math.sin(r) + y * Math.cos(r)) + t.dy
  };
}

function word(text: string, x: number, y: number, width = 0.06, height = 0.015): WordBox {
  return { text, x, y, width, height };
}

/** The same word as OCR would report it on the tilted scan: same center, straight box. */
function onScan(w: WordBox, t: Tilt, scan: { width: number; height: number }): WordBox {
  const c = toScanPx((w.x + w.width / 2) * TEMPLATE.width, (w.y + w.height / 2) * TEMPLATE.height, t);
  const width = (w.width * TEMPLATE.width * t.scale) / scan.width;
  const height = (w.height * TEMPLATE.height * t.scale) / scan.height;
  return { text: w.text, x: c.x / scan.width - width / 2, y: c.y / scan.height - height / 2, width, height };
}

/** Twelve printed words spread over the page, each appearing once. */
const PRINTED: WordBox[] = [
  word("Instructions", 0.1, 0.05),
  word("Name", 0.1, 0.1),
  word("Student", 0.6, 0.1),
  word("Question", 0.1, 0.2),
  word("Explain", 0.3, 0.2),
  word("complexity", 0.5, 0.2),
  word("Points", 0.8, 0.2),
  word("Describe", 0.1, 0.6),
  word("Consider", 0.4, 0.6),
  word("Section", 0.7, 0.6),
  word("Total", 0.1, 0.9),
  word("Page", 0.8, 0.9)
];

Deno.test("a rotated, shifted, higher-DPI scan is registered and a template box maps onto it", () => {
  // Template rendered at 850x1100, scanned at 3x the DPI, tilted 2 degrees and pushed 40px right.
  // Catches doing the fit in normalized 0..1 units (bends the angle on a non-square page), a
  // flipped rotation sign, or a fit with no scale term.
  const scan = { width: 2550, height: 3300 };
  const t: Tilt = { deg: 2, scale: 3, dx: 40, dy: -25 };
  const reg = registerPage({ words: PRINTED, ...TEMPLATE }, { words: PRINTED.map((w) => onScan(w, t, scan)), ...scan });
  assertExists(reg);
  assertAlmostEquals(degrees(reg), 2, 0.01);
  assertAlmostEquals(scaleOf(reg), 3, 0.001);

  // The answer box should come back as the straight box around its four tilted corners.
  const box: NormRect = { x: 0.2, y: 0.3, width: 0.5, height: 0.1 };
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ].map(([x, y]) => toScanPx(x * TEMPLATE.width, y * TEMPLATE.height, t));
  const xs = corners.map((c) => c.x / scan.width);
  const ys = corners.map((c) => c.y / scan.height);
  const mapped = mapRectToScan(box, reg);
  assertAlmostEquals(mapped.x, Math.min(...xs), 1e-4);
  assertAlmostEquals(mapped.y, Math.min(...ys), 1e-4);
  assertAlmostEquals(mapped.x + mapped.width, Math.max(...xs), 1e-4);
  assertAlmostEquals(mapped.y + mapped.height, Math.max(...ys), 1e-4);
});

Deno.test("a few misplaced words do not pull the fit off", () => {
  // OCR occasionally reports a word in the wrong place. Catches a plain least-squares fit, which
  // lets three bad pairs drag every region by several pixels.
  const scan = { width: 850, height: 1100 };
  const t: Tilt = { deg: -1.5, scale: 1, dx: 12, dy: 18 };
  const scanWords = PRINTED.map((w) => onScan(w, t, scan));
  for (const i of [0, 5, 10]) scanWords[i] = { ...scanWords[i], x: scanWords[i].x + 0.25 };
  const reg = registerPage({ words: PRINTED, ...TEMPLATE }, { words: scanWords, ...scan });
  assertExists(reg);
  assertAlmostEquals(degrees(reg), -1.5, 0.01);
  const mapped = mapRectToScan({ x: 0.5, y: 0.5, width: 0, height: 0 }, reg);
  const expected = toScanPx(0.5 * TEMPLATE.width, 0.5 * TEMPLATE.height, t);
  assertAlmostEquals(mapped.x * scan.width, expected.x, 0.5);
  assertAlmostEquals(mapped.y * scan.height, expected.y, 0.5);
});

Deno.test("a page whose top and bottom disagree is not registered", () => {
  // The top seven words line up, but the bottom five moved 100px on their own, as on a curled or
  // pasted-up page. Catches accepting the fit the top agrees on, which would misplace every
  // region in the bottom half.
  const scan = { width: 850, height: 1100 };
  const scanWords = PRINTED.map((w) => (w.y < 0.5 ? w : { ...w, x: w.x + 100 / scan.width }));
  assertEquals(registerPage({ words: PRINTED, ...TEMPLATE }, { words: scanWords, ...scan }), null);
});

Deno.test("only words that appear once on both pages are paired, ignoring case and punctuation", () => {
  // Catches pairing an ambiguous word: "the" is printed twice, and the student wrote "lookup"
  // a second time on the scan, so either could be paired with the wrong copy.
  const template = [
    word("the", 0.1, 0.1),
    word("the", 0.5, 0.1),
    word("Hash,", 0.1, 0.3),
    word("TABLE", 0.3, 0.3),
    word("lookup", 0.5, 0.3),
    word("of", 0.7, 0.3)
  ];
  const scan = [
    word("the", 0.1, 0.1),
    word("the", 0.5, 0.1),
    word("hash", 0.1, 0.3),
    word("table.", 0.3, 0.3),
    word("lookup", 0.5, 0.3),
    word("lookup", 0.5, 0.7),
    word("of", 0.7, 0.3)
  ];
  const texts = pairWords(template, scan)
    .map((p) => p.text)
    .sort();
  assertEquals(texts, ["hash", "table"]);
});

for (const [name, scanWords] of [
  ["a blank page", []],
  ["a page with only handwriting", [word("banana", 0.2, 0.4), word("recursion", 0.5, 0.5)]],
  ["one printed word short of the minimum", PRINTED.slice(0, MIN_PAIRS - 1)]
] as [string, WordBox[]][]) {
  Deno.test(`${name} cannot be registered`, () => {
    // Catches fitting a transform from one or two pairs, which hands back a confident but
    // arbitrary rotation instead of saying the page could not be lined up.
    assertEquals(registerPage({ words: PRINTED, ...TEMPLATE }, { words: scanWords, ...TEMPLATE }), null);
  });
}

Deno.test("a tilted answer reads in order once its words are moved back into template space", () => {
  // The bug in #1292: on a page tilted 2 degrees counter-clockwise, the right half of a line rises
  // into the band above and is read first. Catches not applying the registration, or applying it
  // in the template-to-scan direction instead of back.
  const scan = { width: 850, height: 1100 };
  const t: Tilt = { deg: -2, scale: 1, dx: 0, dy: 0 };
  const answer = "HASH TABLES GIVE CONSTANT TIME LOOKUPS ON AVERAGE".split(" ");
  const handwriting = answer.map((text, i) => word(text, 0.1 + i * 0.1, 0.4, 0.08));
  const region: NormRect = { x: 0.05, y: 0.35, width: 0.9, height: 0.1 };

  const scanWords = [...PRINTED, ...handwriting].map((w) => onScan(w, t, scan));
  assertNotEquals(wordsInRegion(scanWords, region), answer.join(" "), "precondition: the tilt scrambles the line");

  const reg = registerPage({ words: PRINTED, ...TEMPLATE }, { words: scanWords, ...scan });
  assertExists(reg);
  assertEquals(wordsInRegion(wordsToTemplate(scanWords, reg), region), answer.join(" "));
});

Deno.test("a scan is read as drawn only when its template has nothing printed to place it by", async () => {
  // The fake provider repeats two tokens across every page, as an answer sheet of empty boxes
  // would. Catches refusing scans of such a template (which would reject every batch the e2e
  // suite processes), and catches reading a page as drawn when it should have lined up.
  const fake = await new FakeExamVisionProvider().ocrImage({
    name: "classes/1/exams/1/template/page-1.png",
    bytes: new Uint8Array(),
    width: 850,
    height: 1100
  });
  const unrelated = { words: [word("banana", 0.2, 0.4)], ...TEMPLATE };
  assertEquals(alignPage({ words: fake.words, ...TEMPLATE }, unrelated), AS_DRAWN);
  assertEquals(alignPage(undefined, unrelated), AS_DRAWN);
  assertEquals(alignPage({ words: PRINTED, ...TEMPLATE }, unrelated), null);

  // AS_DRAWN leaves regions and words exactly where they were, so the artifact stores the region
  // as drawn rather than a pixel round trip of it.
  const box: NormRect = { x: 0.2, y: 0.3, width: 0.5, height: 0.1 };
  assertEquals(mapRectToScan(box, AS_DRAWN), box);
  // Only the box comes back, even from a whole region row: the result goes to the model as JSON.
  assertEquals(mapRectToScan({ ...box, kind: "student_id", page_number: 1 } as NormRect, AS_DRAWN), box);
  const words = [word("Total", 0.1, 0.9)];
  assertEquals(wordsToTemplate(words, AS_DRAWN), words);
});
