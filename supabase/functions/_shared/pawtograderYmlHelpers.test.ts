/**
 * `calculateTotalAutograderPoints` decides `assignments.autograder_points`, which is what students
 * see as the autograder's contribution to an assignment. It existed unused while
 * github-repo-webhook carried its own inline copy; both callers now share it, so it is worth
 * pinning — including the case where the two implementations disagreed.
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { calculateTotalAutograderPoints, getGradedUnitPoints } from "./pawtograderYmlHelpers.ts";
import type { PawtograderConfig } from "./PawtograderYml.d.ts";

// deno-lint-ignore no-explicit-any
const config = (gradedParts: unknown): PawtograderConfig => ({ gradedParts }) as any;

Deno.test("calculateTotalAutograderPoints: sums regular test units across parts", () => {
  assertEquals(
    calculateTotalAutograderPoints(
      config([
        { gradedUnits: [{ tests: "a", testCount: 1, points: 10 }] },
        { gradedUnits: [{ tests: "b", testCount: 2, points: 5 }] }
      ])
    ),
    15
  );
});

Deno.test("calculateTotalAutograderPoints: mutation units prefer linearScoring over breakPoints", () => {
  assertEquals(
    calculateTotalAutograderPoints(config([{ gradedUnits: [{ locations: [], linearScoring: { points: 7 } }] }])),
    7
  );
  assertEquals(
    calculateTotalAutograderPoints(config([{ gradedUnits: [{ locations: [], breakPoints: [{ pointsToAward: 4 }] }] }])),
    4
  );
});

Deno.test("calculateTotalAutograderPoints: a unit with points but no tests/testCount still counts", () => {
  // The webhook's inline copy gated on isRegularTestUnit ("tests" AND "testCount") and scored this
  // as 0; the shared helper counts any numeric `points`. Replacing that copy with this helper makes
  // the shared, more permissive reading the single definition — pinned here so the difference is a
  // decision rather than an accident.
  assertEquals(getGradedUnitPoints({ points: 3 } as never), 3);
  assertEquals(calculateTotalAutograderPoints(config([{ gradedUnits: [{ points: 3 }] }])), 3);
});

Deno.test("calculateTotalAutograderPoints: missing gradedParts or gradedUnits is zero, not a throw", () => {
  // A brand-new solution repo can be created from a template whose pawtograder.yml has no graded
  // parts yet, and creation must not fail over it.
  assertEquals(calculateTotalAutograderPoints(config(undefined)), 0);
  assertEquals(calculateTotalAutograderPoints(config([{}])), 0);
  assertEquals(calculateTotalAutograderPoints(config([])), 0);
});
