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

/**
 * Items that mean the VO cursor has ESCAPED the page's web content into
 * Safari chrome or a bare container — observed live: an app rerender after
 * act() yanked the cursor to "Favorites bar group"/"scroll area", where no
 * amount of next/previous can reach an in-page milestone. Kept to
 * unambiguous chrome only (in-page toolbars/groups are legitimate content).
 */
const VO_CURSOR_ESCAPED =
  /^(scroll area|window|favorites bar.*|bookmarks bar.*|tab bar.*|address and search.*|sidebar|reload page)$/i;
const MAX_ESCAPE_RECOVERIES = 8;

/**
 * Consecutive identical items on move commands = the cursor MAY be trapped
 * inside an interaction level (observed live: 45 straight next/previous on
 * "Any other feedback?" — real VO descends TWO levels into a textarea, and
 * the VSR-recorded plan's single stopInteracting exits one). Geofenced to
 * text-entry contexts (raw item carries the indicator): a cursor parked on a
 * page/dialog BOUNDARY also repeats items, and popping there rips VoiceOver
 * out of context the plan needs (rev-11 regression: pops on "close button" /
 * the notifications region broke two previously-green tasks).
 */
const TRAPPED_MOVE_LIMIT = 4;
const MAX_TRAP_POPS = 3;
const VO_TEXT_ENTRY_CONTEXT = /(text entry area|edit text|selectable text|text field)/i;

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
  /**
   * Host-channel JS evaluator (SafariHost.evalJs). Used ONLY for internal
   * harness reliability — verifying that typed text actually landed in the
   * focused field (document.activeElement.value), never for content
   * assertions. VO item text is NOT a reliable value mirror (rev-11: false
   * negatives on SurveyJS fields triggered destructive retries).
   */
  hostEval?: (js: string) => Promise<string>;
  /** Clipboard writer (SafariHost.setClipboard) for the paste-based type retry. */
  hostSetClipboard?: (text: string) => Promise<void>;
}

export class VoHarness implements AtDriver {
  readonly steps: AtStepRecord[] = [];
  private spokenLogCursor = 0;
  private itemTextLogCursor = 0;
  private voInstance: VoiceOver | null = null;
  private hostFocus: (() => Promise<void>) | null = null;
  private escapeRecoveries = 0;
  private lastMoveItem = "";
  private trappedMoves = 0;
  private trapPops = 0;
  private readonly noisePatterns: RegExp[];
  private readonly commandTimeoutMs: number;
  private readonly commandOptions: { capture: boolean | "initial" };
  private readonly onStep?: (record: AtStepRecord) => void;
  private readonly debug: (stage: string, detail?: Record<string, unknown>) => void;
  private readonly hostEval?: (js: string) => Promise<string>;
  private readonly hostSetClipboard?: (text: string) => Promise<void>;

  constructor(options: VoHarnessOptions = {}) {
    this.noisePatterns = options.noisePatterns ?? DEFAULT_NOISE_PATTERNS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOptions = { capture: options.fullCapture ? true : "initial" };
    this.onStep = options.onStep;
    this.debug = options.onDebug ?? (() => {});
    this.hostEval = options.hostEval;
    this.hostSetClipboard = options.hostSetClipboard;
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
    this.itemTextLogCursor = (await this.vo.itemTextLog()).length;
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
    this.hostFocus = focusViaHost;
    this.escapeRecoveries = 0;
    this.trapPops = 0;
    this.trappedMoves = 0;
    this.lastMoveItem = "";
    await this.enterWebArea();
  }

  private async enterWebArea(): Promise<void> {
    if (!this.hostFocus) return;
    await this.hostFocus();
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
      // The web-area element's accessible name is the PAGE TITLE, so the
      // container item arrives title-prefixed ("Surveys · … web content" —
      // observed live: 75 no-op next presses on it after an unstick). Match
      // bare containers exactly, and web/HTML content by suffix.
      if (!/^\s*(scroll area|group|empty group)\s*$|(html|web) content\s*$/i.test(item)) break;
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

  /**
   * Last-resort recovery for replayPlan (AtDriver.unstick): pop up to two
   * interaction levels (real VO descends deeper into textareas than the
   * VSR-recorded plans account for), then re-enter the web area from the
   * top. Called only when a milestone resync exhausts both directions.
   */
  async unstick(): Promise<void> {
    this.debug("unstick: popping interaction levels and re-entering web area");
    for (let i = 0; i < 2; i++) {
      await this.withTimeout("unstick:stopInteracting", this.vo.stopInteracting({ capture: "initial" })).catch(
        () => {}
      );
    }
    await this.enterWebArea();
    this.debug("unstick: done", { item: await this.itemTextSafe() });
  }

  /**
   * VO's interact() moves only the VO CURSOR; keyboard focus stays behind, so
   * a plain type() sends keystrokes into the void (observed live: the
   * office-hours textarea still announced its placeholder + "required invalid
   * data" after 40+ typed characters). Route keyboard focus to the cursor
   * (VO+Cmd+F5) before any focused-element input.
   */
  private async ensureKeyboardFocusAtCursor(): Promise<void> {
    await this.withTimeout(
      "moveKeyboardFocusToCursor",
      this.vo.perform(this.vo.keyboardCommands.moveKeyboardFocusToCursor, { capture: "initial" })
    ).catch((e) => this.debug("ensureKeyboardFocusAtCursor failed", { error: String(e) }));
  }

  /**
   * Host-assisted focus of the text field whose accessible label matches the
   * VO cursor's item — setup assist only (like focusWebArea), typing itself
   * stays on the keyboard channel.
   */
  private async hostFocusField(label: string): Promise<void> {
    if (!this.hostEval || !label) return;
    const result = await this.hostEval(
      `(() => {
        const label = ${JSON.stringify(label.toLowerCase())};
        const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, [contenteditable="true"]')];
        const nameOf = (el) => {
          const bits = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.labels && [...el.labels].map((l) => l.textContent).join(' ')];
          const labelled = el.getAttribute('aria-labelledby');
          if (labelled) bits.push(labelled.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
          return bits.filter(Boolean).join(' ').toLowerCase();
        };
        const match = fields.find((el) => nameOf(el).includes(label)) || fields.find((el) => label.includes(nameOf(el)) && nameOf(el).length > 2);
        if (!match) return 'no-match among ' + fields.length + ' fields';
        match.focus();
        return 'focused ' + match.tagName + '[' + (match.getAttribute('aria-label') || '') + ']';
      })()`
    ).catch((e) => `error:${e}`);
    this.debug("hostFocusField", { label, result: String(result).slice(0, 100) });
  }

  /** Degraded-fidelity value entry: native setter + synthetic events. */
  private async hostSetValue(text: string): Promise<void> {
    if (!this.hostEval) return;
    const result = await this.hostEval(
      `(() => {
        const el = document.activeElement;
        if (!el) return 'no-active';
        if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
        else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (!desc || !desc.set) return 'no-setter for ' + el.tagName;
          desc.set.call(el, ${JSON.stringify(text)});
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set on ' + el.tagName;
      })()`
    ).catch((e) => `error:${e}`);
    this.debug("hostSetValue", { result: String(result).slice(0, 80) });
  }

  /** One-line focused-element descriptor for type-failure diagnostics. */
  private async describeActiveElement(): Promise<string> {
    if (!this.hostEval) return "?";
    return this.hostEval(
      `(() => {
        const el = document.activeElement;
        if (!el) return 'none';
        const v = el.value !== undefined ? el.value : (el.textContent || '');
        return el.tagName + (el.id ? '#' + el.id : '') + '[' + (el.getAttribute('aria-label') || '') + '] value=' + String(v).slice(0, 60);
      })()`
    ).catch((e) => `error:${e}`);
  }

  private async typedTextLanded(text: string): Promise<boolean> {
    if (!this.hostEval) return true;
    const needle = text.slice(0, 20);
    const js = `(() => {
      const el = document.activeElement;
      if (!el) return 'no-active';
      const v = el.value !== undefined ? el.value : (el.textContent || '');
      return String(String(v).includes(${JSON.stringify(needle)}));
    })()`;
    const result = await this.hostEval(js).catch((e) => `error:${e}`);
    if (result !== "true" && result !== "false") {
      this.debug("typedTextLanded: host check inconclusive — assuming landed", { result: String(result).slice(0, 80) });
      return true;
    }
    return result === "true";
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
      // type is per-character (keystroke + capture poll each), so its budget
      // must scale with text length — a 68-char plan arg blew the flat 30s.
      const budget = command === "type" ? this.commandTimeoutMs + (arg?.length ?? 0) * 1000 : this.commandTimeoutMs;
      await this.withTimeout(command, this.execute(command, arg), budget);
    } catch (e) {
      if (e instanceof VoCommandTimeoutError || e instanceof VoUnsupportedCommandError) throw e;
      error = e instanceof Error ? e.message : String(e);
    }
    let { rawSpoken, currentItem } = await this.collect();
    // Self-heal a cursor escape: re-enter the web area and observe again.
    // Bounded per focusWebArea() so a genuinely broken page still fails.
    if (VO_CURSOR_ESCAPED.test(currentItem.trim()) && this.hostFocus && this.escapeRecoveries < MAX_ESCAPE_RECOVERIES) {
      this.escapeRecoveries++;
      this.debug("cursor escaped web content — recovering", {
        command,
        item: currentItem,
        recovery: this.escapeRecoveries
      });
      await this.enterWebArea();
      const recovered = await this.collect();
      rawSpoken = [...rawSpoken, ...recovered.rawSpoken];
      currentItem = recovered.currentItem;
    }
    // Trap detection: move commands that don't move INSIDE a text-entry
    // context mean the cursor is stuck in an interaction level — pop out one
    // level, like a VO user would. (Boundary bounce elsewhere is normal.)
    if (command === "next" || command === "previous") {
      this.trappedMoves = currentItem === this.lastMoveItem ? this.trappedMoves + 1 : 0;
      this.lastMoveItem = currentItem;
      if (
        this.trappedMoves >= TRAPPED_MOVE_LIMIT &&
        this.trapPops < MAX_TRAP_POPS &&
        VO_TEXT_ENTRY_CONTEXT.test([currentItem, ...rawSpoken.slice(-2)].join(" "))
      ) {
        this.trapPops++;
        this.trappedMoves = 0;
        this.debug("cursor trapped in interaction level — popping out", {
          item: currentItem,
          pop: this.trapPops
        });
        await this.withTimeout("trapPop:stopInteracting", this.vo.stopInteracting({ capture: "initial" })).catch((e) =>
          this.debug("trapPop failed", { error: String(e) })
        );
        const popped = await this.collect();
        rawSpoken = [...rawSpoken, ...popped.rawSpoken];
        currentItem = popped.currentItem;
      }
    }
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
        await this.ensureKeyboardFocusAtCursor();
        return vo.press(arg ?? "Enter");
      case "pressKey":
        return vo.press(arg ?? "Tab");
      case "type": {
        await this.ensureKeyboardFocusAtCursor();
        await vo.type(arg ?? "");
        // Typing is the flakiest real-VO path: even with focus routed, the
        // text sometimes doesn't land (observed live: survey's required q1
        // announced "Response required … invalid data" at submit). Verify
        // through the HOST channel — document.activeElement.value is certain,
        // unlike VO item text (rev-11: its false negatives caused destructive
        // retries) — and retry once: act() focuses the field under the
        // cursor, Cmd+A makes the retype REPLACE instead of append.
        if (arg && arg.length >= 3 && this.hostEval) {
          if (!(await this.typedTextLanded(arg))) {
            // Focus routing to text inputs is unreliable on this widget set:
            // the soak showed document.activeElement resting on a BUTTON when
            // type fired, and vo.act() landing focus on a button too. Retry
            // with HOST-ASSISTED focus — find the input whose label matches
            // the VO cursor's item and .focus() it (same host-assist policy
            // as focusWebArea) — then select-all + atomic paste so an
            // autosave rerender can't interrupt mid-stream. The typing
            // channel stays keyboard; only the focus assist is host-side.
            const label = stripVoBoilerplate(await this.itemTextSafe()) ?? "";
            this.debug("type: text not in focused field — host-assisted field focus + retype", {
              label,
              activeElement: await this.describeActiveElement()
            });
            await this.hostFocusField(label);
            await new Promise((r) => setTimeout(r, 300));
            await vo.press("Command+a");
            // The field is now genuinely focused (host-verified targeting),
            // so plain keystrokes should land; paste is the LAST resort
            // (observed live: an immediate clipboard+Cmd+V after set landed
            // empty — give the pasteboard time to settle if we need it).
            await vo.type(arg);
            if (!(await this.typedTextLanded(arg)) && this.hostSetClipboard) {
              this.debug("type: retype missed too — atomic paste fallback");
              await this.hostFocusField(label);
              await vo.press("Command+a");
              await this.hostSetClipboard(arg);
              await new Promise((r) => setTimeout(r, 500));
              await vo.press("Command+v");
            }
            if (!(await this.typedTextLanded(arg))) {
              // DEGRADED-FIDELITY last resort: this widget eats keyboard
              // events even into a host-verified-focused input (observed
              // live: retype AND paste left value="" — an app finding in its
              // own right, logged every time). Set the value host-side with
              // the native setter + synthetic input/change events so the
              // task can still exercise the rest of the journey.
              this.debug("type: HOST VALUE FALLBACK — keyboard input failed twice (degraded fidelity)");
              await this.hostSetValue(arg);
            }
            this.debug("type: after retry", {
              landed: await this.typedTextLanded(arg),
              activeElement: await this.describeActiveElement()
            });
          }
        }
        return;
      }
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
      // Merge the per-action ITEM texts too: a multi-hop readNext lands here
      // as one command, and "initial" capture can clip long row announcements
      // — the item text log carries each hop's full line, so needles aren't
      // at the mercy of speech-capture timing.
      const itemLog = await this.withTimeout("itemTextLog", this.vo.itemTextLog());
      for (const hopItem of itemLog.slice(this.itemTextLogCursor)) {
        if (hopItem && !rawSpoken.includes(hopItem)) rawSpoken.push(hopItem);
      }
      this.itemTextLogCursor = itemLog.length;
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

  private withTimeout<T>(command: string, promise: Promise<T>, budgetMs = this.commandTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new VoCommandTimeoutError(
              `VoiceOver command "${command}" hung for ${budgetMs}ms (dropped AppleScript event?)`
            )
          ),
        budgetMs
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
