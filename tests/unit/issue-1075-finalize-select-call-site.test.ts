/**
 * Keeps `finalize`'s select and the test that exercises it from drifting apart.
 *
 * `issue-1075-finalize-region-embed.test.ts` runs FINALIZE_ANSWER_REGION_SELECT against a real
 * database. If the worker stopped using that constant, the test would still pass while checking a
 * query the worker no longer runs. Aryan showed on review that this was not hypothetical: putting
 * an inline select back into index.ts left both of those tests green.
 *
 * Note this is no longer guarding against #1075 itself. The migration now drops the single-column
 * foreign keys that made the embed ambiguous, so an inline embed would work. What is left is the
 * narrower point above: the test and the worker should be reading the same string.
 *
 * Source-level rather than behavioural on purpose, and in its own file because the integration
 * test imports TestingUtils, which builds an admin client at module scope and throws without
 * database env vars. This one needs none.
 */
import { readFileSync } from "fs";
import { join } from "path";

const WORKER = join(__dirname, "..", "..", "supabase", "functions", "exam-async-worker", "index.ts");

describe("issue #1075: finalize's call site uses the shared select", () => {
  const workerSource = readFileSync(WORKER, "utf8");

  test("the answer-region query passes FINALIZE_ANSWER_REGION_SELECT, not an inline string", () => {
    // Note there are two exam_question_regions queries in the worker: the identity-region one at
    // ~353 selects a literal and is unrelated to #1075. The one this protects is the answer-region
    // query inside finalize, which is the only place the double-FK embed appears.
    expect(workerSource).toContain(".select(FINALIZE_ANSWER_REGION_SELECT)");
  });

  test("the worker imports it from finalizeQueries", () => {
    expect(workerSource).toMatch(
      /import\s*\{[^}]*FINALIZE_ANSWER_REGION_SELECT[^}]*\}\s*from\s*"\.\/finalizeQueries\.ts"/
    );
  });
});
