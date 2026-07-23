/**
 * Agentic SR-driving host spec (a11y-judge v2, Wave 2).
 *
 * Opt-in: A11Y_AGENT=1. Per (task, sample): seeds the page, installs the
 * AtHarness, starts the in-process MCP bridge, spawns `claude -p` (standing
 * OAuth session) restricted to the bridge tools, then:
 *   - writes trajectory.json + verdict.json under
 *     a11y-trajectories/<runId>/<pageId>__<taskId>/s<i>/
 *   - evaluates the task's machine-checked success predicate (DB / ground
 *     truth — never the agent's self-report).
 *
 * Env knobs: A11Y_AGENT_SAMPLES (default 1), A11Y_AGENT_TASKS (csv filter),
 * A11Y_RUN_ID, A11Y_MUTATION (plant a defect; groundTruth.json sidecar).
 */
import fs from "fs";
import path from "path";
import { test, expect } from "../global-setup";
import { loginAsUser, TestingUser } from "./TestingUtils";
import { seedAgentPages, makeTaskContext, type AgentSeed } from "./a11yAgentSeeding";
import { AtHarness } from "../../tools/a11y-judge/agent/atHarness";
import { AtBridge } from "../../tools/a11y-judge/agent/bridge";
import { runAgent } from "../../tools/a11y-judge/agent/agentRunner";
import { TASKS, type TaskContext, type TaskDefinition } from "../../tools/a11y-judge/agent/tasks";
import { settlePage, waitForPageReady } from "../../tools/a11y-judge/agent/pageReady";
import { getMutation, writeGroundTruthSidecar, MUTATION_ENV_VAR, MUTATIONS } from "../../tools/a11y-judge/mutations";
import type { Mutation } from "../../tools/a11y-judge/mutations";

test.describe.configure({ mode: "serial" });
test.use({ bypassCSP: true });

const TRAJECTORY_ROOT = path.resolve(process.cwd(), "a11y-trajectories");
const RUN_ID = process.env.A11Y_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const SAMPLES = Math.max(1, parseInt(process.env.A11Y_AGENT_SAMPLES ?? "1", 10) || 1);
const TASK_FILTER = process.env.A11Y_AGENT_TASKS?.split(",").map((s) => s.trim());

const ACTIVE_MUTATION: Mutation | null = (() => {
  const id = process.env[MUTATION_ENV_VAR]?.trim();
  if (!id) return null;
  const mutation = getMutation(id);
  if (!mutation) {
    throw new Error(`Unknown ${MUTATION_ENV_VAR}="${id}". Known ids: ${MUTATIONS.map((m) => m.id).join(", ")}`);
  }
  return mutation;
})();

let seed: AgentSeed;
let student: TestingUser;
let instructor: TestingUser;
/** Per-page routes + per-task seed values, filled by beforeAll. */
const routes: Record<string, string> = {};
const seedValues: Record<string, string> = {};

test.beforeAll(async () => {
  test.skip(!process.env.A11Y_AGENT, "agent runs are opt-in (set A11Y_AGENT=1)");

  seed = await seedAgentPages();
  ({ student, instructor } = seed);
  Object.assign(routes, seed.routes);
  Object.assign(seedValues, seed.seedValues);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.afterAll(async () => {
  if (!process.env.A11Y_AGENT) return;
  const latest = path.join(TRAJECTORY_ROOT, "latest");
  fs.mkdirSync(TRAJECTORY_ROOT, { recursive: true });
  fs.rmSync(latest, { force: true });
  fs.symlinkSync(path.join(TRAJECTORY_ROOT, RUN_ID), latest);
});

const taskContext: TaskContext = makeTaskContext(seedValues);

function sampleDir(task: TaskDefinition, sampleIndex: number): string {
  return path.join(TRAJECTORY_ROOT, RUN_ID, `${task.pageId}__${task.id}`, `s${sampleIndex}`);
}

const activeTasks = TASKS.filter((t) => !TASK_FILTER || TASK_FILTER.includes(t.id));

for (const task of activeTasks) {
  for (let sampleIndex = 0; sampleIndex < SAMPLES; sampleIndex++) {
    test(`agent: ${task.id} (sample ${sampleIndex})`, async ({ page, browserName }) => {
      test.setTimeout(25 * 60 * 1000);
      test.skip(
        Boolean(ACTIVE_MUTATION?.pageIds && !ACTIVE_MUTATION.pageIds.includes(task.pageId)),
        "mutation does not apply to this page"
      );

      const outDir = sampleDir(task, sampleIndex);
      // Resumability: a full sweep can be re-run after interruption.
      if (fs.existsSync(path.join(outDir, "verdict.json"))) {
        console.log(`[agent] ${task.id} s${sampleIndex}: verdict exists, skipping`);
        return;
      }

      fs.mkdirSync(outDir, { recursive: true });
      writeGroundTruthSidecar(path.dirname(outDir), ACTIVE_MUTATION);

      // Always write a verdict.json — even if setup or the agent throws — so a
      // sample is never silently lost (which, under serial mode, also skips the
      // rest). Setup errors under a mutation are DATA, not a test failure; only
      // clean runs hard-assert at the end.
      let result: Awaited<ReturnType<typeof runAgent>> | null = null;
      let setupError: string | null = null;
      try {
        const harness = await AtHarness.install(page);
        if (ACTIVE_MUTATION) await ACTIVE_MUTATION.apply(page);
        await loginAsUser(page, student, seed.course);
        const route = routes[task.pageId];
        await page.goto(route);
        await waitForPageReady(page, page.locator("#main-content, main").first(), {
          mutationTolerant: Boolean(ACTIVE_MUTATION)
        });
        await settlePage(page);

        const bridge = new AtBridge(harness);
        await bridge.start();
        try {
          result = await runAgent({ task, bridge, sampleIndex, browser: browserName, route });
        } finally {
          await bridge.stop();
        }
        fs.writeFileSync(path.join(outDir, "trajectory.json"), JSON.stringify(result.trajectory, null, 2));
        fs.writeFileSync(path.join(outDir, "stream.jsonl"), result.rawStdout);
        // The recording run's seed bindings — spec generation normalizes
        // milestone phrases against these (a11y:generate-specs).
        fs.writeFileSync(path.join(outDir, "bindings.json"), JSON.stringify(seedValues, null, 2));
      } catch (e) {
        setupError = e instanceof Error ? (e.stack ?? e.message) : String(e);
      }

      const predicate = result ? await task.predicate(result.verdict, taskContext) : { success: false, detail: "run threw before a verdict was produced" };
      const isError = setupError !== null || (result?.isError ?? true);
      fs.writeFileSync(
        path.join(outDir, "verdict.json"),
        JSON.stringify(
          {
            verdict: result?.verdict ?? null,
            rejectedBarriers: result?.rejectedBarriers ?? [],
            isError,
            errorText: setupError ?? result?.errorText,
            salvaged: result?.salvaged,
            barriersParseError: result?.barriersParseError,
            resultSubtype: result?.resultSubtype,
            numTurns: result?.numTurns,
            costUsd: result?.costUsd,
            predicate
          },
          null,
          2
        )
      );

      console.log(
        `[agent] ${task.id} s${sampleIndex}: outcome=${result?.verdict?.outcome ?? "-"} ` +
          `predicate=${predicate.success} (${predicate.detail}) turns=${result?.numTurns ?? "-"} ` +
          `steps=${result?.trajectory.steps.length ?? "-"} cost=$${result?.costUsd?.toFixed(2) ?? "-"}` +
          (isError ? ` ERROR=${(setupError ?? result?.errorText ?? "").slice(0, 80)}` : "")
      );

      // Clean runs must complete the task; mutation runs are scored by the
      // gauntlet aggregator (an errored/blocked agent under a mutation is a
      // legitimate data point, not a test failure).
      if (!ACTIVE_MUTATION) {
        expect(isError, setupError ?? result?.errorText ?? "").toBe(false);
        expect(predicate.success, predicate.detail).toBe(true);
      }
    });
  }
}
