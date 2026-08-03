/**
 * AUTO-GENERATED deterministic SR replay spec — do not edit by hand.
 * Task: gradebook__gradebook-assignment   (generator v1)
 * Source trajectory: 028e63c9c80bbcc1701484e33b237cd7ee596ae5222d131baa6c621cb8a24d3b (run eval-clean)
 * Regenerate: npm run a11y:generate-specs
 *
 * Replays the agent's SR/keyboard command sequence with milestone assertions
 * (normalized spoken templates) + the task's machine success check. No LLM.
 *
 * A11Y_VIDEO=1 additionally records a reviewer-facing video: focus-highlight +
 * caption overlay, watchable pacing, and a sidecar meta file for the collector
 * (tools/a11y-judge/videos). Without the env var the spec is byte-identical to
 * the plain replay.
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

const PLAN: ReplayPlan = {
  "generatorVersion": "1",
  "sourceTrajectoryHash": "028e63c9c80bbcc1701484e33b237cd7ee596ae5222d131baa6c621cb8a24d3b",
  "pageId": "gradebook",
  "taskId": "gradebook-assignment",
  "taskKind": "read",
  "readNeedleKeys": [
    "assignmentName"
  ],
  "steps": [
    {
      "command": "moveToNextHeading"
    },
    {
      "command": "moveToNextHeading"
    },
    {
      "command": "moveToNextHeading"
    },
    {
      "command": "moveToNextLandmark"
    },
    {
      "command": "moveToNextLandmark"
    },
    {
      "command": "moveToNextLandmark"
    },
    {
      "command": "moveToPreviousLandmark"
    },
    {
      "command": "moveToPreviousLandmark"
    },
    {
      "command": "readNext",
      "arg": "20"
    },
    {
      "command": "moveToPreviousHeading"
    },
    {
      "command": "readNext",
      "arg": "8"
    }
  ]
};

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

test("replay: gradebook__gradebook-assignment", async ({ page }) => {
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
    console.log(`[replay] resync at step ${r.stepIndex}: ${r.presses} presses to ${r.milestone}`);
  }

  if (PLAN.taskKind === "write") {
    await page.waitForTimeout(2500); // submission round-trip before the DB check
    const predicate = await getTask(PLAN.taskId)!.predicate(null, makeTaskContext(seed.seedValues));
    expect(predicate.success, predicate.detail).toBe(true);
  }
});
