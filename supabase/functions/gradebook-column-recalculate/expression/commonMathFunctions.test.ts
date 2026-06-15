import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { addCommonExpressionFunctions } from "./commonMathFunctions.ts";
import { pickPreferredGradebookValue } from "./shared.ts";

// These tests exercise the real gradebook expression math (the functions the recalc edge
// function imports into mathjs) directly, with synthetic gradebook values — no database and
// no async recalc pipeline. They cover the computation that the gradebook-calculations e2e
// fixtures verify end-to-end (mean / countif / drop_lowest / sum / comparisons / case_when /
// override precedence), but deterministically and in milliseconds.

// deno-lint-ignore no-explicit-any
function fns(opts: any = {}): Record<string, (...args: any[]) => any> {
  // deno-lint-ignore no-explicit-any
  const imports: any = {};
  addCommonExpressionFunctions(imports, opts);
  return imports;
}

const ctx = { is_private_calculation: true, student_id: "s", class_id: 1 };
const gv = (score: number | null, max_score = 100, extra: Record<string, unknown> = {}) => ({
  score,
  score_override: null,
  max_score,
  column_slug: "c",
  is_private: true,
  is_missing: false,
  is_droppable: true,
  is_excused: false,
  ...extra
});

Deno.test("mean: weighted average across columns", () => {
  // 80/100 + 90/100 → 100*(80+90)/200 = 85
  assertEquals(fns()["mean"](ctx, [gv(80), gv(90)], true), 85);
});

Deno.test("mean: weighting respects differing max_score", () => {
  // 40/50 + 90/100 → 100*(40+90)/(50+100) = 86.66…
  const r = fns()["mean"](ctx, [gv(40, 50), gv(90, 100)], true) as number;
  assertEquals(Math.round(r * 100) / 100, 86.67);
});

Deno.test("mean: unweighted averages percentages equally", () => {
  // 40/50 (80%) + 90/100 (90%) → (80+90)/2 = 85
  const r = fns()["mean"](ctx, [gv(40, 50), gv(90, 100)], false) as number;
  assertEquals(Math.round(r * 100) / 100, 85);
});

Deno.test("mean: missing (non-excused) counts as zero", () => {
  assertEquals(fns()["mean"](ctx, [gv(90), gv(null, 100, { is_missing: true })], true), 45);
});

Deno.test("mean: excused-missing is dropped from the average", () => {
  assertEquals(fns()["mean"](ctx, [gv(90), gv(null, 100, { is_missing: true, is_excused: true })], true), 90);
});

Deno.test("mean: all-excused yields undefined (no valid values)", () => {
  assertEquals(fns()["mean"](ctx, [gv(null, 100, { is_missing: true, is_excused: true })], true), undefined);
});

Deno.test("countif: counts values satisfying the predicate", () => {
  // deno-lint-ignore no-explicit-any
  const count = fns()["countif"](ctx, [gv(5), gv(1), gv(5), gv(4)], (v: any) => (v.score ?? 0) >= 5);
  assertEquals(count, 2);
});

Deno.test("countif: empty input is undefined", () => {
  // deno-lint-ignore no-explicit-any
  const count = fns()["countif"](ctx, [], (_v: any) => true);
  assertEquals(count, undefined);
});

Deno.test("sum: adds gradebook scores", () => {
  assertEquals(fns()["sum"](ctx, [gv(10), gv(20), gv(30)]), 60);
});

Deno.test("drop_lowest: drops the single lowest then averages the rest", () => {
  const kept = fns()["drop_lowest"](ctx, [gv(80), gv(50), gv(90)], 1);
  assertEquals(fns()["mean"](ctx, kept, true), 85);
});

Deno.test("drop_lowest: drops by percentage, not raw score", () => {
  // 45/50 (90%) vs 80/100 (80%) — the 80/100 is lower by ratio and should be dropped.
  const kept = fns()["drop_lowest"](ctx, [gv(45, 50), gv(80, 100)], 1) as Array<{ score: number }>;
  assertEquals(kept.length, 1);
  assertEquals(kept[0].score, 45);
});

Deno.test("drop_lowest: never drops a non-droppable entry", () => {
  // Lowest by ratio is the 10/100, but it's not droppable, so the 50/100 is dropped instead.
  const kept = fns()["drop_lowest"](ctx, [gv(10, 100, { is_droppable: false }), gv(50, 100), gv(90, 100)], 1) as Array<{
    score: number;
  }>;
  const scores = kept.map((k) => k.score).sort((a, b) => a - b);
  assertEquals(scores, [10, 90]);
});

Deno.test("comparisons: larger/smaller/equal coerce gradebook values", () => {
  const f = fns();
  assertEquals(f["larger"](gv(90), 50), 1);
  assertEquals(f["larger"](gv(40), 50), 0);
  assertEquals(f["smaller"](gv(40), 50), 1);
  assertEquals(f["equal"](gv(50), 50), 1);
  assertEquals(f["equal"](gv(51), 50), 0);
});

Deno.test("is_released: reflects the explicit is_released field", () => {
  const f = fns();
  assertEquals(f["is_released"](gv(80, 100, { is_released: true })), true);
  assertEquals(f["is_released"](gv(80, 100, { is_released: false })), false);
});

Deno.test("is_released: falls back to the raw `released` field", () => {
  const f = fns();
  // recalc gradebook_columns values spread the row, which carries `released` (not is_released).
  assertEquals(f["is_released"](gv(80, 100, { released: true })), true);
  assertEquals(f["is_released"](gv(80, 100, { released: false })), false);
});

Deno.test("is_released: non-gradebook operands (bare numbers) are not released", () => {
  const f = fns();
  assertEquals(f["is_released"](42), false);
  assertEquals(f["is_released"](undefined), false);
});

Deno.test("is_released: usable as a case_when condition", () => {
  const f = fns();
  const table = (rows: [boolean, number][]) => ({ toArray: () => rows });
  // released → take the real score branch; otherwise fall through to 0.
  assertEquals(
    f["case_when"](
      table([
        [f["is_released"](gv(90, 100, { is_released: true })) as boolean, 90],
        [true, 0]
      ])
    ),
    90
  );
  assertEquals(
    f["case_when"](
      table([
        [f["is_released"](gv(90, 100, { is_released: false })) as boolean, 90],
        [true, 0]
      ])
    ),
    0
  );
});

Deno.test("case_when: returns the first matching branch's result (curving)", () => {
  // Mimics a curve table: pick the band whose condition is true.
  const f = fns();
  // case_when expects a mathjs matrix-like; pass an array with a toArray() shim.
  const table = (rows: [boolean, number][]) => ({ toArray: () => rows });
  assertEquals(
    f["case_when"](
      table([
        [false, 4],
        [true, 3],
        [true, 2]
      ])
    ),
    3
  );
  assertEquals(
    f["case_when"](
      table([
        [false, 4],
        [false, 3]
      ])
    ),
    undefined
  );
});

Deno.test("min/max over gradebook values", () => {
  const f = fns();
  assertEquals(f["max"](gv(80), gv(95), gv(60)), 95);
  assertEquals(f["min"](gv(80), gv(95), gv(60)), 60);
});

Deno.test("security guards: dangerous mathjs functions are blocked", () => {
  const f = fns({ includeSecurityGuards: true });
  for (const name of ["import", "createUnit", "reviver", "resolve"]) {
    assertThrows(() => f[name]());
  }
});

// --- override precedence (Fixture 5: Score Override Precedence) ---

const dep = (score: number | null, score_override: number | null = null) => ({
  score,
  score_override,
  max_score: 100,
  column_slug: "c",
  is_private: true,
  is_droppable: true,
  is_excused: false,
  is_missing: false
});

Deno.test("pickPreferred: base override wins and is surfaced as the score", () => {
  // Base row carries a score_override → it wins, with score replaced by the override.
  const r = pickPreferredGradebookValue(dep(70), dep(80, 95));
  assertEquals(r?.score, 95);
});

Deno.test("pickPreferred: with no base override, the override-row value is used", () => {
  const r = pickPreferredGradebookValue(dep(70), dep(80, null));
  assertEquals(r?.score, 70);
});

Deno.test("pickPreferred: falls back to base when no override row exists", () => {
  const r = pickPreferredGradebookValue(undefined, dep(80, null));
  assertEquals(r?.score, 80);
});
