/**
 * The invariant these pin was violated in review: a reserve LARGER than the budget makes
 * `canStartRepair` false before any work happens, so the repair pass breaks before its first
 * request and reports zero repairs forever — indistinguishable from a healthy run with nothing to
 * do, which is why it needs a test rather than a comment.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { canStartRepair, remainingBudgetMs, REPAIR_RESERVE_MS, REPAIR_TIME_BUDGET_MS } from "./repairBudget.ts";

Deno.test("repair budget: the reserve fits inside the budget", () => {
  // Without this, no repair can ever start.
  assert(
    REPAIR_RESERVE_MS < REPAIR_TIME_BUDGET_MS,
    `reserve ${REPAIR_RESERVE_MS}ms must be less than budget ${REPAIR_TIME_BUDGET_MS}ms`
  );
});

Deno.test("repair budget: a fresh pass can start a repair", () => {
  assert(canStartRepair(0));
});

Deno.test("repair budget: the common case is not throttled", () => {
  // A healthy creation takes ~10-12s. Several in a row must still be allowed, or the reserve is
  // sized for the worst case and starves the normal one.
  assert(canStartRepair(12_000 * 5));
});

Deno.test("repair budget: a repair is not started once the reserve no longer fits", () => {
  assert(!canStartRepair(REPAIR_TIME_BUDGET_MS - REPAIR_RESERVE_MS + 1));
  assert(canStartRepair(REPAIR_TIME_BUDGET_MS - REPAIR_RESERVE_MS));
});

Deno.test("repair budget: remaining is floored at 1ms so it is a usable timeout", () => {
  assertEquals(remainingBudgetMs(REPAIR_TIME_BUDGET_MS + 10_000), 1);
  assertEquals(remainingBudgetMs(0), REPAIR_TIME_BUDGET_MS);
});
