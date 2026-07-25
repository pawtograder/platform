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
import type { AtCommand, AtDriver, AtObservation } from "./atHarness";
import { normalizePhrase, templateMatches, templatePrefixMatches, type Bindings } from "./normalize";

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

/**
 * Milestone check against the primary item text OR any driver-supplied
 * alternate rendering (real VoiceOver embeds bare role words — "Complete
 * button" — that exact template equality can't safely strip).
 */
export function milestoneMatches(milestone: string, observation: AtObservation, bindings: Bindings): boolean {
  const candidates = [observation.currentItem, ...(observation.currentItemAlternates ?? [])];
  if (candidates.some((c) => templateMatches(milestone, c, bindings))) return true;
  // Word-boundary prefix: real AT can compute a longer accessible name than
  // the recorder did ("post" vs "Post as Agent Student").
  return candidates.some((c) => templatePrefixMatches(milestone, c, bindings));
}

export async function replayPlan(
  harness: AtDriver,
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
    /**
     * Fail a single command (not the whole process) if the driver hangs.
     * The virtual SR cannot hang, but real VoiceOver's AppleScript events
     * occasionally do. 0 (default) = no timeout.
     */
    perCommandTimeoutMs?: number;
  } = {}
): Promise<ReplayResult> {
  const resyncLimit = options.resyncLimit ?? DEFAULT_RESYNC_LIMIT;
  const pause = options.pause ?? (async () => {});
  const stepPauseMs = options.stepPauseMs ?? 0;
  const perCommandTimeoutMs = options.perCommandTimeoutMs ?? 0;
  const run = (command: AtCommand, arg?: string): Promise<AtObservation> => {
    if (perCommandTimeoutMs <= 0) return harness.run(command, arg);
    // type is per-character on real AT drivers — scale its budget with length.
    const budgetMs = perCommandTimeoutMs + (command === "type" ? (arg?.length ?? 0) * 1000 : 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`AT command "${command}" timed out after ${budgetMs}ms`)),
        budgetMs
      );
      harness.run(command, arg).then(
        (obs) => {
          clearTimeout(timer);
          resolve(obs);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  };
  const paced = async () => {
    if (stepPauseMs > 0) await pause(stepPauseMs);
  };
  const resyncs: ReplayResult["resyncs"] = [];
  const heardPhrases: string[] = [];

  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.milestone) {
      const current = await run("observe");
      heardPhrases.push(...current.spokenSinceLastAction);
      await paced();
      if (!milestoneMatches(step.milestone, current, bindings)) {
        let found = false;
        for (let press = 1; press <= resyncLimit; press++) {
          const obs = await run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          await paced();
          if (milestoneMatches(step.milestone, obs, bindings)) {
            resyncs.push({ stepIndex, presses: press, milestone: step.milestone });
            found = true;
            break;
          }
        }
        // Backward pass: real-AT drivers can linearize content differently
        // from the virtual SR and OVERSHOOT the milestone (observed live:
        // real VoiceOver was already past the survey's first question), and a
        // forward-only search can never recover that. Walk back through the
        // forward excursion plus the same budget on the other side; backward
        // hits are reported as negative presses.
        if (!found) {
          for (let press = 1; press <= resyncLimit * 2; press++) {
            const obs = await run("previous");
            heardPhrases.push(...obs.spokenSinceLastAction);
            await paced();
            if (milestoneMatches(step.milestone, obs, bindings)) {
              resyncs.push({ stepIndex, presses: resyncLimit - press, milestone: step.milestone });
              found = true;
              break;
            }
          }
        }
        if (!found) {
          throw new ReplayMilestoneError(
            `step ${stepIndex} (${step.command}): milestone ${JSON.stringify(step.milestone)} not found ` +
              `within ${resyncLimit} presses forward or ${resyncLimit} back (cursor was on ` +
              `${JSON.stringify(current.currentItem)})`
          );
        }
      }
    }
    const observation = await run(step.command, step.arg);
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
