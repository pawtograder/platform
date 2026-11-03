/**
 * Companion guard for #1075.
 *
 * `issue-1075-finalize-region-embed.test.ts` proves the exported select works against a real
 * database. It does not prove `finalize` uses it. Aryan pointed out on review that putting an
 * inline `exam_questions(answer_type)` select back into index.ts leaves both of those tests green,
 * because neither one loads the worker. So the fix could be undone without anything going red.
 *
 * This reads the worker and asserts the call site still takes its select from finalizeQueries.ts.
 * Source-level rather than behavioural on purpose: the worker is Deno, the thing being protected is
 * one argument of one call, and the cheap check is that the argument is not a literal.
 *
 * Separate file because the integration test imports TestingUtils, which builds an admin client at
 * module scope and throws without database env vars. This guard needs none, so it runs anywhere.
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

  test("no inline exam_questions embed is left anywhere in the worker", () => {
    // An unnamed embed is the #1075 bug in any query, not only finalize's.
    expect(workerSource).not.toMatch(/\.select\([^)]*exam_questions\s*\(/);
  });

  test("the worker imports it from finalizeQueries", () => {
    expect(workerSource).toMatch(
      /import\s*\{[^}]*FINALIZE_ANSWER_REGION_SELECT[^}]*\}\s*from\s*"\.\/finalizeQueries\.ts"/
    );
  });
});
