/**
 * timerYield.ts, and match's batch alignment giving timers a turn (#1158 with #1292).
 *
 * The exam worker holds its message on a 30 s lease renewed by a timer (examWorkerLease.ts). Lining
 * a large batch up with its template is seconds of CPU; run as one synchronous loop, no timer fires
 * until it ends, so the lease can lapse and another reader take the message. The alignment test
 * imports the worker's pageAlignment.ts from here because CI's test:functions runs _shared/ only.
 *
 * Run from supabase/functions:  deno test --no-check --allow-read --allow-env --allow-net _shared/timerYield.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { timerYielder } from "./timerYield.ts";
import type { PageWords } from "./examRegistration.ts";
import type { WordBox } from "./examVision.ts";
import { requireAligned, requireAlignedYielding } from "../exam-async-worker/pageAlignment.ts";

Deno.test("timerYielder yields only once everyMs has passed since its last yield", async () => {
  let t = 0;
  const y = timerYielder(50, () => t);
  let fired = 0;
  const tick = () => fired++;

  setTimeout(tick, 0);
  t = 49;
  await y(); // 49 ms since creation: no yield, so the timer has not run
  assertEquals(fired, 0);

  t = 50;
  await y(); // 50 ms: yields, and the pending timer runs first
  assertEquals(fired, 1);

  setTimeout(tick, 0);
  t = 99;
  await y(); // 49 ms since the last yield
  assertEquals(fired, 1);
  t = 100;
  await y();
  assertEquals(fired, 2);
});

/** A page of `n` printed words, offset by (dx, dy) as a slightly shifted scan would be. */
function page(n: number, dx = 0, dy = 0): PageWords {
  const words: WordBox[] = [];
  for (let i = 0; i < n; i++) {
    words.push({
      text: `word${i}`,
      x: ((i * 37) % 97) / 100 + dx,
      y: ((i * 53) % 89) / 100 + dy,
      width: 0.02,
      height: 0.01
    });
  }
  return { words, width: 850, height: 1100 };
}

const PAGES_PER_EXAM = 2;
const EXAMS = 6;
const templates = new Map([
  [1, page(120)],
  [2, page(120)]
]);
const scan = page(120, 0.003, 0.002);
const exams = Array.from({ length: EXAMS }, (_, e) =>
  Array.from({ length: PAGES_PER_EXAM }, (_, i) => ({
    id: e * PAGES_PER_EXAM + i,
    page_index: e * PAGES_PER_EXAM + i,
    width: scan.width,
    height: scan.height
  }))
);
const ocrOf = () => ({ words: scan.words }) as unknown as import("./SupabaseTypes.d.ts").Json;

/** Runs `work` while a 0 ms timer chain (standing in for lease renewals) counts how often it gets a turn. */
async function timerTurnsDuring(work: () => unknown): Promise<number> {
  let turns = 0;
  let running = true;
  const chain = () => {
    if (!running) return;
    turns++;
    setTimeout(chain, 0);
  };
  setTimeout(chain, 0);
  await work();
  running = false;
  const during = turns;
  await new Promise((r) => setTimeout(r, 5)); // let the last link see running = false
  return during;
}

Deno.test("match's batch alignment lets timers run between pages; the synchronous form does not", async () => {
  const sync = await timerTurnsDuring(() => requireAligned(7, exams, templates, ocrOf));
  assertEquals(sync, 0, "control: one synchronous loop gives a timer no turn at all");

  // everyMs = 0 yields after every page, so the count does not depend on this machine's speed.
  const yielding = await timerTurnsDuring(() => requireAlignedYielding(7, exams, templates, ocrOf, timerYielder(0)));
  assert(yielding >= EXAMS * PAGES_PER_EXAM - 1, `a timer got ${yielding} turns over ${EXAMS * PAGES_PER_EXAM} pages`);
});

Deno.test("the yielding alignment returns what requireAligned returns, and refuses the same pages", async () => {
  const a = requireAligned(7, exams, templates, ocrOf);
  const b = await requireAlignedYielding(7, exams, templates, ocrOf, timerYielder(0));
  assertEquals(b, a);

  // Every page of the second exam belongs to another exam: both forms name pages 3 and 4.
  const other = { ...page(120), words: page(120).words.map((w) => ({ ...w, text: `other${w.text}` })) };
  const bad = new Set([2, 3]);
  const ocrMixed = (p: { id: number }) =>
    ({ words: (bad.has(p.id) ? other : scan).words }) as unknown as import("./SupabaseTypes.d.ts").Json;
  const message = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  const syncMessage = message(() => requireAligned(7, exams, templates, ocrMixed));
  let asyncMessage = "";
  try {
    await requireAlignedYielding(7, exams, templates, ocrMixed, timerYielder(0));
  } catch (e) {
    asyncMessage = (e as Error).message;
  }
  assert(syncMessage.includes("pages 3, 4 could not be lined up"), syncMessage);
  assertEquals(asyncMessage, syncMessage);
});
