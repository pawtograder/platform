/**
 * Deterministic spec generation (a11y-judge v2, Wave 4).
 *
 * Usage: tsx tools/a11y-judge/agent/generateSpec.ts --trajectories a11y-trajectories/latest [--out tests/e2e/a11y-tasks]
 *
 * For every (page, task) sample whose agent run completed AND passed its
 * machine predicate, distills the trajectory into a ReplayPlan and emits an
 * A11Y_TASKS-gated Playwright spec that replays it with no LLM. Artifact-first
 * policy: the output dir is gitignored; specs are promoted to the committed
 * suite only after the determinism gate (3× green on fresh seeds + red under
 * their mutation).
 */
import fs from "fs";
import path from "path";
import { normalizePhrase, type Bindings } from "./normalize";
import { GENERATOR_VERSION, STATE_CHANGING_COMMANDS, type ReplayPlan, type ReplayStep } from "./replay";
import { getTask } from "./tasks";
import type { AtCommand } from "./atHarness";
import type { Trajectory } from "../schema/trajectory";

/** Pure: trajectory + its recording-run bindings → replay plan. */
export function buildReplayPlan(trajectory: Trajectory, bindings: Bindings): ReplayPlan {
  const task = getTask(trajectory.meta.taskId);
  if (!task) throw new Error(`unknown task id in trajectory: ${trajectory.meta.taskId}`);

  const steps: ReplayStep[] = [];
  for (let i = 0; i < trajectory.steps.length; i++) {
    const recorded = trajectory.steps[i];
    if (recorded.tool === "observe") continue; // replay makes its own observations
    const step: ReplayStep = { command: recorded.tool as AtCommand };
    const args = JSON.parse(recorded.argsJson) as Record<string, string>;
    const argValue = Object.values(args)[0];
    if (argValue !== undefined) step.arg = argValue;

    if (STATE_CHANGING_COMMANDS.has(recorded.tool) && i > 0) {
      const before = JSON.parse(trajectory.steps[i - 1].resultJson) as { currentItem?: string };
      const template = before.currentItem ? normalizePhrase(before.currentItem, bindings) : null;
      if (template) step.milestone = template;
    }
    steps.push(step);
  }

  return {
    generatorVersion: GENERATOR_VERSION,
    sourceTrajectoryHash: trajectory.contentHash,
    pageId: trajectory.meta.pageId,
    taskId: trajectory.meta.taskId,
    taskKind: task.kind,
    readNeedleKeys: task.readNeedleKeys ?? [],
    steps
  };
}

/** Pure: plan → generated spec source. */
export function renderSpecSource(plan: ReplayPlan, runId: string, replayBlockedBy?: string): string {
  const fixmeLine = replayBlockedBy
    ? `\ntest.fixme(true, ${JSON.stringify(`known app defect: ${replayBlockedBy}`)});\n`
    : "";
  return `/**
 * AUTO-GENERATED deterministic SR replay spec — do not edit by hand.
 * Task: ${plan.pageId}__${plan.taskId}   (generator v${plan.generatorVersion})
 * Source trajectory: ${plan.sourceTrajectoryHash} (run ${runId})
 * Regenerate: npm run a11y:generate-specs
 *
 * Replays the agent's SR/keyboard command sequence with milestone assertions
 * (normalized spoken templates) + the task's machine success check. No LLM.
 *
 * A11Y_VIDEO=1 additionally records a reviewer-facing video: focus-highlight +
 * caption overlay, watchable pacing, and a sidecar meta file for the collector
 * (tools/a11y-judge/videos). Without the env var the spec is byte-identical to
 * the plain replay.${
   replayBlockedBy
     ? `\n *\n * test.fixme: this replay reproduces a known app defect and stays red until\n * it is fixed — ${replayBlockedBy}.`
     : ""
 }
 */
import fs from "fs";
import { test, expect } from "../../global-setup";
import { loginAsUser } from "../TestingUtils";
import { seedAgentPages, makeTaskContext, type AgentSeed } from "../a11yAgentSeeding";
import { AtHarness } from "../../../tools/a11y-judge/agent/atHarness";
import { replayPlan, type ReplayPlan } from "../../../tools/a11y-judge/agent/replay";
import { settlePage, waitForPageReady } from "../../../tools/a11y-judge/agent/pageReady";
import { getTask } from "../../../tools/a11y-judge/agent/tasks";
import { getMutation, MUTATION_ENV_VAR } from "../../../tools/a11y-judge/mutations";

const VIDEO = Boolean(process.env.A11Y_VIDEO);
const VIDEO_STEP_PAUSE_MS = 900;

test.use({ bypassCSP: true, video: VIDEO ? "on" : "off" });

const PLAN: ReplayPlan = ${JSON.stringify(plan, null, 2)};
${fixmeLine}
// A11Y_MUTATION plants a known defect for the "generated tests go red under
// the corresponding mutation" gate; the same spec is green clean, red mutated.
const MUTATION = process.env[MUTATION_ENV_VAR] ? getMutation(process.env[MUTATION_ENV_VAR].trim()) : null;

let seed: AgentSeed;

test.beforeAll(async () => {
  test.skip(!process.env.A11Y_TASKS, "replay specs are opt-in (set A11Y_TASKS=1)");
  seed = await seedAgentPages();
});

// Video sidecar: written in afterEach (testInfo.status is final, page still
// alive so page.video().path() resolves to the PROMISED path). The .webm only
// finalizes when the context closes — after all hooks — so copying happens in
// the post-run collector (tools/a11y-judge/videos/collect.ts), never here.
test.afterEach(async ({ page }, testInfo) => {
  if (!VIDEO) return;
  const videoPath = await page.video()?.path().catch(() => null);
  fs.writeFileSync(
    testInfo.outputPath("a11y-video-meta.json"),
    JSON.stringify({
      pageId: PLAN.pageId,
      taskId: PLAN.taskId,
      prompt: getTask(PLAN.taskId)?.prompt ?? "",
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      stepCount: PLAN.steps.length,
      durationMs: testInfo.duration,
      retry: testInfo.retry,
      videoPath
    })
  );
});

test("replay: ${plan.pageId}__${plan.taskId}", async ({ page }) => {
  test.setTimeout(VIDEO ? 600_000 : 300_000);
  const harness = await AtHarness.install(page, { videoOverlay: VIDEO });
  if (MUTATION && (!MUTATION.pageIds || MUTATION.pageIds.includes(PLAN.pageId))) await MUTATION.apply(page);
  await loginAsUser(page, seed.student, seed.course);
  await page.goto(seed.routes[PLAN.pageId]);
  await waitForPageReady(page, page.locator("#main-content, main").first(), {
    mutationTolerant: Boolean(MUTATION)
  });
  await settlePage(page);

  const result = await replayPlan(harness, PLAN, seed.seedValues, {
    pause: (ms) => page.waitForTimeout(ms),
    stepPauseMs: VIDEO ? VIDEO_STEP_PAUSE_MS : 0
  });
  for (const r of result.resyncs) {
    console.log(\`[replay] resync at step \${r.stepIndex}: \${r.presses} presses to \${r.milestone}\`);
  }

  if (PLAN.taskKind === "write") {
    await page.waitForTimeout(2500); // submission round-trip before the DB check
    const predicate = await getTask(PLAN.taskId)!.predicate(null, makeTaskContext(seed.seedValues));
    expect(predicate.success, predicate.detail).toBe(true);
  }
});
`;
}

function main(): void {
  const dirFlag = process.argv.indexOf("--trajectories");
  const outFlag = process.argv.indexOf("--out");
  const runDir = path.resolve(dirFlag > -1 ? process.argv[dirFlag + 1] : "a11y-trajectories/latest");
  const outDir = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : "tests/e2e/a11y-tasks");
  const runId = path.basename(fs.realpathSync(runDir));

  fs.mkdirSync(outDir, { recursive: true });
  let emitted = 0;
  for (const cell of fs.readdirSync(runDir).sort()) {
    const cellDir = path.join(runDir, cell);
    if (!fs.statSync(cellDir).isDirectory()) continue;
    // Prefer the lowest-numbered eligible sample.
    for (const sample of fs.readdirSync(cellDir).sort()) {
      const dir = path.join(cellDir, sample);
      const need = ["verdict.json", "trajectory.json", "bindings.json"].map((f) => path.join(dir, f));
      if (!need.every((f) => fs.existsSync(f))) continue;
      const verdict = JSON.parse(fs.readFileSync(need[0], "utf8"));
      if (verdict.isError || !verdict.predicate?.success) {
        console.log(`skip ${cell}/${sample}: isError=${verdict.isError} predicate=${verdict.predicate?.success}`);
        continue;
      }
      const trajectory = JSON.parse(fs.readFileSync(need[1], "utf8")) as Trajectory;
      const bindings = JSON.parse(fs.readFileSync(need[2], "utf8")) as Bindings;
      const plan = buildReplayPlan(trajectory, bindings);
      const blockedBy = getTask(plan.taskId)?.replayBlockedBy;
      const outPath = path.join(outDir, `${plan.pageId}__${plan.taskId}.spec.ts`);
      fs.writeFileSync(outPath, renderSpecSource(plan, runId, blockedBy));
      console.log(
        `wrote ${outPath} (${plan.steps.length} steps, ${plan.steps.filter((s) => s.milestone).length} milestones)` +
          (blockedBy ? ` [test.fixme: ${blockedBy}]` : "")
      );
      emitted++;
      break;
    }
  }
  console.log(`${emitted} spec(s) generated from ${runDir}`);
}

if (require.main === module) main();
