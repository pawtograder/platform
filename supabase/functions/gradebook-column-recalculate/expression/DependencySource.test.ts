import { assertEquals } from "jsr:@std/assert@^1";
import { assignmentRoundReleased } from "./DependencySource.ts";

// assignment_released() reports a round released exactly when the student-visible (public) score
// for that round is present. Unreleased rounds are omitted from scores_by_round_public.

Deno.test("assignmentRoundReleased: present public round score ⇒ released", () => {
  assertEquals(assignmentRoundReleased({ "grading-review": 87 }, "grading-review"), true);
  // A released zero is still released (present, not undefined).
  assertEquals(assignmentRoundReleased({ "grading-review": 0 }, "grading-review"), true);
});

Deno.test("assignmentRoundReleased: missing/undefined round ⇒ not released", () => {
  assertEquals(assignmentRoundReleased({ "grading-review": undefined }, "grading-review"), false);
  assertEquals(assignmentRoundReleased({ "self-review": 90 }, "grading-review"), false);
  assertEquals(assignmentRoundReleased({}, "grading-review"), false);
  assertEquals(assignmentRoundReleased(undefined, "grading-review"), false);
});
