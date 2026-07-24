/**
 * VoHarness — real macOS VoiceOver implementation of the AtDriver command
 * surface (agent/atHarness.ts), backed by @guidepup/guidepup. Lets replayPlan
 * re-drive the promoted ReplayPlans through real AT in real Safari,
 * cross-validating the virtual-screen-reader results.
 *
 * Command mapping notes:
 *  - landmarks have no default VO keystroke; they resolve through VoiceOver
 *    Commander commands (enabled by `npx @guidepup/setup`);
 *  - `restartFromTop` = VO jumpToTopEdge (top of the web area);
 *  - `pressKey` is a plain system keystroke while VO runs — same semantics as
 *    the virtual harness's raw-focus channel;
 *  - `domFocus`/`checkableState` stay unset: replayPlan never reads them, and
 *    real VoiceOver announces true control state anyway (they exist to patch
 *    virtual-SR limitations).
 *
 * Spoken phrases and the current item are passed through a VO-specific
 * pre-normalizer (stripVoBoilerplate) BEFORE the shared normalize.ts matching,
 * because milestone templates were recorded from virtual-SR phrasing. The
 * pattern lists below are the calibration knob for VSR→real-VO drift — tune
 * them with `a11y:vo --calibrate` (raw phrases stay in the step records).
 */
// Type-only: @guidepup/guidepup resolves its platform implementation at
// import time and THROWS off-macOS, so the value import happens lazily in
// start(). Keeps this module (and everything importing it, e.g. run.ts
// --list) loadable on Linux.
import type { VoiceOver } from "@guidepup/guidepup";
import {
  buildObservation,
  DEFAULT_NOISE_PATTERNS,
  READ_NEXT_MAX,
  type AtCommand,
  type AtDriver,
  type AtObservation,
  type AtStepRecord
} from "../agent/atHarness";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * VoiceOver announcements that carry no content: orientation hints, window
 * summaries, interaction chrome. Dropped from observations (kept in raw logs).
 */
export const VO_BOILERPLATE_PATTERNS: RegExp[] = [
  /^you are currently on/i,
  /^to enter the web area/i,
  /^to exit the web area/i,
  /^to click .* press/i,
  /^press .* to select/i,
  /^interact(ing)? with/i,
  /^stop(ped)? interacting with/i,
  /^entering /i,
  /^leaving /i,
  /^loading webpage/i,
  /^webpage loaded/i,
  /^safari busy/i,
  /^new tab/i,
  /^address and search field/i
];

/**
 * Trailing role/state/position descriptors VoiceOver appends to an item's
 * spoken text ("Complete, button", "Just right, selected, radio button,
 * 2 of 3") that the virtual SR's item text does not carry. Stripped
 * iteratively from the end until stable.
 */
export const VO_ITEM_SUFFIX_PATTERNS: RegExp[] = [
  /,?\s*\d+ of \d+$/i,
  /,?\s*(selected|unselected|checked|not checked|unchecked|dimmed|expanded|collapsed|visited)$/i,
  /,?\s*(button|link|heading level \d|heading|text field|secure text field|edit text|search text field|combo box|pop up button|menu button|radio button|checkbox|tick box|menu item|tab|image|group|list|table|toolbar|banner|navigation|main|complementary|content information|article|region|web content|html content)$/i
];

export function stripVoBoilerplate(phrase: string): string | null {
  if (VO_BOILERPLATE_PATTERNS.some((re) => re.test(phrase.trim()))) return null;
  let p = phrase.trim();
  let previous;
  do {
    previous = p;
    for (const re of VO_ITEM_SUFFIX_PATTERNS) p = p.replace(re, "").trim();
  } while (p !== previous && p.length > 0);
  return p.length > 0 ? p : null;
}

export class VoCommandTimeoutError extends Error {}
export class VoUnsupportedCommandError extends Error {}

export interface VoHarnessOptions {
  noisePatterns?: RegExp[];
  commandTimeoutMs?: number;
  /**
   * Capture the FULL spoken output of every command (guidepup default only
   * captures the initial page of speech). Needle assertions depend on hearing
   * everything, so this defaults to true; disable if calibration shows the
   * runs are unbearably slow and the phrases are short.
   */
  fullCapture?: boolean;
}

export class VoHarness implements AtDriver {
  readonly steps: AtStepRecord[] = [];
  private spokenLogCursor = 0;
  private voInstance: VoiceOver | null = null;
  private readonly noisePatterns: RegExp[];
  private readonly commandTimeoutMs: number;
  private readonly commandOptions: { capture: boolean };

  constructor(options: VoHarnessOptions = {}) {
    this.noisePatterns = options.noisePatterns ?? DEFAULT_NOISE_PATTERNS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOptions = { capture: options.fullCapture ?? true };
  }

  private get vo(): VoiceOver {
    if (!this.voInstance) throw new Error("VoHarness not started — call start() first");
    return this.voInstance;
  }

  async start(): Promise<void> {
    const { voiceOver } = await import("@guidepup/guidepup");
    this.voInstance = voiceOver;
    await this.vo.start(this.commandOptions);
    const log = await this.vo.spokenPhraseLog();
    this.spokenLogCursor = log.length;
  }

  async stop(): Promise<void> {
    await this.voInstance?.stop().catch(() => {});
  }

  /**
   * Move the VoiceOver cursor into the page's web area. Host-assisted
   * orientation (keyboard focus into main content, then VO cursor to
   * keyboard focus) — setup only, mirroring page.goto in the VSR path.
   */
  async focusWebArea(focusViaHost: () => Promise<void>): Promise<void> {
    await focusViaHost();
    await this.withTimeout("focusWebArea", this.vo.perform(this.vo.keyboardCommands.moveCursorToKeyboardFocus));
  }

  async run(command: AtCommand, arg?: string): Promise<AtObservation> {
    const startedTimestamp = new Date().toISOString();
    let error: string | undefined;
    try {
      await this.withTimeout(command, this.execute(command, arg));
    } catch (e) {
      if (e instanceof VoCommandTimeoutError || e instanceof VoUnsupportedCommandError) throw e;
      error = e instanceof Error ? e.message : String(e);
    }
    const { rawSpoken, currentItem } = await this.collect();
    const observation = buildObservation(
      rawSpoken.map((p) => stripVoBoilerplate(p)).filter((p): p is string => p !== null),
      stripVoBoilerplate(currentItem) ?? currentItem,
      null,
      { noisePatterns: this.noisePatterns, error }
    );
    this.steps.push({
      index: this.steps.length,
      command,
      ...(arg === undefined ? {} : { arg }),
      observation,
      rawSpoken,
      startedTimestamp,
      endedTimestamp: new Date().toISOString()
    });
    return observation;
  }

  private async execute(command: AtCommand, arg?: string): Promise<void> {
    const vo = this.vo;
    const opts = this.commandOptions;
    switch (command) {
      case "observe":
        return;
      case "next":
        return vo.next(opts);
      case "previous":
        return vo.previous(opts);
      case "act":
        return vo.act(opts);
      case "interact":
        return vo.interact(opts);
      case "stopInteracting":
        return vo.stopInteracting(opts);
      case "press":
        return vo.press(arg ?? "Enter");
      case "pressKey":
        return vo.press(arg ?? "Tab");
      case "type":
        return vo.type(arg ?? "");
      case "readNext": {
        const n = Math.min(Math.max(parseInt(arg ?? "10", 10) || 10, 1), READ_NEXT_MAX);
        for (let i = 0; i < n; i++) await vo.next(opts);
        return;
      }
      case "restartFromTop":
        return vo.perform(vo.keyboardCommands.jumpToTopEdge, opts);
      case "moveToNextHeading":
        return vo.perform(vo.keyboardCommands.findNextHeading, opts);
      case "moveToPreviousHeading":
        return vo.perform(vo.keyboardCommands.findPreviousHeading, opts);
      case "moveToNextLink":
        return vo.perform(vo.keyboardCommands.findNextLink, opts);
      case "moveToPreviousLink":
        return vo.perform(vo.keyboardCommands.findPreviousLink, opts);
      case "moveToNextForm":
        return vo.perform(vo.keyboardCommands.findNextControl, opts);
      case "moveToNextLandmark":
        return vo.perform(vo.commanderCommands.FIND_NEXT_LANDMARK, opts);
      case "moveToPreviousLandmark":
        return vo.perform(vo.commanderCommands.FIND_PREVIOUS_LANDMARK, opts);
      case "moveToNextMain":
        // VO has no "next main" primitive; landmark-hop is the honest
        // equivalent (main is a landmark). Plans currently never use this.
        return vo.perform(vo.commanderCommands.FIND_NEXT_LANDMARK, opts);
      default: {
        const exhaustive: never = command;
        throw new VoUnsupportedCommandError(`unsupported AT command for real VoiceOver: ${String(exhaustive)}`);
      }
    }
  }

  private async collect(): Promise<{ rawSpoken: string[]; currentItem: string }> {
    let rawSpoken: string[] = [];
    let currentItem = "";
    try {
      const log = await this.vo.spokenPhraseLog();
      rawSpoken = log.slice(this.spokenLogCursor);
      this.spokenLogCursor = log.length;
      currentItem = await this.vo.itemText();
    } catch {
      /* observation collection is best-effort; the command outcome stands */
    }
    return { rawSpoken, currentItem };
  }

  private withTimeout<T>(command: string, promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new VoCommandTimeoutError(
              `VoiceOver command "${command}" hung for ${this.commandTimeoutMs}ms (dropped AppleScript event?)`
            )
          ),
        this.commandTimeoutMs
      );
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }
}
