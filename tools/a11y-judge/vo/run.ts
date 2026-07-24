/**
 * Real-VoiceOver replay runner — standalone tsx CLI (macOS only).
 *
 * Re-drives the promoted SR replay plans (tests/e2e/a11y-tasks/) through real
 * VoiceOver + real Safari against a remote deployment (deploy preview or
 * staging), asserting the same milestones/needles and DB predicates as the
 * virtual-SR specs. Not a Playwright suite: Playwright cannot drive real
 * Safari, so navigation goes through AppleScript (SafariHost) and all
 * interaction through guidepup VoiceOver (VoHarness).
 *
 *   Usage: tsx tools/a11y-judge/vo/run.ts [--filter substr] [--record] [--calibrate] [--list]
 *   Env:   BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, END_TO_END_SECRET
 *
 * --calibrate never fails on milestone/needle mismatch; it logs template vs
 * observed pairs — the tuning tool for VSR→real-VO phrasing drift (see
 * VO_* pattern lists in voHarness.ts). Run it before enforcing.
 */
import path from "node:path";
import { macOSRecord } from "@guidepup/record";
import waitForSchemaCache from "../../../tests/wait-for-schema-cache";
import { normalizePhrase, templateMatches, type Bindings } from "../agent/normalize";
import { replayPlan, STATE_CHANGING_COMMANDS, type ReplayPlan, type ReplayResult } from "../agent/replay";
import { getTask } from "../agent/tasks";
import { loadPlans, type LoadedPlan } from "./plans";
import { ARTIFACT_ROOT, writeRunArtifacts, type CalibrationEntry, type TaskReport } from "./report";
import { SafariHost } from "./safari";
import { VoHarness } from "./voHarness";
import { settlePage, waitForPageReady } from "./ready";

const REQUIRED_ENV = [
  "BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "END_TO_END_SECRET"
];
const STEP_PAUSE_MS = 300;
const RESYNC_LIMIT = 15;
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

/**
 * Calibration-mode replay: same walk as replayPlan, but milestone misses and
 * missing needles are recorded instead of thrown, so one drifted phrase
 * doesn't hide the drift data for the rest of the journey.
 */
async function calibratePlan(
  harness: VoHarness,
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
      const matched = templateMatches(step.milestone, current.currentItem, bindings);
      let resyncPresses: number | null = matched ? 0 : null;
      if (!matched) {
        for (let press = 1; press <= RESYNC_LIMIT; press++) {
          const obs = await harness.run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          if (templateMatches(step.milestone, obs.currentItem, bindings)) {
            resyncs.push({ stepIndex, presses: press, milestone: step.milestone });
            resyncPresses = press;
            break;
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
      `missing env: ${missingEnv.join(", ")} — on the Mac runner, hydrate via ` +
        `scripts/export-preview-e2e-from-bao.sh <pr> --shell (or export-staging-env.sh for dry-runs)`
    );
  }
  if (process.platform !== "darwin")
    throw new Error("real VoiceOver requires macOS (run a11y:tasks for the virtual-SR lane)");
  const baseUrl = process.env.BASE_URL!.replace(/\/$/, "");
  const runId = process.env.A11Y_VO_RUN_ID ?? `vo-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

  console.log(
    `[a11y:vo] ${plans.length}/${allPlans.length} plans, base ${baseUrl}, run ${runId}${args.calibrate ? " (CALIBRATE)" : ""}`
  );
  console.log("[a11y:vo] waiting for PostgREST schema cache…");
  await waitForSchemaCache();

  // Env-dependent modules (TestingUtils builds its service-role client at
  // import time) load only after the env assert above.
  const { seedAgentPages, makeTaskContext } = await import("../../../tests/e2e/a11yAgentSeeding");
  const { loginWithVoiceOver, focusMainContent, seedTimezonePreference } = await import("./login");

  console.log("[a11y:vo] seeding…");
  const seed = await seedAgentPages();
  const taskContext = makeTaskContext(seed.seedValues);

  const safari = new SafariHost();
  const harness = new VoHarness({ commandTimeoutMs: PER_COMMAND_TIMEOUT_MS });
  const reports: TaskReport[] = [];

  try {
    console.log("[a11y:vo] starting VoiceOver…");
    await harness.start();
    console.log("[a11y:vo] logging in through VoiceOver…");
    await loginWithVoiceOver(safari, harness, seed.student, baseUrl);

    for (const loaded of plans) {
      reports.push(await runTask(loaded));
    }
  } finally {
    await harness.stop();
    await safari.closeAllWindows();
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
    `[a11y:vo] done: ${reports.length - failed.length - blocked.length} passed, ${failed.length} failed, ` +
      `${blocked.length} blocked — artifacts in ${runDir}`
  );
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
      console.log(`[a11y:vo] ⏭️  ${loaded.id} — blocked (${loaded.blockedBy})`);
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
      const recordingPath = args.record ? path.join(ARTIFACT_ROOT, runId, "recordings", `${loaded.id}.mov`) : undefined;
      const stopRecording = recordingPath ? macOSRecord(recordingPath) : () => {};
      try {
        console.log(`[a11y:vo] ▶ ${loaded.id} (attempt ${attempt + 1})`);
        await safari.openUrl(baseUrl + seed.routes[plan.pageId]);
        await seedTimezonePreference(safari);
        await waitForPageReady(safari);
        await settlePage(safari);
        await harness.focusWebArea(focusMainContent(safari));

        let calibration: CalibrationEntry[] | undefined;
        let result: ReplayResult;
        if (args.calibrate) {
          const c = await calibratePlan(harness, plan, seed.seedValues);
          calibration = c.calibration;
          result = c.result;
          if (c.missingNeedles.length > 0) {
            console.log(`[a11y:vo]   calibrate: needles never heard: ${c.missingNeedles.join(", ")}`);
          }
        } else {
          result = await replayPlan(harness, plan, seed.seedValues, {
            pause: sleep,
            stepPauseMs: STEP_PAUSE_MS,
            resyncLimit: RESYNC_LIMIT,
            perCommandTimeoutMs: PER_COMMAND_TIMEOUT_MS
          });
        }

        if (plan.taskKind === "write" && !args.calibrate) {
          await sleep(WRITE_SETTLE_MS);
          const predicate = await getTask(plan.taskId)!.predicate(null, taskContext);
          if (!predicate.success) throw new Error(`write predicate failed: ${predicate.detail}`);
        }

        console.log(`[a11y:vo] ✅ ${loaded.id} (${result.resyncs.length} resyncs)`);
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
        console.log(`[a11y:vo] ❌ ${loaded.id} attempt ${attempt + 1}: ${lastError}`);
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
  console.error(`[a11y:vo] fatal: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
