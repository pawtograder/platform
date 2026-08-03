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
  /**
   * Optional alternate renderings of the current item supplied by drivers
   * whose primary text embeds role words that exact template matching can't
   * safely strip (real VoiceOver's "New Request link" / "Complete button" —
   * the bare suffix collides with labels that genuinely end in "link" etc.).
   * Milestone matching accepts the primary OR any alternate. The virtual SR
   * never sets this.
   */
  currentItemAlternates?: string[];
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

/**
 * What the PLAN knows about the step being dispatched and the driver cannot
 * observe. Optional and additive on purpose: a driver that needs none of it
 * (the virtual SR, real VoiceOver) simply declares fewer parameters and still
 * satisfies AtDriver, and extra arguments are inert at runtime.
 */
export interface AtStepContext {
  /**
   * The step's recorded milestone — the normalized template (agent/normalize.ts)
   * of the item the cursor rested on when the trajectory was recorded, so for a
   * `type` step it names the target FIELD. Real NVDA needs it because its
   * itemText() is an alias for lastSpokenPhrase() (no cursor read), and the
   * `interact` that precedes every `type` speaks only "focus mode": every
   * speech-derived label source is therefore blind exactly where the driver has
   * to choose a field (run 30483480823). Drivers with a real cursor ignore it.
   */
  milestone?: string;
}

/**
 * What a driver's own cursor oracle can say about a claimed milestone match.
 *
 * "abstained" is the load-bearing member: it means the driver ASKED and got an
 * answer that carries no evidence either way (real NVDA's reportCurrentObject
 * collapses plain text to a bare role — "paragraph", "label"), which is not
 * disagreement and must never block progress.
 */
export type CursorVerdict = "agreed" | "contradicted" | "abstained";

/**
 * Which way AtDriver.moveToControl hops. Deliberately the same two words the
 * line-wise moves already use ("next"/"previous"), because it is the same
 * question asked at a different granularity.
 */
export type ControlHopDirection = "next" | "previous";

/**
 * The command surface replay/agent code depends on. Implemented by AtHarness
 * (virtual SR over Playwright) and by the real-VoiceOver harness
 * (tools/a11y-judge/vo/voHarness.ts), so replayPlan can drive either.
 */
export interface AtDriver {
  run(command: AtCommand, arg?: string, context?: AtStepContext): Promise<AtObservation>;
  /**
   * Optional last-resort recovery: called by replayPlan when a milestone
   * resync exhausts BOTH directions — real AT cursors get trapped inside
   * interaction levels or displaced by app rerenders in ways the virtual SR
   * cannot be. Implementations should pop interaction levels and re-enter
   * the content area. The virtual SR needs no implementation.
   */
  unstick?(): Promise<void>;
  /**
   * OPTIONAL cursor gate: ask the DRIVER — not its speech log — whether the
   * cursor really is on `milestone`, and answer without moving it.
   *
   * replayPlan decides "the cursor is on the right item" from
   * observation.currentItem. On a driver whose currentItem is a tail of the
   * speech log (real NVDA: itemText() is an alias for lastSpokenPhrase()) a
   * STALE utterance satisfies a milestone, the resync ladder never engages, and
   * the state-changing step fires on whatever the cursor happens to be on. Run
   * 30682097759 measured the damage: 11 of 14 state-changing steps fired on
   * unrecorded elements while all three tasks reported success — milestone
   * "reply" matched while NVDA's navigator object was "E 2E A 11y Agent Class,
   * link, linked".
   *
   * A driver that can read its cursor independently implements this; replayPlan
   * then consults it ONLY when a milestone is already claimed to match, and
   * treats "contradicted" as "the milestone is not satisfied" — the resync
   * ladder proceeds exactly as if the speech had never matched. "agreed" and
   * "abstained" both allow the match.
   *
   * Optional on purpose. A driver with a real, independently readable cursor
   * (the virtual SR) or no second opinion to offer (real VoiceOver, whose
   * currentItem already IS a cursor read) simply does not implement it, still
   * satisfies AtDriver, and the gate is inert for it.
   *
   * Implementations MUST NOT move the cursor, MUST bound their own latency (the
   * caller applies no timeout), and MUST prefer "abstained" over "contradicted"
   * whenever the reading is inconclusive.
   */
  verifyCursor?(milestone: string): Promise<CursorVerdict>;
  /**
   * OPTIONAL control-level cursor hop: move the review cursor to the next or
   * previous CONTROL, not the next line.
   *
   * `next`/`previous` are ArrowDown/ArrowUp on a real browse-mode driver: they
   * move by LINE and rest at the line start. When the app renders several inline
   * controls on one line, that ladder can reach the line and never the control.
   * Run 30760469666 is the measured case: NVDA coalesced a discussion post's
   * Like / Edit / Reply buttons into the single browse line "Like (0 likes),
   * button, Edit, button, Reply", every arrow press rested on Like, and the
   * milestone "reply" was therefore claimed by the speech (the line NAMES Reply)
   * and contradicted by the cursor oracle on every one of the 75 presses the
   * resync ladder spends. VoiceOver walks those same three buttons as three
   * separate items, which is why only NVDA needs this.
   *
   * Contract:
   *  - it MOVES the cursor (unlike verifyCursor, which must not), by exactly one
   *    control per call, and reports nothing: the caller reads where it landed
   *    through an ordinary `observe`, so the hop stays inside the normal
   *    observation pipeline (step record, noise filtering, speech-loss
   *    detection) instead of growing a second one;
   *  - it MUST bound its own latency — the caller applies no timeout;
   *  - it MUST NOT throw when there is no such control (a driver at the last
   *    button simply stays put; the caller's next observe sees the same item and
   *    the sweep budget ends it).
   *
   * Optional on purpose, and NOT an AtCommand: both real drivers close their
   * command switch with an exhaustiveness check, so widening AtCommand would
   * break the VoiceOver build, and the virtual screen reader has no control
   * mover at all. A driver that cannot hop by control simply omits this and
   * still satisfies AtDriver — replayPlan's ladder then skips the rung.
   */
  moveToControl?(direction: ControlHopDirection): Promise<void>;
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

/**
 * Pure: collapse CONSECUTIVE identical phrases into one entry with a repeat
 * count. The virtual screen reader re-announces a persisting live region many
 * times for a single DOM change (verified against a MutationObserver ground
 * truth: one toast = 1 text mutation, VSR spoke it 14×) — a simulator
 * artifact, like the stale checkable announcements (spike s5). A real SR
 * announces once per change. Raw phrases stay in the step record.
 */
export function collapseRepeats(phrases: string[]): string[] {
  const out: string[] = [];
  for (const phrase of phrases) {
    const last = out.length - 1;
    if (last >= 0 && (out[last] === phrase || out[last].startsWith(`${phrase} (announced `))) {
      const m = out[last].match(/ \(announced (\d+)×\)$/);
      const n = m ? parseInt(m[1], 10) + 1 : 2;
      out[last] = `${phrase} (announced ${n}×)`;
    } else {
      out.push(phrase);
    }
  }
  return out;
}

/** Pure: assemble the observation handed to the agent. */
export function buildObservation(
  rawSpoken: string[],
  currentItem: string,
  domFocus: string | null,
  options: {
    noisePatterns?: RegExp[];
    error?: string;
    checkableState?: "checked" | "not checked" | null;
    currentItemAlternates?: string[];
  } = {}
): AtObservation {
  const observation: AtObservation = {
    spokenSinceLastAction: collapseRepeats(filterNoise(rawSpoken, options.noisePatterns ?? DEFAULT_NOISE_PATTERNS)),
    currentItem,
    domFocus
  };
  if (options.currentItemAlternates?.length) observation.currentItemAlternates = options.currentItemAlternates;
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

export class AtHarness implements AtDriver {
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
    // Monaco's `accessibilitySupport: "auto"` detects real screen readers but not
    // the virtual one we inject, so it would serve these runs the non-SR editor.
    // The app reads this flag to opt into SR-optimized output; forcing it on in
    // the shipped option set would put every student and grader into
    // screen-reader rendering mode instead.
    await page.addInitScript(() => {
      (window as unknown as { __a11yForceScreenReader?: boolean }).__a11yForceScreenReader = true;
    });
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
