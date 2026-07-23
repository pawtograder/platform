/**
 * Deterministic trajectory replay (a11y-judge v2, Wave 4) — no LLM.
 *
 * A ReplayPlan is distilled from a successful agent trajectory by
 * generateSpec.ts. Replaying executes the same AT-harness commands with three
 * kinds of assertions:
 *   1. MILESTONES: before every state-changing command, the virtual cursor
 *      must rest on the item the agent acted on (normalized template match),
 *      with a bounded, logged resync (≤ resyncLimit `next` presses) so minor
 *      content drift is visible but real regressions still fail;
 *   2. read-tasks: every ground-truth needle must be HEARD during the journey;
 *   3. write-tasks: the task's machine predicate (checked by the caller).
 */
import { AtHarness, type AtCommand } from "./atHarness";
import { normalizePhrase, templateMatches, type Bindings } from "./normalize";

export const GENERATOR_VERSION = "1";
export const DEFAULT_RESYNC_LIMIT = 10;

/** Commands whose effect depends on what the cursor/focus is on. */
export const STATE_CHANGING_COMMANDS: ReadonlySet<string> = new Set(["act", "interact", "type", "press", "pressKey"]);

export interface ReplayStep {
  command: AtCommand;
  arg?: string;
  /** Normalized template of the item the cursor rested on before this step. */
  milestone?: string;
}

export interface ReplayPlan {
  generatorVersion: string;
  sourceTrajectoryHash: string;
  pageId: string;
  taskId: string;
  taskKind: "write" | "read";
  /** Binding KEYS whose values must be heard during replay (read-tasks). */
  readNeedleKeys: string[];
  steps: ReplayStep[];
}

export interface ReplayResult {
  resyncs: Array<{ stepIndex: number; presses: number; milestone: string }>;
  heardPhrases: string[];
}

export class ReplayMilestoneError extends Error {}
export class ReplayNeedleError extends Error {}

export async function replayPlan(
  harness: AtHarness,
  plan: ReplayPlan,
  bindings: Bindings,
  options: {
    resyncLimit?: number;
    pause?: (ms: number) => Promise<unknown>;
    /**
     * Video-mode pacing: when > 0, pause this long after EVERY harness command
     * (plan steps, resync presses, milestone observes) so pure navigation is
     * watchable in a recording. 0 (default) = existing full-speed behavior.
     */
    stepPauseMs?: number;
  } = {}
): Promise<ReplayResult> {
  const resyncLimit = options.resyncLimit ?? DEFAULT_RESYNC_LIMIT;
  const pause = options.pause ?? (async () => {});
  const stepPauseMs = options.stepPauseMs ?? 0;
  const paced = async () => {
    if (stepPauseMs > 0) await pause(stepPauseMs);
  };
  const resyncs: ReplayResult["resyncs"] = [];
  const heardPhrases: string[] = [];

  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.milestone) {
      const current = await harness.run("observe");
      heardPhrases.push(...current.spokenSinceLastAction);
      await paced();
      if (!templateMatches(step.milestone, current.currentItem, bindings)) {
        let found = false;
        for (let press = 1; press <= resyncLimit; press++) {
          const obs = await harness.run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          await paced();
          if (templateMatches(step.milestone, obs.currentItem, bindings)) {
            resyncs.push({ stepIndex, presses: press, milestone: step.milestone });
            found = true;
            break;
          }
        }
        if (!found) {
          throw new ReplayMilestoneError(
            `step ${stepIndex} (${step.command}): milestone ${JSON.stringify(step.milestone)} not found ` +
              `within ${resyncLimit} presses (cursor was on ${JSON.stringify(current.currentItem)})`
          );
        }
      }
    }
    const observation = await harness.run(step.command, step.arg);
    heardPhrases.push(...observation.spokenSinceLastAction, observation.currentItem);
    // Replay is ~1000× faster than the agent's natural pacing (LLM latency
    // between the agent's tool calls gave the app seconds to settle). Pause
    // briefly after state-changing commands so replay doesn't outrun the app's
    // async reactions (autosaves, realtime refetches, route transitions).
    if (STATE_CHANGING_COMMANDS.has(step.command)) await pause(Math.max(300, stepPauseMs));
    else await paced();
  }

  if (plan.taskKind === "read") {
    const heardNormalized = heardPhrases
      .map((p) => normalizePhrase(p, bindings))
      .filter((p): p is string => p !== null)
      .join("  ");
    // normalizePhrase lowercases its output, so placeholder keys appear
    // lowercased in the heard log.
    const missing = plan.readNeedleKeys.filter((key) => !heardNormalized.includes(`{{${key.toLowerCase()}}}`));
    if (missing.length > 0) {
      throw new ReplayNeedleError(
        `read-task ground truth never heard during replay: ${missing
          .map((key) => `${key}=${JSON.stringify(bindings[key] ?? "?")}`)
          .join(", ")}`
      );
    }
  }
  return { resyncs, heardPhrases };
}
