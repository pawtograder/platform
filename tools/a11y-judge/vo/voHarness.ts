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
  // Comma-separated role: VO's "label, role" form — any role token is safe to
  // strip after a comma.
  /,\s*(button|link|heading level \d|heading|text field|secure text field|edit text|search text field|text entry area|combo box|pop up button|menu button|radio button|radio|checkbox|tick box|menu item|tab|image|group|list|table|toolbar|banner|navigation|main|complementary|content information|article|region|web content|html content)$/i,
  // Space-separated role: itemText appends roles with a bare space ("Skip
  // links navigation", "… pace? radio") — strip ONLY tokens that don't
  // collide with real label endings (stripping "link"/"button" here ate the
  // literal "link" in "Sign in with magic link").
  /\s+(heading level \d|text field|secure text field|edit text|search text field|text entry area|combo box|pop up button|menu button|radio button|radio|checkbox|tick box|menu item|toolbar|banner|navigation|complementary|content information|region|web content|html content)$/i
];

/**
 * VO announces a control's label AND its matching placeholder/value, so a
 * textbox named "Reply..." with placeholder "Reply..." arrives as
 * "Reply... Reply... Reply... text entry area" (observed live). Collapse a
 * phrase that is one chunk repeated.
 */
const VO_REPEATED_CHUNK = /^(.{3,}?)([,\s]+\1)+$/i;

/**
 * Role words itemText appends with a bare space that CAN also end real labels
 * ("Sign in with magic link"), so they must never be stripped from the
 * primary item — they feed currentItemAlternates instead, and milestone
 * matching accepts either rendering ("New Request link" vs "new request" —
 * observed live in the rev-6 office-hours resync walk).
 */
const VO_AMBIGUOUS_ROLE_SUFFIX =
  /\s+(current page,?\s*)?(visited\s+)?(button|link|tab|image|list|table|group|heading|main|article|banner)$/i;

export function stripVoBoilerplate(phrase: string): string | null {
  if (VO_BOILERPLATE_PATTERNS.some((re) => re.test(phrase.trim()))) return null;
  let p = phrase.trim();
  let previous;
  do {
    previous = p;
    for (const re of VO_ITEM_SUFFIX_PATTERNS) p = p.replace(re, "").trim();
    p = p.replace(VO_REPEATED_CHUNK, "$1").trim();
  } while (p !== previous && p.length > 0);
  return p.length > 0 ? p : null;
}

export class VoCommandTimeoutError extends Error {}
export class VoUnsupportedCommandError extends Error {}

export interface VoHarnessOptions {
  noisePatterns?: RegExp[];
  commandTimeoutMs?: number;
  /**
   * Capture the FULL spoken output of every command. DANGEROUS on real pages:
   * guidepup's full-capture mode polls until VO's speech STABILIZES (25
   * consecutive identical 50ms samples), and a page that keeps announcing —
   * VO's own post-load read-through, our realtime-status live region — never
   * stabilizes, so every command hangs to its timeout (observed live on the
   * Mac runner: login died 4×30s in the first perform). Default is guidepup's
   * "initial" capture; item text still carries the milestone/needle content.
   * Opt in per-run with A11Y_VO_CAPTURE=full only to diagnose missed needles.
   */
  fullCapture?: boolean;
  /** Live diagnostics hooks (see debug.ts) — every command + stage marker. */
  onStep?: (record: AtStepRecord) => void;
  onDebug?: (stage: string, detail?: Record<string, unknown>) => void;
}

export class VoHarness implements AtDriver {
  readonly steps: AtStepRecord[] = [];
  private spokenLogCursor = 0;
  private voInstance: VoiceOver | null = null;
  private readonly noisePatterns: RegExp[];
  private readonly commandTimeoutMs: number;
  private readonly commandOptions: { capture: boolean | "initial" };
  private readonly onStep?: (record: AtStepRecord) => void;
  private readonly debug: (stage: string, detail?: Record<string, unknown>) => void;

  constructor(options: VoHarnessOptions = {}) {
    this.noisePatterns = options.noisePatterns ?? DEFAULT_NOISE_PATTERNS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOptions = { capture: options.fullCapture ? true : "initial" };
    this.onStep = options.onStep;
    this.debug = options.onDebug ?? (() => {});
  }

  private get vo(): VoiceOver {
    if (!this.voInstance) throw new Error("VoHarness not started — call start() first");
    return this.voInstance;
  }

  async start(): Promise<void> {
    const { voiceOver } = await import("@guidepup/guidepup");
    this.voInstance = voiceOver;
    this.debug("vo.start", { capture: this.commandOptions.capture });
    await this.vo.start(this.commandOptions);
    const log = await this.vo.spokenPhraseLog();
    this.spokenLogCursor = log.length;
    this.debug("vo.started", { initialPhrases: log.length });
  }

  async stop(): Promise<void> {
    await this.voInstance?.stop().catch(() => {});
  }

  /**
   * Move the VoiceOver cursor into the page's web area. Host-assisted
   * orientation — setup only, mirroring page.goto in the VSR path.
   *
   * Strategy (each stage logged): focus main content from the host side and
   * rely on VO's default cursor tracking to follow keyboard focus (no
   * keystroke — the old moveCursorToKeyboardFocus perform hung inside
   * guidepup's capture loop on chatty pages), falling back to the explicit
   * keystroke only when the cursor is visibly in browser chrome. The cursor
   * then typically rests ON a container ("scroll area" → "HTML content") —
   * observed live on the Mac runner: `next` bounces on "scroll area" forever
   * — and VoiceOver only descends via interact(), so interact through the
   * container layers and align to the content start (the same
   * focus → interact → jump-to-edge sequence as guidepup's own
   * navigateToWebContent helper).
   */
  async focusWebArea(focusViaHost: () => Promise<void>): Promise<void> {
    await focusViaHost();
    await new Promise((r) => setTimeout(r, 750)); // let cursor tracking follow
    let item = await this.itemTextSafe();
    this.debug("focusWebArea: after host focus", { item });
    if (item === "" || /address and search|toolbar|tab bar|bookmarks|window$/i.test(item)) {
      this.debug("focusWebArea: cursor looks like browser chrome — trying moveCursorToKeyboardFocus");
      await this.withTimeout(
        "focusWebArea",
        this.vo.perform(this.vo.keyboardCommands.moveCursorToKeyboardFocus, { capture: "initial" })
      ).catch((e) => this.debug("focusWebArea: moveCursorToKeyboardFocus failed", { error: String(e) }));
      item = await this.itemTextSafe();
      this.debug("focusWebArea: after keystroke", { item });
    }
    for (let depth = 1; depth <= 3; depth++) {
      if (!/^\s*(scroll area|html content|web content|group|empty group)\s*$/i.test(item)) break;
      await this.withTimeout(`focusWebArea:interact(${depth})`, this.vo.interact({ capture: "initial" })).catch((e) =>
        this.debug("focusWebArea: interact failed", { depth, error: String(e) })
      );
      item = await this.itemTextSafe();
      this.debug("focusWebArea: after interact", { depth, item });
    }
    // Align to the start of the (now-entered) content so the follow-up linear
    // scan / restartFromTop starts from a deterministic spot.
    await this.withTimeout(
      "focusWebArea:jumpToLeftEdge",
      this.vo.perform(this.vo.keyboardCommands.jumpToLeftEdge, { capture: "initial" })
    ).catch((e) => this.debug("focusWebArea: jumpToLeftEdge failed", { error: String(e) }));
    this.debug("focusWebArea: done", { item: await this.itemTextSafe() });
  }

  private async itemTextSafe(): Promise<string> {
    try {
      return await this.withTimeout("itemText", this.vo.itemText());
    } catch {
      return "";
    }
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
    const cleanedItem = stripVoBoilerplate(currentItem) ?? currentItem;
    const alternates = new Set<string>();
    const announced = stripVoBoilerplate(rawSpoken.at(-1) ?? "");
    if (announced) alternates.add(announced);
    let roleFree = cleanedItem;
    let previous;
    do {
      previous = roleFree;
      roleFree = roleFree.replace(VO_AMBIGUOUS_ROLE_SUFFIX, "").trim();
    } while (roleFree !== previous && roleFree.length > 0);
    if (roleFree) alternates.add(roleFree);
    alternates.delete(cleanedItem);
    alternates.delete("");
    const observation = buildObservation(
      rawSpoken.map((p) => stripVoBoilerplate(p)).filter((p): p is string => p !== null),
      cleanedItem,
      null,
      { noisePatterns: this.noisePatterns, error, currentItemAlternates: [...alternates] }
    );
    const record: AtStepRecord = {
      index: this.steps.length,
      command,
      ...(arg === undefined ? {} : { arg }),
      observation,
      rawSpoken,
      startedTimestamp,
      endedTimestamp: new Date().toISOString()
    };
    this.steps.push(record);
    this.onStep?.(record);
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
      // Bounded: spokenPhraseLog waits for the client's action queue, which
      // must never be allowed to wedge the runner without a timeout.
      const log = await this.withTimeout("spokenPhraseLog", this.vo.spokenPhraseLog());
      rawSpoken = log.slice(this.spokenLogCursor);
      this.spokenLogCursor = log.length;
      currentItem = await this.withTimeout("itemText", this.vo.itemText());
      // itemText is the current text LINE, so a wrapped label arrives
      // truncated ("Sign in with magic" for "Sign in with magic link" —
      // observed live). The spoken announcement carries the full accessible
      // name; substitute it when it extends the truncated line.
      const announced = stripVoBoilerplate(rawSpoken.at(-1) ?? "");
      if (
        announced &&
        currentItem &&
        announced.length > currentItem.trim().length &&
        announced.toLowerCase().startsWith(currentItem.trim().toLowerCase())
      ) {
        currentItem = announced;
      }
    } catch (e) {
      this.debug("collect: observation truncated", { error: String(e) });
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
