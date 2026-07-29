/**
 * NvdaHarness — real Windows NVDA implementation of the AtDriver command
 * surface (agent/atHarness.ts), backed by @guidepup/guidepup. The Windows/NVDA
 * counterpart of vo/voHarness.ts; lets replayPlan re-drive the promoted
 * ReplayPlans through real NVDA + real Chromium, cross-validating the
 * virtual-screen-reader (and VoiceOver) results.
 *
 * NVDA vs VoiceOver differences that shape this port:
 *  - NVDA has browse mode vs focus mode instead of VO's nested interaction
 *    levels: `interact` toggles into focus mode, `stopInteracting` = exitFocusMode.
 *  - Structural navigation uses NVDA's native single-letter quick-nav
 *    (moveToNextHeading, moveToNextLink, moveToNextFormField, moveToNextLandmark)
 *    — no Commander/`@guidepup/setup` step is needed (VO's landmark gap).
 *  - NVDA announces the ROLE as a PREFIX ("heading, level 1, Title";
 *    "link, next link") rather than VO's trailing suffix, so stripNvdaBoilerplate
 *    strips leading role tokens. These pattern lists are the calibration knob
 *    for VSR→real-NVDA phrasing drift — tune with `a11y:nvda --calibrate`.
 *  - Foregrounding: under a CI job the runner console holds the OS foreground,
 *    so SetForegroundWindow is blocked; the browser is brought to NVDA's focus
 *    via NVDA-driven Alt+Esc app-switching (verified via reportTitle), and a
 *    transient PickerHost "Windows Security" dialog is dismissed. (See
 *    ops/ripley-cluster.md → Windows screen-reader runner.)
 */
// Type-only: @guidepup/guidepup resolves its platform implementation at import
// time and THROWS off-Windows, so the value import happens lazily in start().
import type { WindowsKeyCodes as WinKeys, WindowsModifiers as WinMods } from "@guidepup/guidepup";
import { execFile } from "node:child_process";
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

type Nvda = (typeof import("@guidepup/guidepup"))["nvda"];

/** NVDA announcements that carry no content: mode changes, load chrome. */
export const NVDA_BOILERPLATE_PATTERNS: RegExp[] = [
  /^browse mode$/i,
  /^focus mode$/i,
  /^loading/i,
  /^document$/i,
  /^web content$/i,
  /^busy/i,
  /^blank$/i
];

/**
 * Leading role/state tokens NVDA prefixes onto an item ("heading, level 1, X";
 * "link, X"; "button, X"; "check box, not checked, X"). Stripped iteratively
 * from the START until stable; the label (which may itself end in "link" etc.)
 * is preserved.
 */
export const NVDA_ITEM_PREFIX_PATTERNS: RegExp[] = [
  /^heading,?\s*(level \d+,?\s*)?/i,
  /^(link|visited link|same page link),?\s*/i,
  /^button,?\s*/i,
  /^(graphic|image),?\s*/i,
  /^clickable,?\s*/i,
  /^(list|list box)(\s*with \d+ items)?,?\s*/i,
  /^(check box|checkbox),?\s*(checked|not checked|half checked),?\s*/i,
  /^radio button,?\s*(\d+ of \d+,?\s*)?/i,
  /^(edit|edit box),?\s*(multiline,?\s*)?(has auto complete,?\s*)?/i,
  /^combo box,?\s*/i,
  /^menu item,?\s*/i,
  /^tab,?\s*(\d+ of \d+,?\s*)?/i,
  /^(banner|navigation|main|complementary|content info|region|article|form),?\s*landmark,?\s*/i
];

/** Trailing state/position descriptors NVDA appends. */
export const NVDA_ITEM_SUFFIX_PATTERNS: RegExp[] = [
  /,?\s*\d+ of \d+$/i,
  /,?\s*(selected|not selected|expanded|collapsed|checked|not checked|current page|visited|clickable|pressed|not pressed)$/i,
  /,?\s*(button|link|heading|graphic|image|edit|combo box|check box|radio button|menu item|tab)$/i
];

/** VO's "Reply… Reply… Reply… text entry area" style — one chunk repeated. */
const NVDA_REPEATED_CHUNK = /^(.{3,}?)([,\s]+\1)+$/i;

/**
 * Role words that can also legitimately END a label ("Sign in with magic
 * link") — never stripped from the primary item; they feed currentItemAlternates
 * so milestone matching accepts either rendering.
 */
const NVDA_AMBIGUOUS_ROLE_SUFFIX = /\s+(button|link|tab|image|list|table|group|heading|main|article|banner)$/i;

/** Items meaning NVDA has left the page's web content for browser chrome. */
const NVDA_CURSOR_ESCAPED =
  /^(address and search bar|.* address and search|new tab|reload|.*- google chrome.*|toolbar|tab strip|bookmarks)$/i;
const MAX_ESCAPE_RECOVERIES = 8;

/** A modal credential dialog (title "Windows Security") that can seize the
 *  foreground on the CI desktop; NVDA then reads only it. */
const NVDA_SECURITY_DIALOG = /(windows security|credential|smart card|pick an account)/i;

const TRAPPED_MOVE_LIMIT = 4;
const MAX_TRAP_POPS = 3;
const NVDA_TEXT_ENTRY_CONTEXT = /(edit|multiline|text area|text field|combo box)/i;

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function stripNvdaBoilerplate(phrase: string): string | null {
  if (NVDA_BOILERPLATE_PATTERNS.some((re) => re.test(phrase.trim()))) return null;
  let p = phrase.trim();
  let previous;
  do {
    previous = p;
    for (const re of NVDA_ITEM_PREFIX_PATTERNS) p = p.replace(re, "").trim();
    for (const re of NVDA_ITEM_SUFFIX_PATTERNS) p = p.replace(re, "").trim();
    p = p.replace(NVDA_REPEATED_CHUNK, "$1").trim();
  } while (p !== previous && p.length > 0);
  return p.length > 0 ? p : null;
}

/** Kill the transient PickerHost/credential-broker dialogs (fire and forget). */
function dismissSecurityDialog(): void {
  for (const im of ["PickerHost.exe", "CredentialUIBroker.exe", "consent.exe"]) {
    execFile("taskkill", ["/im", im, "/f"], () => {});
  }
}

export class NvdaCommandTimeoutError extends Error {}
export class NvdaUnsupportedCommandError extends Error {}

export interface NvdaHarnessOptions {
  noisePatterns?: RegExp[];
  commandTimeoutMs?: number;
  fullCapture?: boolean;
  onStep?: (record: AtStepRecord) => void;
  onDebug?: (stage: string, detail?: Record<string, unknown>) => void;
  /** Host-channel JS evaluator (ChromeHost.evalJs) — internal reliability only
   *  (verify typed text landed via document.activeElement.value), never for
   *  content assertions. */
  hostEval?: (js: string) => Promise<string>;
  /** Clipboard writer (ChromeHost.setClipboard) for the paste-based type retry. */
  hostSetClipboard?: (text: string) => Promise<void>;
  /** Page title of the current task — used to confirm the browser has focus. */
  pageTitle?: () => Promise<string>;
}

export class NvdaHarness implements AtDriver {
  readonly steps: AtStepRecord[] = [];
  private spokenLogCursor = 0;
  private itemTextLogCursor = 0;
  private nvdaInstance: Nvda | null = null;
  private keys: typeof WinKeys | null = null;
  private mods: typeof WinMods | null = null;
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
  private readonly pageTitle?: () => Promise<string>;

  constructor(options: NvdaHarnessOptions = {}) {
    this.noisePatterns = options.noisePatterns ?? DEFAULT_NOISE_PATTERNS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.commandOptions = { capture: options.fullCapture ? true : "initial" };
    this.onStep = options.onStep;
    this.debug = options.onDebug ?? (() => {});
    this.hostEval = options.hostEval;
    this.hostSetClipboard = options.hostSetClipboard;
    this.pageTitle = options.pageTitle;
  }

  private get nvda(): Nvda {
    if (!this.nvdaInstance) throw new Error("NvdaHarness not started — call start() first");
    return this.nvdaInstance;
  }

  async start(): Promise<void> {
    const guidepup = await import("@guidepup/guidepup");
    this.nvdaInstance = guidepup.nvda;
    this.keys = guidepup.WindowsKeyCodes;
    this.mods = guidepup.WindowsModifiers;
    this.debug("nvda.start", { capture: this.commandOptions.capture });
    await this.nvda.start(this.commandOptions);
    const log = await this.nvda.spokenPhraseLog();
    this.spokenLogCursor = log.length;
    this.itemTextLogCursor = (await this.nvda.itemTextLog()).length;
    this.debug("nvda.started", { initialPhrases: log.length });
  }

  async stop(): Promise<void> {
    await this.nvdaInstance?.stop().catch(() => {});
  }

  /**
   * Bring NVDA's reading into the page's web content — setup only, the NVDA
   * analogue of vo/voHarness.focusWebArea (which mirrors page.goto in the VSR
   * path). Foreground the browser via Alt+Esc (foreground-lock-safe), host-focus
   * #main-content, force browse mode, and move to the top of the document.
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
    dismissSecurityDialog();
    const focused = await this.focusBrowserWindow();
    this.debug("focusWebArea: browser focused", { focused });
    if (this.hostFocus) await this.hostFocus();
    await new Promise((r) => setTimeout(r, 500));
    // Force browse mode, then align the review to the top of the document so a
    // follow-up linear scan / restartFromTop starts from a deterministic spot.
    await this.withTimeout(
      "focusWebArea:exitFocusMode",
      this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
    ).catch(() => {});
    await this.withTimeout("focusWebArea:top", this.nvda.press("Control+Home")).catch(() => {});
    this.debug("focusWebArea: done", { item: await this.itemTextSafe() });
  }

  /** Cycle windows via Alt+Esc until NVDA reports the Chromium window focused. */
  private async focusBrowserWindow(): Promise<boolean> {
    const want = clean((await this.pageTitle?.().catch(() => "")) ?? "");
    const SWITCH = { keyCode: [this.keys!.Escape], modifiers: [this.mods!.Alt] };
    for (let i = 0; i < 12; i++) {
      await this.withTimeout("reportTitle", this.nvda.perform(this.nvda.keyboardCommands.reportTitle)).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const title = clean(await this.lastSpokenSafe());
      if (title.includes("chrom") || (want.length > 2 && title.startsWith(want))) return true;
      if (NVDA_SECURITY_DIALOG.test(title)) {
        dismissSecurityDialog();
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      await this.withTimeout("altEsc", this.nvda.perform(SWITCH, { capture: false })).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  /**
   * Last-resort recovery for replayPlan (AtDriver.unstick): exit focus mode and
   * re-enter the web area from the top. Called only when a milestone resync
   * exhausts both directions.
   */
  async unstick(): Promise<void> {
    this.debug("unstick: exiting focus mode and re-entering web area");
    await this.withTimeout(
      "unstick:exitFocusMode",
      this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
    ).catch(() => {});
    await this.enterWebArea();
    this.debug("unstick: done", { item: await this.itemTextSafe() });
  }

  /** Host-assisted DOM focus of the field whose accessible name matches the NVDA
   *  cursor item; focusing it flips NVDA into focus mode so typing lands. */
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
      this.debug("typedTextLanded: inconclusive — assuming landed", { result: String(result).slice(0, 80) });
      return true;
    }
    return result === "true";
  }

  private async itemTextSafe(): Promise<string> {
    try {
      return await this.withTimeout("itemText", this.nvda.itemText());
    } catch {
      return "";
    }
  }

  private async lastSpokenSafe(): Promise<string> {
    try {
      return await this.withTimeout("lastSpokenPhrase", this.nvda.lastSpokenPhrase());
    } catch {
      return "";
    }
  }

  async run(command: AtCommand, arg?: string): Promise<AtObservation> {
    const startedTimestamp = new Date().toISOString();
    let error: string | undefined;
    try {
      const budget = command === "type" ? this.commandTimeoutMs + (arg?.length ?? 0) * 1000 : this.commandTimeoutMs;
      await this.withTimeout(command, this.execute(command, arg), budget);
    } catch (e) {
      if (e instanceof NvdaCommandTimeoutError || e instanceof NvdaUnsupportedCommandError) throw e;
      error = e instanceof Error ? e.message : String(e);
    }
    let { rawSpoken, currentItem } = await this.collect();
    // Self-heal a cursor escape into browser chrome: re-enter the web area.
    if (
      NVDA_CURSOR_ESCAPED.test(currentItem.trim()) &&
      this.hostFocus &&
      this.escapeRecoveries < MAX_ESCAPE_RECOVERIES
    ) {
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
    // Trap detection: move commands that don't move inside a text-entry context
    // mean NVDA is stuck in focus mode on a field — pop back to browse mode.
    if (command === "next" || command === "previous") {
      this.trappedMoves = currentItem === this.lastMoveItem ? this.trappedMoves + 1 : 0;
      this.lastMoveItem = currentItem;
      if (
        this.trappedMoves >= TRAPPED_MOVE_LIMIT &&
        this.trapPops < MAX_TRAP_POPS &&
        NVDA_TEXT_ENTRY_CONTEXT.test([currentItem, ...rawSpoken.slice(-2)].join(" "))
      ) {
        this.trapPops++;
        this.trappedMoves = 0;
        this.debug("cursor trapped in focus mode — exiting to browse mode", { item: currentItem, pop: this.trapPops });
        await this.withTimeout(
          "trapPop:exitFocusMode",
          this.nvda.perform(this.nvda.keyboardCommands.exitFocusMode, { capture: "initial" })
        ).catch(() => {});
        const popped = await this.collect();
        rawSpoken = [...rawSpoken, ...popped.rawSpoken];
        currentItem = popped.currentItem;
      }
    }
    const cleanedItem = stripNvdaBoilerplate(currentItem) ?? currentItem;
    const alternates = new Set<string>();
    const announced = stripNvdaBoilerplate(rawSpoken.at(-1) ?? "");
    if (announced) alternates.add(announced);
    let roleFree = cleanedItem;
    let previous;
    do {
      previous = roleFree;
      roleFree = roleFree.replace(NVDA_AMBIGUOUS_ROLE_SUFFIX, "").trim();
    } while (roleFree !== previous && roleFree.length > 0);
    if (roleFree) alternates.add(roleFree);
    alternates.delete(cleanedItem);
    alternates.delete("");
    const observation = buildObservation(
      rawSpoken.map((p) => stripNvdaBoilerplate(p)).filter((p): p is string => p !== null),
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
    const nvda = this.nvda;
    const kc = nvda.keyboardCommands;
    const opts = this.commandOptions;
    switch (command) {
      case "observe":
        return;
      case "next":
        return nvda.next(opts);
      case "previous":
        return nvda.previous(opts);
      case "act":
        return nvda.act(opts);
      case "interact":
        // NVDA has no interaction levels; entering focus mode is the analogue.
        return nvda.perform(kc.toggleBetweenBrowseAndFocusMode, opts);
      case "stopInteracting":
        return nvda.perform(kc.exitFocusMode, opts);
      case "press":
        return nvda.press(arg ?? "Enter");
      case "pressKey":
        return nvda.press(arg ?? "Tab");
      case "type": {
        // NVDA needs DOM focus (→ focus mode) for keystrokes to land in a
        // field. Host-focus the field whose name matches the cursor item first
        // (the primary path here, vs VO where it's a retry), then type; verify
        // via the host and fall back to select-all+retype, paste, host-set.
        const label = stripNvdaBoilerplate(await this.itemTextSafe()) ?? "";
        await this.hostFocusField(label);
        await new Promise((r) => setTimeout(r, 250));
        // capture:false — NVDA echoes each typed char into a live-region-chatty
        // field, and guidepup's default post-type capture-poll waits for speech
        // to stabilize, which never happens → the command hangs to its budget.
        await nvda.type(arg ?? "", { capture: false });
        if (arg && arg.length >= 3 && this.hostEval) {
          if (!(await this.typedTextLanded(arg))) {
            this.debug("type: text not in focused field — host-assisted retype", {
              label,
              activeElement: await this.describeActiveElement()
            });
            await this.hostFocusField(label);
            await new Promise((r) => setTimeout(r, 250));
            await nvda.press("Control+a");
            await nvda.type(arg, { capture: false });
            if (!(await this.typedTextLanded(arg)) && this.hostSetClipboard) {
              this.debug("type: retype missed too — atomic paste fallback");
              await this.hostFocusField(label);
              await nvda.press("Control+a");
              await this.hostSetClipboard(arg);
              await new Promise((r) => setTimeout(r, 500));
              await nvda.press("Control+v");
            }
            if (!(await this.typedTextLanded(arg))) {
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
        for (let i = 0; i < n; i++) await nvda.next(opts);
        return;
      }
      case "restartFromTop":
        return nvda.press("Control+Home");
      case "moveToNextHeading":
        return nvda.perform(kc.moveToNextHeading, opts);
      case "moveToPreviousHeading":
        return nvda.perform(kc.moveToPreviousHeading, opts);
      case "moveToNextLink":
        return nvda.perform(kc.moveToNextLink, opts);
      case "moveToPreviousLink":
        return nvda.perform(kc.moveToPreviousLink, opts);
      case "moveToNextForm":
        return nvda.perform(kc.moveToNextFormField, opts);
      case "moveToNextLandmark":
        return nvda.perform(kc.moveToNextLandmark, opts);
      case "moveToPreviousLandmark":
        return nvda.perform(kc.moveToPreviousLandmark, opts);
      case "moveToNextMain":
        // NVDA has no "next main" primitive; landmark-hop is the honest
        // equivalent (main is a landmark). Plans currently never use this.
        return nvda.perform(kc.moveToNextLandmark, opts);
      default: {
        const exhaustive: never = command;
        throw new NvdaUnsupportedCommandError(`unsupported AT command for real NVDA: ${String(exhaustive)}`);
      }
    }
  }

  private async collect(): Promise<{ rawSpoken: string[]; currentItem: string }> {
    let rawSpoken: string[] = [];
    let currentItem = "";
    try {
      const log = await this.withTimeout("spokenPhraseLog", this.nvda.spokenPhraseLog());
      rawSpoken = log.slice(this.spokenLogCursor);
      this.spokenLogCursor = log.length;
      const itemLog = await this.withTimeout("itemTextLog", this.nvda.itemTextLog());
      for (const hopItem of itemLog.slice(this.itemTextLogCursor)) {
        if (hopItem && !rawSpoken.includes(hopItem)) rawSpoken.push(hopItem);
      }
      this.itemTextLogCursor = itemLog.length;
      currentItem = await this.withTimeout("itemText", this.nvda.itemText());
      const announced = stripNvdaBoilerplate(rawSpoken.at(-1) ?? "");
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
        () => reject(new NvdaCommandTimeoutError(`NVDA command "${command}" hung for ${budgetMs}ms`)),
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
