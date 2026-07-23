/**
 * AtHarness — the assistive-technology interaction channel for the agentic
 * a11y judge (v2). Wraps an injected @guidepup/virtual-screen-reader instance
 * plus real keyboard input, exposing exactly what a screen-reader user can do
 * and hear — and nothing else. No DOM access, no screenshots, no mouse.
 *
 * Two cursors, deliberately (mirrors browse mode vs focus mode in real SRs):
 *  - the VIRTUAL cursor: next/previous/structural moves + act() on the item;
 *  - real DOM FOCUS: interact() moves focus to the cursor item; press/type hit
 *    the focused element; pressKey() is a raw browser keypress (Tab, arrows).
 *
 * Every command returns an AtObservation:
 *  - spokenSinceLastAction: new spoken phrases (noise-filtered; raw preserved
 *    in the step record for auditability),
 *  - currentItem: what the virtual cursor rests on,
 *  - domFocus: role + accessible name of the DOM-focused element (SRs announce
 *    focus, so this stays within the "screen-reader-legitimate" channel).
 *
 * Self-healing lifecycle: virtual.start() binds to a specific document, so a
 * full navigation orphans it. Every command lazily (re)starts the VSR against
 * the current document via a per-document sentinel; the injected bundle itself
 * re-installs via addInitScript semantics.
 */
import type { Page } from "@playwright/test";
import { getVsrBundleSource, VSR_GLOBAL } from "./vsrBundle";
import { installVideoOverlay, OVERLAY_GLOBAL } from "./videoOverlay";

export const HARNESS_VERSION = "1";

/** Bounded batch read so linear listening doesn't burn one turn per phrase. */
export const READ_NEXT_MAX = 25;

export const DEFAULT_NOISE_PATTERNS: RegExp[] = [/realtime connection/i, /connections? active/i];

export const STRUCTURAL_COMMANDS = [
  "moveToNextHeading",
  "moveToPreviousHeading",
  "moveToNextLandmark",
  "moveToPreviousLandmark",
  "moveToNextLink",
  "moveToPreviousLink",
  "moveToNextForm",
  "moveToNextMain"
] as const;
export type StructuralCommand = (typeof STRUCTURAL_COMMANDS)[number];

export type AtCommand =
  | "next"
  | "previous"
  | "act"
  | "interact"
  | "stopInteracting"
  | "press"
  | "type"
  | "readNext"
  | "restartFromTop"
  | "pressKey"
  | "observe"
  | StructuralCommand;

export interface AtObservation {
  spokenSinceLastAction: string[];
  currentItem: string;
  domFocus: string | null;
  /**
   * TRUE checked state of the control under the virtual cursor (radio/
   * checkbox/switch), read live from the DOM. The VSR's spoken phrases go
   * stale here (verified on plain native inputs: toggles are neither announced
   * nor reflected on re-read — simulator limitation, spike s5); a real screen
   * reader announces real state, so the harness supplies it truthfully.
   */
  checkableState?: "checked" | "not checked";
  /** Set when the command itself failed; phrases/cursor state still reported. */
  error?: string;
}

export interface AtStepRecord {
  index: number;
  command: AtCommand;
  arg?: string;
  observation: AtObservation;
  rawSpoken: string[];
  startedTimestamp: string;
  endedTimestamp: string;
}

/** Pure: split raw phrases into (filtered observation phrases, raw). */
export function filterNoise(phrases: string[], patterns: RegExp[] = DEFAULT_NOISE_PATTERNS): string[] {
  return phrases.filter((p) => !patterns.some((re) => re.test(p)));
}

/** Pure: assemble the observation handed to the agent. */
export function buildObservation(
  rawSpoken: string[],
  currentItem: string,
  domFocus: string | null,
  options: { noisePatterns?: RegExp[]; error?: string; checkableState?: "checked" | "not checked" | null } = {}
): AtObservation {
  const observation: AtObservation = {
    spokenSinceLastAction: filterNoise(rawSpoken, options.noisePatterns ?? DEFAULT_NOISE_PATTERNS),
    currentItem,
    domFocus
  };
  if (options.checkableState) observation.checkableState = options.checkableState;
  if (options.error) observation.error = options.error;
  return observation;
}

interface InPageResult {
  newPhrases: string[];
  currentItem: string;
  domFocus: string | null;
  checkableState: "checked" | "not checked" | null;
  error?: string;
}

export class AtHarness {
  readonly steps: AtStepRecord[] = [];
  private constructor(
    private readonly page: Page,
    private readonly noisePatterns: RegExp[]
  ) {}

  /**
   * Inject the VSR bundle and return a harness. Call before navigation.
   * `videoOverlay: true` additionally installs the visual highlight/caption
   * overlay for video recordings — the in-page update hook is a no-op when
   * the overlay is not installed, so agent/evidence runs are unaffected.
   */
  static async install(
    page: Page,
    options: { noisePatterns?: RegExp[]; videoOverlay?: boolean } = {}
  ): Promise<AtHarness> {
    await page.addInitScript(getVsrBundleSource());
    if (options.videoOverlay) await installVideoOverlay(page);
    return new AtHarness(page, options.noisePatterns ?? DEFAULT_NOISE_PATTERNS);
  }

  async run(command: AtCommand, arg?: string): Promise<AtObservation> {
    const startedTimestamp = new Date().toISOString();
    let result: InPageResult;
    if (command === "pressKey") {
      // Raw browser keypress (Tab/Shift+Tab/Enter/arrows...) — real focus
      // navigation, outside the virtual cursor. Then observe.
      let error: string | undefined;
      await this.page.keyboard.press(arg ?? "Tab").catch((e) => (error = String(e)));
      await this.page.waitForTimeout(150);
      // Overlay caption should read as the keypress, not "observe".
      result = await this.evaluateCommand("observe", undefined, `pressKey ${arg ?? "Tab"}`);
      if (error) result.error = error;
    } else {
      result = await this.evaluateCommand(command, arg);
    }
    const observation = buildObservation(result.newPhrases, result.currentItem, result.domFocus, {
      noisePatterns: this.noisePatterns,
      checkableState: result.checkableState,
      error: result.error
    });
    this.steps.push({
      index: this.steps.length,
      command,
      ...(arg === undefined ? {} : { arg }),
      observation,
      rawSpoken: result.newPhrases,
      startedTimestamp,
      endedTimestamp: new Date().toISOString()
    });
    return observation;
  }

  private evaluateCommand(command: AtCommand, arg?: string, overlayLabel?: string): Promise<InPageResult> {
    return this.page.evaluate(
      async ({ globalName, command, arg, readNextMax, overlayGlobal, overlayLabel, stepIndex }) => {
        const w = window as unknown as Record<string, { virtual: any }>;
        const d = document as unknown as Document & { __vsrStarted?: boolean; __vsrCursor?: number };
        const out: {
          newPhrases: string[];
          currentItem: string;
          domFocus: string | null;
          checkableState: "checked" | "not checked" | null;
          error?: string;
        } = {
          newPhrases: [],
          currentItem: "",
          domFocus: null,
          checkableState: null
        };
        const vsr = w[globalName];
        if (!vsr) {
          out.error = "virtual screen reader bundle not present in this document";
          return out;
        }
        const v = vsr.virtual;
        try {
          // Self-healing per-document start.
          if (!d.__vsrStarted) {
            try {
              await v.stop();
            } catch {
              /* no previous instance */
            }
            await v.start({ container: d.body });
            d.__vsrStarted = true;
            d.__vsrCursor = 0;
          }
          switch (command) {
            case "observe":
              break;
            case "next":
              await v.next();
              break;
            case "previous":
              await v.previous();
              break;
            case "act":
              await v.act();
              break;
            case "interact":
              await v.interact();
              break;
            case "stopInteracting":
              await v.stopInteracting();
              break;
            case "press":
              await v.press(arg ?? "Enter");
              break;
            case "type":
              await v.type(arg ?? "");
              break;
            case "readNext": {
              const n = Math.min(Math.max(parseInt(arg ?? "10", 10) || 10, 1), readNextMax);
              for (let i = 0; i < n; i++) await v.next();
              break;
            }
            case "restartFromTop":
              await v.stop();
              await v.start({ container: d.body });
              d.__vsrCursor = 0;
              break;
            default:
              // Structural moves resolve through the commands map.
              if (v.commands && command in v.commands) {
                await v.perform(v.commands[command]);
              } else {
                out.error = `unknown command: ${command}`;
              }
          }
        } catch (e) {
          out.error = String(e);
        }
        try {
          const log: string[] = await v.spokenPhraseLog();
          out.newPhrases = log.slice(d.__vsrCursor ?? 0);
          d.__vsrCursor = log.length;
          out.currentItem = await v.itemText();
        } catch (e) {
          out.error = out.error ?? String(e);
        }
        // True checked state of the control under the virtual cursor (or, in
        // focus mode, the focused control): the VSR's own announcements go
        // stale on checkables (spike s5), a real SR would announce real state.
        let cursorNode: unknown = null;
        try {
          cursorNode = typeof v.activeNode === "function" ? v.activeNode() : v.activeNode;
          const candidates = [cursorNode, document.activeElement].filter(Boolean) as Element[];
          for (const el of candidates) {
            const input = el as HTMLInputElement;
            const isNativeCheckable = el.tagName === "INPUT" && (input.type === "radio" || input.type === "checkbox");
            const ariaChecked = el.getAttribute?.("aria-checked");
            if (isNativeCheckable) {
              out.checkableState = input.checked ? "checked" : "not checked";
              break;
            }
            if (ariaChecked === "true" || ariaChecked === "false") {
              out.checkableState = ariaChecked === "true" ? "checked" : "not checked";
              break;
            }
          }
        } catch {
          /* state augmentation is best-effort */
        }
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body) {
          const tag = ae.tagName.toLowerCase();
          const inputType = tag === "input" ? ((ae as HTMLInputElement).type || "text").toLowerCase() : null;
          const inputRoles: Record<string, string> = {
            radio: "radio",
            checkbox: "checkbox",
            button: "button",
            submit: "button",
            reset: "button",
            range: "slider",
            number: "spinbutton",
            search: "searchbox"
          };
          const role =
            ae.getAttribute("role") ??
            (inputType ? (inputRoles[inputType] ?? "textbox") : null) ??
            { a: "link", button: "button", textarea: "textbox", select: "combobox" }[tag] ??
            tag;
          const name = (
            ae.getAttribute("aria-label") ??
            (ae as HTMLInputElement).labels?.[0]?.textContent ??
            (ae as HTMLInputElement).value ??
            ae.textContent ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          // Checkable state matters most to an SR user (it is what their SR
          // would announce on toggle).
          const checkable = inputType === "radio" || inputType === "checkbox";
          const state = checkable ? ((ae as HTMLInputElement).checked ? ", checked" : ", not checked") : "";
          out.domFocus = (name ? `${role} "${name}"` : role) + state;
        }
        // Video-overlay hook: no-op unless installVideoOverlay ran (video mode).
        try {
          const overlay = (window as unknown as Record<string, { update?: (p: unknown) => void }>)[overlayGlobal];
          overlay?.update?.({
            stepIndex,
            command: overlayLabel ?? command,
            arg,
            phrases: out.newPhrases,
            node: (cursorNode instanceof Element ? cursorNode : null) ?? document.activeElement
          });
        } catch {
          /* overlay is best-effort, never fails a command */
        }
        return out;
      },
      {
        globalName: VSR_GLOBAL,
        command,
        arg,
        readNextMax: READ_NEXT_MAX,
        overlayGlobal: OVERLAY_GLOBAL,
        overlayLabel,
        stepIndex: this.steps.length
      }
    );
  }
}
