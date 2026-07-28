/**
 * Real-NVDA replay runner — standalone tsx CLI (Windows only). The Windows/NVDA
 * counterpart of vo/run.ts.
 *
 * Re-drives the promoted SR replay plans (tests/e2e/a11y-tasks/) through real
 * NVDA + real Chromium against a remote deployment (deploy preview or staging),
 * asserting the same milestones/needles and DB predicates as the virtual-SR
 * specs. Navigation goes through Playwright (ChromeHost) and all interaction
 * through guidepup NVDA (NvdaHarness).
 *
 *   Usage: tsx tools/a11y-judge/nvda/run.ts [--filter substr] [--record] [--calibrate] [--list]
 *   Env:   BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, END_TO_END_SECRET
 *
 * --calibrate never fails on milestone/needle mismatch; it logs template vs
 * observed pairs — the tuning tool for VSR→real-NVDA phrasing drift (see the
 * NVDA_* pattern lists in nvdaHarness.ts). Run it before enforcing.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import waitForSchemaCache from "../../../tests/wait-for-schema-cache";
import { normalizePhrase, type Bindings } from "../agent/normalize";
import {
  milestoneMatches,
  replayPlan,
  STATE_CHANGING_COMMANDS,
  type ReplayPlan,
  type ReplayResult
} from "../agent/replay";
import { getTask } from "../agent/tasks";
import { loadPlans, type LoadedPlan } from "../vo/plans";
import { ChromeHost } from "./chromeHost";
import { NvdaDebugLog } from "./debug";
import { settlePage, waitForPageReady } from "./ready";
import { ARTIFACT_ROOT, writeRunArtifacts, type CalibrationEntry, type TaskReport } from "./report";
import { NvdaHarness } from "./nvdaHarness";

const REQUIRED_ENV = [
  "BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "END_TO_END_SECRET"
];
const STEP_PAUSE_MS = 300;
const RESYNC_LIMIT = 25;
const NEEDLE_SWEEP_LIMIT = 80;
const PER_COMMAND_TIMEOUT_MS = 30_000;
const WRITE_SETTLE_MS = 2500;
const TASK_RETRIES = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CliArgs {
  filter: string;
  record: boolean;
  calibrate: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { filter: "", record: false, calibrate: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--filter") args.filter = argv[++i] ?? "";
    else if (argv[i] === "--record") args.record = true;
    else if (argv[i] === "--calibrate") args.calibrate = true;
    else if (argv[i] === "--list") args.list = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/** Best-effort screen recording via ffmpeg gdigrab (a no-op if ffmpeg is
 *  absent — recordings are a convenience, never a gate). Returns a stopper. */
function startRecording(outPath: string): () => void {
  try {
    require("node:fs").mkdirSync(path.dirname(outPath), { recursive: true });
    const proc = spawn(
      "ffmpeg",
      ["-y", "-f", "gdigrab", "-framerate", "5", "-i", "desktop", "-pix_fmt", "yuv420p", outPath],
      { stdio: "ignore" }
    );
    let stopped = false;
    proc.on("error", () => {}); // ffmpeg not installed — silently skip
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        proc.stdin?.write("q");
      } catch {
        /* ignore */
      }
      setTimeout(() => proc.kill("SIGKILL"), 2000);
    };
  } catch {
    return () => {};
  }
}

/**
 * Calibration-mode replay: same walk as replayPlan, but milestone misses and
 * missing needles are recorded instead of thrown, so one drifted phrase doesn't
 * hide the drift data for the rest of the journey.
 */
async function calibratePlan(
  harness: NvdaHarness,
  plan: ReplayPlan,
  bindings: Bindings
): Promise<{ calibration: CalibrationEntry[]; result: ReplayResult; missingNeedles: string[] }> {
  const calibration: CalibrationEntry[] = [];
  const resyncs: ReplayResult["resyncs"] = [];
  const heardPhrases: string[] = [];

  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.milestone) {
      const current = await harness.run("observe");
      heardPhrases.push(...current.spokenSinceLastAction);
      const matched = milestoneMatches(step.milestone, current, bindings);
      let resyncPresses: number | null = matched ? 0 : null;
      if (!matched) {
        for (let press = 1; press <= RESYNC_LIMIT; press++) {
          const obs = await harness.run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          if (milestoneMatches(step.milestone, obs, bindings)) {
            resyncs.push({ stepIndex, presses: press, milestone: step.milestone });
            resyncPresses = press;
            break;
          }
        }
        if (resyncPresses === null) {
          for (let press = 1; press <= RESYNC_LIMIT * 2; press++) {
            const obs = await harness.run("previous");
            heardPhrases.push(...obs.spokenSinceLastAction);
            if (milestoneMatches(step.milestone, obs, bindings)) {
              resyncs.push({ stepIndex, presses: RESYNC_LIMIT - press, milestone: step.milestone });
              resyncPresses = RESYNC_LIMIT - press;
              break;
            }
          }
        }
      }
      calibration.push({
        stepIndex,
        command: step.command,
        milestone: step.milestone,
        observedItem: current.currentItem,
        matched,
        resyncPresses
      });
    }
    const observation = await harness.run(step.command, step.arg);
    heardPhrases.push(...observation.spokenSinceLastAction, observation.currentItem);
    if (STATE_CHANGING_COMMANDS.has(step.command)) await sleep(STEP_PAUSE_MS);
  }

  const heardNormalized = heardPhrases
    .map((p) => normalizePhrase(p, bindings))
    .filter((p): p is string => p !== null)
    .join("  ");
  const missingNeedles =
    plan.taskKind === "read"
      ? plan.readNeedleKeys.filter((key) => !heardNormalized.includes(`{{${key.toLowerCase()}}}`))
      : [];
  return { calibration, result: { resyncs, heardPhrases }, missingNeedles };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allPlans = loadPlans();
  const plans = allPlans.filter((p) => p.id.includes(args.filter));
  if (args.list) {
    for (const p of allPlans) {
      console.log(
        `${p.id}  (${p.plan.taskKind}, ${p.plan.steps.length} steps${p.blockedBy ? `, BLOCKED: ${p.blockedBy}` : ""})`
      );
    }
    return;
  }
  if (plans.length === 0)
    throw new Error(`--filter ${JSON.stringify(args.filter)} matched none of ${allPlans.length} plans`);

  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    throw new Error(
      `missing env: ${missingEnv.join(", ")} — on the Windows runner, hydrate via ` +
        `scripts/export-preview-e2e-from-bao.sh <pr> --shell (or export-staging-env.sh for dry-runs)`
    );
  }
  if (process.platform !== "win32")
    throw new Error("real NVDA requires Windows (run a11y:tasks for the virtual-SR lane, a11y:vo for macOS)");
  const baseUrl = process.env.BASE_URL!.replace(/\/$/, "");
  const runId = process.env.A11Y_NVDA_RUN_ID ?? `nvda-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

  console.log(
    `[a11y:nvda] ${plans.length}/${allPlans.length} plans, base ${baseUrl}, run ${runId}${args.calibrate ? " (CALIBRATE)" : ""}`
  );
  console.log("[a11y:nvda] waiting for PostgREST schema cache…");
  await waitForSchemaCache();

  const { seedAgentPages, makeTaskContext } = await import("../../../tests/e2e/a11yAgentSeeding");
  const { loginWithNvda, focusMainContent, seedTimezonePreference } = await import("./login");

  console.log("[a11y:nvda] seeding…");
  const seed = await seedAgentPages();
  const taskContext = makeTaskContext(seed.seedValues);

  const debug = new NvdaDebugLog(runId);
  const chrome = new ChromeHost();
  const harness = new NvdaHarness({
    commandTimeoutMs: PER_COMMAND_TIMEOUT_MS,
    fullCapture: process.env.A11Y_NVDA_CAPTURE === "full",
    onStep: (record) => debug.step(record),
    onDebug: (stage, detail) => debug.log(stage, detail),
    hostEval: (js) => chrome.evalJs(js),
    hostSetClipboard: (text) => chrome.setClipboard(text),
    pageTitle: () => chrome.evalJs("document.title")
  });
  const reports: TaskReport[] = [];

  let fatalError: unknown;
  try {
    console.log("[a11y:nvda] launching Chromium…");
    await chrome.launch();
    console.log("[a11y:nvda] starting NVDA…");
    await harness.start();
    console.log("[a11y:nvda] logging in through NVDA…");
    await loginWithNvda(chrome, harness, seed.student, baseUrl, (stage, detail) => debug.log(stage, detail));

    for (const loaded of plans) {
      reports.push(await runTask(loaded));
    }
  } catch (e) {
    fatalError = e;
    debug.fatal(e);
    await debug.screenshot("fatal");
  } finally {
    await harness.stop();
    await chrome.close();
  }

  const runDir = writeRunArtifacts(runId, reports, {
    baseUrl,
    runId,
    mode: args.calibrate ? "calibrate" : "enforce",
    filter: args.filter || "(all)",
    date: new Date().toISOString()
  });
  const failed = reports.filter((r) => r.status === "failed");
  const blocked = reports.filter((r) => r.status === "blocked");
  console.log(
    `[a11y:nvda] done: ${reports.length - failed.length - blocked.length} passed, ${failed.length} failed, ` +
      `${blocked.length} blocked — artifacts in ${runDir}`
  );
  if (fatalError !== undefined) throw fatalError;
  if (failed.length > 0) process.exitCode = 1;

  async function runTask(loaded: LoadedPlan): Promise<TaskReport> {
    const { plan } = loaded;
    const base: Omit<TaskReport, "status" | "durationMs" | "stepCount" | "resyncs" | "steps"> = {
      id: loaded.id,
      pageId: plan.pageId,
      taskId: plan.taskId,
      taskKind: plan.taskKind
    };
    if (loaded.blockedBy) {
      console.log(`[a11y:nvda] ⏭️  ${loaded.id} — blocked (${loaded.blockedBy})`);
      return {
        ...base,
        status: "blocked",
        blockedBy: loaded.blockedBy,
        durationMs: 0,
        stepCount: 0,
        resyncs: [],
        steps: []
      };
    }

    let lastError = "";
    for (let attempt = 0; attempt <= TASK_RETRIES; attempt++) {
      const started = Date.now();
      const stepsBefore = harness.steps.length;
      const recordingPath = args.record ? path.join(ARTIFACT_ROOT, runId, "recordings", `${loaded.id}.mp4`) : undefined;
      const stopRecording = recordingPath ? startRecording(recordingPath) : () => {};
      try {
        console.log(`[a11y:nvda] ▶ ${loaded.id} (attempt ${attempt + 1})`);
        // Fresh page per task so a previous task's SPA state can't block this
        // navigation; the httpOnly session cookie persists in the context.
        await chrome.closeAllWindows();
        await chrome.openUrl(baseUrl + seed.routes[plan.pageId]);
        await seedTimezonePreference(chrome);
        await waitForPageReady(chrome);
        for (const key of plan.readNeedleKeys) {
          const value = seed.seedValues[key];
          if (!value) continue;
          const appeared = await chrome.waitForJs(
            `String(document.body.innerText.includes(${JSON.stringify(value)}))`,
            90_000,
            2000
          );
          debug.log("content gate", { task: loaded.id, needle: key, appeared });
        }
        await settlePage(chrome);
        await harness.focusWebArea(focusMainContent(chrome));

        let calibration: CalibrationEntry[] | undefined;
        let result: ReplayResult;
        if (args.calibrate) {
          const c = await calibratePlan(harness, plan, seed.seedValues);
          calibration = c.calibration;
          result = c.result;
          if (c.missingNeedles.length > 0) {
            console.log(`[a11y:nvda]   calibrate: needles never heard: ${c.missingNeedles.join(", ")}`);
          }
        } else {
          result = await replayPlan(harness, plan, seed.seedValues, {
            pause: sleep,
            stepPauseMs: STEP_PAUSE_MS,
            resyncLimit: RESYNC_LIMIT,
            perCommandTimeoutMs: PER_COMMAND_TIMEOUT_MS,
            needleSweepLimit: NEEDLE_SWEEP_LIMIT
          });
        }

        if (plan.taskKind === "write" && !args.calibrate) {
          await sleep(WRITE_SETTLE_MS);
          const predicate = await getTask(plan.taskId)!.predicate(null, taskContext);
          if (!predicate.success) throw new Error(`write predicate failed: ${predicate.detail}`);
        }

        console.log(`[a11y:nvda] ✅ ${loaded.id} (${result.resyncs.length} resyncs)`);
        return {
          ...base,
          status: "passed",
          durationMs: Date.now() - started,
          stepCount: plan.steps.length,
          resyncs: result.resyncs,
          calibration,
          recordingPath,
          steps: harness.steps.slice(stepsBefore)
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.log(`[a11y:nvda] ❌ ${loaded.id} attempt ${attempt + 1}: ${lastError}`);
        await debug.screenshot(`${loaded.id}-attempt${attempt + 1}-failed`);
        if (attempt === TASK_RETRIES) {
          return {
            ...base,
            status: "failed",
            error: lastError,
            durationMs: Date.now() - started,
            stepCount: plan.steps.length,
            resyncs: [],
            recordingPath,
            steps: harness.steps.slice(stepsBefore)
          };
        }
      } finally {
        stopRecording();
      }
    }
    throw new Error(`unreachable: ${loaded.id} (${lastError})`);
  }
}

main().catch((e) => {
  console.error(`[a11y:nvda] fatal: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
