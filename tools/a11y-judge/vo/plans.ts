/**
 * Loader that shares the promoted ReplayPlans with the real-VoiceOver runner.
 *
 * The committed specs in tests/e2e/a11y-tasks/ are the only durable home of
 * the plans (source trajectories are gitignored), and their PLAN literal is
 * emitted by generateSpec.ts via JSON.stringify — guaranteed strict JSON. So
 * the VO runner extracts the literal instead of importing the spec (importing
 * would drag in @playwright/test's runner context, which only exists inside
 * `playwright test`). Specs stay the single source of truth: future
 * `a11y:generate-specs` output is picked up automatically.
 */
import fs from "node:fs";
import path from "node:path";
import { GENERATOR_VERSION, type ReplayPlan } from "../agent/replay";
import { getTask } from "../agent/tasks";

export interface LoadedPlan {
  /** `${pageId}__${taskId}` — matches the spec filename stem. */
  id: string;
  plan: ReplayPlan;
  specPath: string;
  /** Set when the spec carries test.fixme (known app defect): report as skipped, don't run. */
  blockedBy: string | null;
}

const PLAN_LITERAL = /const PLAN: ReplayPlan = (\{[\s\S]*?\n\});/;
const FIXME_LINE = /test\.fixme\(true,\s*("(?:[^"\\]|\\.)*")\)/;

export function loadPlans(dir = path.join("tests", "e2e", "a11y-tasks")): LoadedPlan[] {
  const specs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
  if (specs.length === 0) throw new Error(`no replay specs found in ${dir}`);

  return specs.map((file) => {
    const specPath = path.join(dir, file);
    const source = fs.readFileSync(specPath, "utf8");
    const literal = source.match(PLAN_LITERAL);
    if (!literal) throw new Error(`${specPath}: no PLAN literal found (regenerate with a11y:generate-specs?)`);
    let plan: ReplayPlan;
    try {
      plan = JSON.parse(literal[1]) as ReplayPlan;
    } catch (e) {
      throw new Error(`${specPath}: PLAN literal is not strict JSON (${e}) — was the spec hand-edited?`);
    }
    if (plan.generatorVersion !== GENERATOR_VERSION) {
      throw new Error(
        `${specPath}: generator v${plan.generatorVersion} != supported v${GENERATOR_VERSION} — regenerate the spec`
      );
    }
    if (!getTask(plan.taskId)) throw new Error(`${specPath}: unknown taskId ${JSON.stringify(plan.taskId)}`);
    const id = `${plan.pageId}__${plan.taskId}`;
    if (file !== `${id}.spec.ts`) {
      throw new Error(`${specPath}: filename does not match plan identity ${id}`);
    }
    const fixme = source.match(FIXME_LINE);
    return {
      id,
      plan,
      specPath,
      blockedBy: fixme ? (JSON.parse(fixme[1]) as string) : null
    };
  });
}
