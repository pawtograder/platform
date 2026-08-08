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
 * NVDA_* pattern lists in nvdaHarness.ts). Run it before enforcing. It is also
 * the only mode in which a DEGRADED type step (nvdaHarness TypeStepFidelity:
 * rung 4 bypassed the keyboard, or the text was never verified to land) merely
 * warns — in enforce mode it fails the task, because "3 consecutive green
 * enforce runs" must not be reachable with every write silently degraded.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import waitForSchemaCache from "../../../tests/wait-for-schema-cache";
import { normalizePhrase, type Bindings } from "../agent/normalize";
import {
  CONTROL_RESYNC_OFFSET,
  CONTROL_SWEEP_LIMIT,
  createMilestoneGate,
  replayPlan,
  STATE_CHANGING_COMMANDS,
  type ReplayDebug,
  type ReplayPlan,
  type ReplayResult
} from "../agent/replay";
import { getTask } from "../agent/tasks";
import { loadPlans, type LoadedPlan } from "../vo/plans";
import { ChromeHost } from "./chromeHost";
import { NvdaDebugLog } from "./debug";
import { settlePage, waitForPageReady } from "./ready";
import {
  ARTIFACT_ROOT,
  describeCursorContradiction,
  describeHostClear,
  describeSweepMutation,
  describeTypeDegradation,
  writeRunArtifacts,
  type CalibrationEntry,
  type TaskReport
} from "./report";
import { NvdaHarness, type NvdaCursorCheck, type SweepMutation, type TypeStepFidelity } from "./nvdaHarness";

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
 *
 * The milestone gate (createMilestoneGate) is shared with replayPlan rather than
 * re-implemented, for the same reason the step context is: calibration data has
 * to come from the same decision procedure as the run it calibrates, and this is
 * the mode where the drift is supposed to be VISIBLE. `matched` therefore now
 * means "the speech matched AND NVDA's own cursor did not contradict it" — the
 * distinction that made run 30682097759's calibration read clean while 11 of 14
 * state-changing steps fired on unrecorded elements.
 */
async function calibratePlan(
  harness: NvdaHarness,
  plan: ReplayPlan,
  bindings: Bindings,
  onDebug: ReplayDebug
): Promise<{ calibration: CalibrationEntry[]; result: ReplayResult; missingNeedles: string[] }> {
  const calibration: CalibrationEntry[] = [];
  const resyncs: ReplayResult["resyncs"] = [];
  const heardPhrases: string[] = [];

  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.milestone) {
      // Per step, exactly as in replayPlan: the gate's consultation budget and
      // its per-observation memo are what bound the oracle round trips, and both
      // are meant to reset at each milestone.
      const satisfied = createMilestoneGate(harness, bindings, onDebug);
      const current = await harness.run("observe");
      heardPhrases.push(...current.spokenSinceLastAction);
      const matched = await satisfied(step.milestone, current);
      let resyncPresses: number | null = matched ? 0 : null;
      if (!matched) {
        for (let press = 1; press <= RESYNC_LIMIT; press++) {
          const obs = await harness.run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          if (await satisfied(step.milestone, obs)) {
            resyncs.push({ stepIndex, presses: press, milestone: step.milestone });
            resyncPresses = press;
            break;
          }
        }
        if (resyncPresses === null) {
          for (let press = 1; press <= RESYNC_LIMIT * 2; press++) {
            const obs = await harness.run("previous");
            heardPhrases.push(...obs.spokenSinceLastAction);
            if (await satisfied(step.milestone, obs)) {
              resyncs.push({ stepIndex, presses: RESYNC_LIMIT - press, milestone: step.milestone });
              resyncPresses = RESYNC_LIMIT - press;
              break;
            }
          }
        }
        // Control sweep, mirroring replayPlan's rung of the same name: the two
        // sweeps above are ArrowDown/ArrowUp and rest at the LINE start, so a
        // milestone naming one of several controls coalesced onto one browse line
        // is unreachable by them (run 30760469666, discussion__discussion-reply
        // step 11 — the cursor sat on Like while the line named Reply). No
        // `harness.moveToControl` guard here, unlike replayPlan: this walk is
        // NvdaHarness-only and NvdaHarness always implements the hook.
        // ±(CONTROL_RESYNC_OFFSET + hop) is the same encoding replayPlan records.
        if (resyncPresses === null) {
          for (const direction of ["next", "previous"] as const) {
            const budget = direction === "next" ? CONTROL_SWEEP_LIMIT : CONTROL_SWEEP_LIMIT * 2;
            for (let hop = 1; hop <= budget; hop++) {
              await harness.moveToControl(direction);
              const obs = await harness.run("observe");
              heardPhrases.push(...obs.spokenSinceLastAction);
              if (await satisfied(step.milestone, obs)) {
                const presses = CONTROL_RESYNC_OFFSET + hop;
                resyncPresses = direction === "next" ? presses : -presses;
                resyncs.push({ stepIndex, presses: resyncPresses, milestone: step.milestone });
                break;
              }
            }
            if (resyncPresses !== null) break;
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
    // Same step context replayPlan passes (AtStepContext.milestone) — a
    // --calibrate walk must route `type` steps exactly like an enforced one, or
    // the calibration data comes from a different code path than the run it is
    // calibrating.
    const observation = await harness.run(step.command, step.arg, { milestone: step.milestone });
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
  // Repeat the headline at the end of the log: in calibrate mode this is the
  // only signal, and it is the one thing that must not be scrolled past.
  const degradedTasks = reports.filter((r) => (r.typeFidelity ?? []).some((f) => f.degraded));
  if (degradedTasks.length > 0) {
    console.log(
      `[a11y:nvda] ⚠️  ${degradedTasks.length} task(s) with DEGRADED type steps (keyboard input did not do the ` +
        `typing): ${degradedTasks.map((r) => r.id).join(", ")} — see summary.md`
    );
  }
  const contradictedTasks = reports.filter((r) => (r.cursorChecks ?? []).some((c) => c.verdict === "contradicted"));
  if (contradictedTasks.length > 0) {
    console.log(
      `[a11y:nvda] ⚠️  ${contradictedTasks.length} task(s) where NVDA's own cursor CONTRADICTED the plan (a ` +
        `state-changing step fired on an unrecorded element): ${contradictedTasks.map((r) => r.id).join(", ")} ` +
        `— see summary.md`
    );
  }
  const mutatingTasks = reports.filter((r) => (r.sweepMutations ?? []).length > 0);
  if (mutatingTasks.length > 0) {
    console.log(
      `[a11y:nvda] ⚠️  ${mutatingTasks.length} task(s) where a READING sweep changed the page's answers (an ` +
        `arrow inside a radio group selects — issue #913): ${mutatingTasks.map((r) => r.id).join(", ")} ` +
        `— see summary.md`
    );
  }
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
      // Drained (not read) once per attempt, and drained again on the failure
      // path, so a degraded step can never be reported against a later task —
      // including when a later attempt dies before harness.focusWebArea(), the
      // other place these records are cleared.
      let fidelity: TypeStepFidelity[] = [];
      let cursorChecks: NvdaCursorCheck[] = [];
      let sweepMutations: SweepMutation[] = [];
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
          const c = await calibratePlan(harness, plan, seed.seedValues, (stage, detail) => debug.log(stage, detail));
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
            needleSweepLimit: NEEDLE_SWEEP_LIMIT,
            // Every milestone-gate decision — consulted or not, and what NVDA
            // answered — into debug.jsonl and the CI log, alongside the driver's
            // own "cursor gate:" lines. A gate that silently rejected matches
            // would be indistinguishable from ordinary content drift.
            onDebug: (stage, detail) => debug.log(stage, detail)
          });
        }

        // Typing fidelity. Rung 4 of the type ladder sets the field's value from
        // the DOM, so a task can satisfy its write predicate with the keyboard
        // bypassed entirely — a green run that proves the opposite of what it
        // claims. Warn always; in enforce mode it is a task failure, like the
        // write predicate below.
        fidelity = harness.takeTypeFidelity();
        const degraded = fidelity.filter((f) => f.degraded);
        for (const f of degraded) {
          console.log(`[a11y:nvda]   ⚠️  DEGRADED TYPE STEP — ${describeTypeDegradation(f)}`);
        }
        // A step that recovered via rung 2/3 keeps full typing fidelity (real
        // keystrokes) and is NOT degraded — but the ladder emptied the field
        // through the DOM to get there, and that must not pass unmentioned just
        // because the step ended up clean.
        for (const f of fidelity.filter((x) => !x.degraded && x.hostClear !== "none")) {
          console.log(
            `[a11y:nvda]   ℹ️  type step ${f.stepIndex} needed rung ${f.carriedBy ?? "?"}${describeHostClear(f)}`
          );
        }

        // Cursor corroboration. NVDA was asked (reportCurrentObject) where its
        // review cursor actually was before every milestone-bearing
        // state-changing step; a contradiction means the step fired on an
        // element the plan never recorded, which milestone matching cannot see
        // because it reads the speech TAIL (run 30483480823: an `act` on the
        // page title, 0 resyncs, nothing in the summary). Warn always; in
        // enforce mode it fails the task, like a degraded type step.
        //
        // These are the PER-STEP records, one per state-changing step, and they
        // stay the enforcement signal. The milestone gate (createMilestoneGate)
        // now asks the same oracle earlier and rejects a milestone the cursor
        // contradicts, so a contradiction surviving to here should become rare:
        // it means the gate stood down (its per-step consultation budget was
        // spent) or the cursor moved between the gate and the gesture. Gate
        // consultations are deliberately NOT recorded here — a gate rejecting a
        // false positive mid-sweep is the system working, and counting it as a
        // contradiction would fail tasks the ladder went on to resync correctly.
        // They are in the debug log ("cursor gate:" / "milestone gate:").
        cursorChecks = harness.takeCursorChecks();
        const contradicted = cursorChecks.filter((c) => c.verdict === "contradicted");
        for (const c of contradicted) {
          console.log(`[a11y:nvda]   ⚠️  CURSOR CONTRADICTION — ${describeCursorContradiction(c)}`);
        }

        // Sweep mutations. `next`/`previous` are arrows, and in focus mode an
        // arrow inside a radio group selects — so a reading sweep can answer the
        // survey it is reading (issue #913). Drained BEFORE the write predicate
        // below, because a mutating sweep is exactly what makes that predicate
        // lie: the answer it finds is the driver's, not the user's.
        sweepMutations = harness.takeSweepMutations();
        for (const m of sweepMutations) {
          console.log(`[a11y:nvda]   ⚠️  SWEEP MUTATION — ${describeSweepMutation(m)}`);
        }

        if (plan.taskKind === "write" && !args.calibrate) {
          await sleep(WRITE_SETTLE_MS);
          const predicate = await getTask(plan.taskId)!.predicate(null, taskContext);
          if (!predicate.success) throw new Error(`write predicate failed: ${predicate.detail}`);
        }
        if (degraded.length > 0 && !args.calibrate) {
          throw new Error(
            `type fidelity degraded (a screen-reader user could not have typed this): ` +
              degraded.map(describeTypeDegradation).join(" | ")
          );
        }
        if (contradicted.length > 0 && !args.calibrate) {
          throw new Error(
            `cursor oracle contradicted the plan (a state-changing step fired on an element the plan never ` +
              `recorded — the speech tail matched, the cursor did not): ` +
              contradicted.map(describeCursorContradiction).join(" | ")
          );
        }
        // Fails the task even when the restore succeeded: the repair keeps the
        // rest of the run honest, it does not turn a write back into a read.
        if (sweepMutations.length > 0 && !args.calibrate) {
          throw new Error(
            `a reading sweep changed the page's answers (see issue #913 — NVDA reports these controls ` +
              `correctly; the driver's own arrow keys were selecting them): ` +
              sweepMutations.map(describeSweepMutation).join(" | ")
          );
        }

        console.log(
          `[a11y:nvda] ✅ ${loaded.id} (${result.resyncs.length} resyncs, cursor oracle: ` +
            `${cursorChecks.filter((c) => c.verdict === "agreed").length}/${cursorChecks.length} agreed)`
        );
        return {
          ...base,
          status: "passed",
          durationMs: Date.now() - started,
          stepCount: plan.steps.length,
          resyncs: result.resyncs,
          calibration,
          typeFidelity: fidelity,
          cursorChecks,
          sweepMutations,
          recordingPath,
          steps: harness.steps.slice(stepsBefore)
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.log(`[a11y:nvda] ❌ ${loaded.id} attempt ${attempt + 1}: ${lastError}`);
        await debug.screenshot(`${loaded.id}-attempt${attempt + 1}-failed`);
        // Whatever the drain above did not already collect (the throw may have
        // come from the replay itself, before it ran): the fidelity of a failed
        // attempt is exactly what a reader of the artifacts wants. Only the
        // newly drained records are printed — the rest already were.
        const undrained = harness.takeTypeFidelity();
        for (const f of undrained.filter((x) => x.degraded)) {
          console.log(`[a11y:nvda]   ⚠️  DEGRADED TYPE STEP — ${describeTypeDegradation(f)}`);
        }
        fidelity = [...fidelity, ...undrained];
        // Same story for the cursor checks, and this is the path that matters
        // most: an attempt that died mid-plan is exactly when "where was the
        // cursor when that step fired?" is the question being asked.
        const undrainedChecks = harness.takeCursorChecks();
        for (const c of undrainedChecks.filter((x) => x.verdict === "contradicted")) {
          console.log(`[a11y:nvda]   ⚠️  CURSOR CONTRADICTION — ${describeCursorContradiction(c)}`);
        }
        cursorChecks = [...cursorChecks, ...undrainedChecks];
        // And the sweep mutations, for the same reason: an attempt that died
        // mid-plan is when "did the driver answer the question itself?" matters
        // most, because the write predicate never got to run.
        const undrainedMutations = harness.takeSweepMutations();
        for (const m of undrainedMutations) {
          console.log(`[a11y:nvda]   ⚠️  SWEEP MUTATION — ${describeSweepMutation(m)}`);
        }
        sweepMutations = [...sweepMutations, ...undrainedMutations];
        if (attempt === TASK_RETRIES) {
          return {
            ...base,
            status: "failed",
            error: lastError,
            durationMs: Date.now() - started,
            stepCount: plan.steps.length,
            resyncs: [],
            typeFidelity: fidelity,
            cursorChecks,
            sweepMutations,
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
