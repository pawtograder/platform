/**
 * Deterministic trajectory replay (a11y-judge v2, Wave 4) — no LLM.
 *
 * A ReplayPlan is distilled from a successful agent trajectory by
 * generateSpec.ts. Replaying executes the same AT-harness commands with three
 * kinds of assertions:
 *   1. MILESTONES: before every state-changing command, the virtual cursor
 *      must rest on the item the agent acted on (normalized template match,
 *      gated on the driver's own cursor read where it offers one — see
 *      createMilestoneGate), with a bounded, logged resync (≤ resyncLimit
 *      `next` presses) so minor content drift is visible but real regressions
 *      still fail;
 *   2. read-tasks: every ground-truth needle must be HEARD during the journey;
 *   3. write-tasks: the task's machine predicate (checked by the caller).
 */
import type { AtCommand, AtDriver, AtObservation, AtStepContext, CursorVerdict } from "./atHarness";
import { normalizePhrase, templateMatches, templatePrefixMatches, type Bindings } from "./normalize";

export const GENERATOR_VERSION = "1";
export const DEFAULT_RESYNC_LIMIT = 10;

/**
 * Oracle consultations (AtDriver.verifyCursor) allowed per milestone-bearing
 * step, after which the gate stands down for the rest of that step.
 *
 * A consultation is a real round trip to the AT — measured on NVDA at ~1.5-2.5s
 * typical and ~8.4s worst case — so it can only ever be spent on a milestone
 * that is ALREADY claimed to match. That alone bounds it to one call per false
 * positive found during a sweep, which is normally one call per step. But the
 * defect this gate exists to fix is precisely a driver whose currentItem goes
 * STALE, and a stale item matches on EVERY press: without a cap, one such step
 * could spend a consultation on all 25 forward + 50 back + 75 post-unstick
 * presses. The per-step memo below already collapses the identical-item case to
 * a single call; this is the backstop for the other shape (a loose template that
 * genuinely matches many different items).
 *
 * Eight, because eight distinct contradicted readings in one step is already a
 * finding rather than a hiccup, and 8 × 8.4s worst case keeps the added latency
 * of a pathological step inside a minute.
 */
export const MAX_CURSOR_VERIFICATIONS_PER_STEP = 8;

/**
 * Control hops (AtDriver.moveToControl) allowed in ONE direction when the
 * line-wise sweeps have failed. Small on purpose — a page has far fewer controls
 * than lines — and eight for a reason with two halves:
 *  - the miss this rung exists for is measured in single hops: in run
 *    30760469666 the cursor sat on Like and the milestone was Reply, two buttons
 *    along the same coalesced browse line;
 *  - but the rung does not start from there. It starts wherever the backward
 *    sweep left the cursor, which is up to resyncLimit lines ABOVE the target
 *    (or the top of the document), so the budget also has to cover the controls
 *    in between.
 * That last point is why 8 was too small. Measured in run 30775582313: the hops
 * fired 74 times and quick-nav worked exactly as intended, walking "Open search"
 * -> "Support and Documentation, menu button" -> "Toggle color mode" ->
 * "Notifications, button" -> "Toggle obfuscated grades mode" -> "Open user menu,
 * button" -> "Discussion, region, Hide sidebar" — but that is already SEVEN
 * page-chrome buttons before the discussion region, so the whole forward budget
 * was spent in the header and the post's own cluster was never reached.
 * 32 covers the app's chrome (header, sidebar, per-post action clusters above the
 * target) with headroom. The backward pass gets twice this (undo the forward
 * excursion, then the same budget on the other side), exactly like the line-wise
 * ladder. Worst case is 96 hops — more than the 75 arrow presses already spent,
 * but each hop is one gesture plus one observe, and it only runs when the
 * line-wise ladder has already failed.
 */
export const CONTROL_SWEEP_LIMIT = 32;

/**
 * Encoding band for control-hop resyncs in ReplayResult.resyncs[].presses,
 * which is already overloaded: forward line presses are `press`, backward ones
 * are `resyncLimit - press`, post-unstick ones are `resyncLimit + press`. All
 * three are bounded by 3 × resyncLimit in magnitude (75 on the NVDA lane), so a
 * control hop reports `±(CONTROL_RESYNC_OFFSET + hop)`: the magnitude being at
 * least 1000 says "this resync was a control hop, not a line press", the low
 * digits say how many hops it took, and the sign says which way it went
 * (negative = backward, as in the line-wise backward pass).
 */
export const CONTROL_RESYNC_OFFSET = 1000;

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

/** Diagnostic sink for the milestone gate; absent = silent (VSR/VoiceOver). */
export type ReplayDebug = (stage: string, detail?: Record<string, unknown>) => void;

/**
 * Build the per-step milestone gate: "does the speech match?" AND, when the
 * driver can answer it, "does the driver's own cursor agree?".
 *
 * WHY a gate and not a record. milestoneMatches reads observation.currentItem,
 * which on real NVDA is a tail of the speech log, so a stale utterance satisfies
 * a milestone and the resync ladder below never engages. Run 30682097759: 11 of
 * 14 state-changing steps fired on elements the plan never recorded while all
 * three tasks reported success (discussion-reply 0/4 cursor agreement,
 * office-hours 1/5, survey 2/5). The driver was already ASKING NVDA where its
 * cursor was, but only after the fact, on the step record. Here the answer
 * decides.
 *
 * WHAT EACH VERDICT DOES. "contradicted" means the milestone is NOT satisfied:
 * the caller keeps searching exactly as if the speech had never matched, and if
 * every claimed match is contradicted the sweep exhausts and ReplayMilestoneError
 * fires — the honest outcome, and deliberately without a proceed-anyway fallback.
 * "agreed" and "abstained" both allow the match; abstention is what an oracle
 * says when it cannot see (NVDA collapses plain text to a bare role) and must
 * never block progress.
 *
 * COST. One instance per milestone-bearing step. The oracle is consulted ONLY
 * after milestoneMatches has already returned true, so a healthy step costs
 * exactly one consultation and a sweeping step costs one per FALSE POSITIVE it
 * walks over. Two extra bounds guard the pathological shapes: repeat claims from
 * an identical observation reuse the memoized verdict (the stale-currentItem
 * case, which is this gate's whole reason for existing, and would otherwise cost
 * one round trip per press), and MAX_CURSOR_VERIFICATIONS_PER_STEP caps the
 * distinct consultations.
 *
 * WHEN THE CAP IS HIT the gate stands down and allows subsequent matches rather
 * than rejecting them unverified — a gate with no evidence left must not be the
 * thing that fails a task. That is not a hole: on the NVDA driver every
 * state-changing command re-reads the cursor for its own step record
 * (nvdaHarness corroborateCursor), and a contradiction there still fails the
 * task in enforce mode. The bad outcome the cap risks is a task failing loudly
 * one layer down, never a wrong-element step passing silently.
 */
export function createMilestoneGate(
  harness: AtDriver,
  bindings: Bindings,
  onDebug: ReplayDebug = () => {}
): (milestone: string, observation: AtObservation) => Promise<boolean> {
  const memo = new Map<string, CursorVerdict>();
  let consultations = 0;
  return async (milestone, observation) => {
    if (!milestoneMatches(milestone, observation, bindings)) return false;
    // No hook = no gate. This is the ONLY thing that happens on the virtual
    // screen reader (agent/atHarness.ts AtHarness) and on real VoiceOver
    // (vo/voHarness.ts): both leave verifyCursor undefined, so the claimed match
    // is returned unchanged and their behaviour is bit-for-bit what it was.
    if (!harness.verifyCursor) return true;
    // NAMED for what it is, not for who observed it. This is the driver's
    // SPEECH-derived currentItem — the string that CLAIMED the match — and under
    // its old name ("observed"), printed beside the oracle's `verdict`, it read
    // as "what the oracle observed". It is not: on real NVDA the two routinely
    // disagree, which is the entire point of the gate. Run 30760469666 was
    // misdiagnosed from exactly that line (the item named Reply, the oracle had
    // answered "Like (0 likes), button"). The oracle's verbatim reply is in the
    // driver's own `cursor gate:` line for the same step.
    const speechItem = observation.currentItem;
    const key = JSON.stringify([milestone, speechItem]);
    const cached = memo.get(key);
    if (cached) {
      onDebug("milestone gate: reusing the verdict already spent on this exact observation", {
        milestone,
        speechItem: speechItem.slice(0, 120),
        verdict: cached,
        satisfied: cached !== "contradicted"
      });
      return cached !== "contradicted";
    }
    if (consultations >= MAX_CURSOR_VERIFICATIONS_PER_STEP) {
      onDebug("milestone gate: STOOD DOWN — consultation budget spent on this step, allowing the match unverified", {
        milestone,
        speechItem: speechItem.slice(0, 120),
        consultations,
        budget: MAX_CURSOR_VERIFICATIONS_PER_STEP,
        note: "the driver's own pre-command cursor check still records/fails a wrong-element step"
      });
      return true;
    }
    consultations++;
    let verdict: CursorVerdict;
    try {
      verdict = await harness.verifyCursor(milestone);
    } catch (e) {
      // A gate that cannot ask is a gate that cannot disagree. Never block.
      onDebug("milestone gate: verifyCursor THREW — allowing the match", {
        milestone,
        speechItem: speechItem.slice(0, 120),
        error: String(e)
      });
      return true;
    }
    memo.set(key, verdict);
    onDebug(`milestone gate: oracle ${verdict.toUpperCase()}`, {
      milestone,
      // The claim, not the oracle's answer — see the naming note above.
      speechItem: speechItem.slice(0, 120),
      verdict,
      consultations,
      satisfied: verdict !== "contradicted",
      note:
        verdict === "contradicted"
          ? "the speech matched but the driver's cursor is elsewhere — treating the milestone as UNMET and continuing " +
            "to search; `speechItem` above is the SPEECH that claimed the match, and what the oracle actually " +
            "answered is in the driver's own `cursor gate:` line for this step"
          : "milestone accepted"
    });
    return verdict !== "contradicted";
  };
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
    /**
     * Read-task salvage (real-AT only): when needles are unheard after the
     * plan, restart from the top and read forward up to this many items —
     * what a human SR user does when they haven't found something. Guards
     * against a single transiently-eaten press (e.g. "Heading not found"
     * while the accessibility tree lags the DOM) invalidating a milestone-
     * less read journey. 0 (default) = off; the virtual lane never sets it.
     */
    needleSweepLimit?: number;
    /**
     * Diagnostic sink for the milestone gate (createMilestoneGate): every gate
     * decision — consulted or not, and what the oracle said — goes here.
     * Absent (default) = silent, which is the virtual and VoiceOver lanes.
     */
    onDebug?: ReplayDebug;
  } = {}
): Promise<ReplayResult> {
  const resyncLimit = options.resyncLimit ?? DEFAULT_RESYNC_LIMIT;
  const pause = options.pause ?? (async () => {});
  const stepPauseMs = options.stepPauseMs ?? 0;
  const perCommandTimeoutMs = options.perCommandTimeoutMs ?? 0;
  const run = (command: AtCommand, arg?: string, context?: AtStepContext): Promise<AtObservation> => {
    if (perCommandTimeoutMs <= 0) return harness.run(command, arg, context);
    // type is per-character on real AT drivers — scale its budget with length.
    const budgetMs = perCommandTimeoutMs + (command === "type" ? (arg?.length ?? 0) * 1000 : 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`AT command "${command}" timed out after ${budgetMs}ms`)),
        budgetMs
      );
      harness.run(command, arg, context).then(
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
      // One gate per step, so its consultation budget and its memo of already-
      // judged observations are per step too. `satisfied` is milestoneMatches
      // plus, on a driver that offers AtDriver.verifyCursor, that driver's own
      // reading of where its cursor is; it is called at exactly the four places
      // milestoneMatches used to be called, and returns false in exactly the
      // same situations plus "the speech matched but the cursor disagrees".
      const satisfied = createMilestoneGate(harness, bindings, options.onDebug);
      const current = await run("observe");
      heardPhrases.push(...current.spokenSinceLastAction);
      await paced();
      if (!(await satisfied(step.milestone, current))) {
        let found = false;
        for (let press = 1; press <= resyncLimit; press++) {
          const obs = await run("next");
          heardPhrases.push(...obs.spokenSinceLastAction);
          await paced();
          if (await satisfied(step.milestone, obs)) {
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
            if (await satisfied(step.milestone, obs)) {
              resyncs.push({ stepIndex, presses: resyncLimit - press, milestone: step.milestone });
              found = true;
              break;
            }
          }
        }
        // Control sweep: hop by CONTROL instead of by line, before spending the
        // much blunter unstick (which throws the cursor back to the content top
        // and re-walks everything). Both sweeps above navigate with
        // `next`/`previous` — ArrowDown/ArrowUp on a real browse-mode driver —
        // which move by LINE and rest at the line START. A line that coalesces
        // several inline controls is therefore reachable and its controls are
        // not: in run 30760469666 NVDA spoke the discussion post's three icon
        // buttons as one line, "Like (0 likes), button, Edit, button, Reply",
        // every press rested on Like, and the milestone "reply" was claimed by
        // the speech (the line names Reply) and contradicted by the cursor
        // oracle every single time — 8/9 in enforce, and the ladder could not
        // reach the button no matter how many presses it was given. A
        // button-level hop reaches it in two.
        //
        // Forward first, then back, for the same reason the line-wise ladder
        // does both: the cursor can be on either side of the control, and after
        // the backward sweep above it is usually BEHIND it.
        if (!found && harness.moveToControl) {
          for (const direction of ["next", "previous"] as const) {
            const budget = direction === "next" ? CONTROL_SWEEP_LIMIT : CONTROL_SWEEP_LIMIT * 2;
            for (let hop = 1; hop <= budget; hop++) {
              await harness.moveToControl(direction);
              // The hop reports nothing (AtDriver.moveToControl); this is where
              // it is read, through the ordinary command path, so the same
              // `satisfied` gate judges it — speech AND the driver's own cursor.
              const obs = await run("observe");
              heardPhrases.push(...obs.spokenSinceLastAction);
              await paced();
              if (await satisfied(step.milestone, obs)) {
                const presses = CONTROL_RESYNC_OFFSET + hop;
                resyncs.push({
                  stepIndex,
                  presses: direction === "next" ? presses : -presses,
                  milestone: step.milestone
                });
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
        // Last resort: let the driver recover a trapped/displaced cursor
        // (real-AT only) and walk once more with a larger budget from
        // wherever recovery landed — typically the content top.
        if (!found && harness.unstick) {
          await harness.unstick();
          for (let press = 1; press <= resyncLimit * 3; press++) {
            const obs = await run("next");
            heardPhrases.push(...obs.spokenSinceLastAction);
            await paced();
            if (await satisfied(step.milestone, obs)) {
              resyncs.push({ stepIndex, presses: resyncLimit + press, milestone: step.milestone });
              found = true;
              break;
            }
          }
        }
        if (!found) {
          // Exhaustion is the RIGHT outcome when every claimed match was
          // contradicted (run 30682097759: 11 of 14 state-changing steps fired
          // on unrecorded elements and every task still reported success).
          // Failing here surfaces the drift; there is deliberately no
          // proceed-anyway fallback. The suffix tells the reader which of the
          // two exhaustions this was, since a gated one means the speech DID
          // match and the cursor did not.
          throw new ReplayMilestoneError(
            `step ${stepIndex} (${step.command}): milestone ${JSON.stringify(step.milestone)} not found ` +
              `within ${resyncLimit} presses forward or ${resyncLimit} back` +
              `${harness.moveToControl ? ` (nor ${CONTROL_SWEEP_LIMIT} control hops forward or ${CONTROL_SWEEP_LIMIT * 2} back)` : ""}` +
              `${harness.unstick ? ` (nor ${resyncLimit * 3} after unstick)` : ""} (cursor was on ` +
              `${JSON.stringify(current.currentItem)})` +
              `${harness.verifyCursor ? " — matches were also gated on the driver's own cursor read (see the milestone gate debug lines)" : ""}`
          );
        }
      }
    }
    // The step's own milestone rides along with the command (AtStepContext):
    // it is the only identifier of the item the step targets that does not come
    // from the driver's own speech, and a real-NVDA driver has nothing else to
    // aim a `type` at. Resync presses are NOT the step, so they carry nothing.
    const observation = await run(step.command, step.arg, { milestone: step.milestone });
    heardPhrases.push(...observation.spokenSinceLastAction, observation.currentItem);
    // Replay is ~1000× faster than the agent's natural pacing (LLM latency
    // between the agent's tool calls gave the app seconds to settle). Pause
    // briefly after state-changing commands so replay doesn't outrun the app's
    // async reactions (autosaves, realtime refetches, route transitions).
    if (STATE_CHANGING_COMMANDS.has(step.command)) await pause(Math.max(300, stepPauseMs));
    else await paced();
  }

  if (plan.taskKind === "read") {
    // normalizePhrase lowercases its output, so placeholder keys appear
    // lowercased in the heard log.
    const missingNeedles = () => {
      const heardNormalized = heardPhrases
        .map((p) => normalizePhrase(p, bindings))
        .filter((p): p is string => p !== null)
        .join("  ");
      return plan.readNeedleKeys.filter((key) => !heardNormalized.includes(`{{${key.toLowerCase()}}}`));
    };
    let missing = missingNeedles();
    const sweepLimit = options.needleSweepLimit ?? 0;
    if (missing.length > 0 && sweepLimit > 0) {
      // unstick, not restartFromTop: VO-Home is CONTAINER-scoped (observed
      // live: from inside the notifications region, "top" was the region top
      // and 79 sweep presses parked on its last item). unstick re-enters the
      // web area at the content start from anywhere.
      if (harness.unstick) await harness.unstick();
      else heardPhrases.push(...(await run("restartFromTop")).spokenSinceLastAction);
      for (let i = 0; i < sweepLimit; i++) {
        const obs = await run("next");
        heardPhrases.push(...obs.spokenSinceLastAction, obs.currentItem);
        await paced();
        missing = missingNeedles();
        if (missing.length === 0) break;
      }
    }
    if (missing.length > 0) {
      throw new ReplayNeedleError(
        `read-task ground truth never heard during replay${sweepLimit > 0 ? ` (nor in a ${sweepLimit}-item sweep)` : ""}: ${missing
          .map((key) => `${key}=${JSON.stringify(bindings[key] ?? "?")}`)
          .join(", ")}`
      );
    }
  }
  return { resyncs, heardPhrases };
}
