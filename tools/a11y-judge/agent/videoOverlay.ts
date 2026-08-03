/**
 * Visual overlay for keyboard-only-navigation video recordings (a11y-judge).
 *
 * Injected only when a replay runs in video mode (A11Y_VIDEO=1): draws a
 * highlight box over the element the virtual-screen-reader cursor rests on and
 * a bottom caption bar with the current command + spoken phrases, so a human
 * reviewer can follow the SR journey in the recorded video without running
 * anything.
 *
 * The screen reader can never announce the overlay, by construction:
 *  - the overlay root is appended to document.documentElement as a SIBLING of
 *    <body>, and atHarness always starts the VSR with `container: document.body`
 *    — structurally outside both cursor traversal and live-region observation;
 *  - defense in depth: aria-hidden + role=presentation + inert;
 *  - zero behavior impact: pointer-events:none, position:fixed (no layout),
 *    nothing focusable, read-only getBoundingClientRect in a rAF loop.
 */
import type { Page } from "@playwright/test";

export const OVERLAY_GLOBAL = "__pawtograderA11yOverlay";

export interface OverlayUpdate {
  stepIndex: number;
  command: string;
  arg?: string;
  phrases: string[];
  /** Element the highlight box should track (VSR cursor node or DOM focus). */
  node: Element | null;
}

/** Pure caption head-line formatter (serialized into the page — keep self-contained). */
export function formatCaption(stepIndex: number, command: string, arg?: string): string {
  return `step ${stepIndex} — ${command}${arg !== undefined && arg !== "" ? ` “${arg}”` : ""}`;
}

/**
 * In-page init. Serialized via .toString() — must be fully self-contained
 * (no imports, no outer-scope references beyond its parameters).
 */
function overlayInit(globalName: string, format: (stepIndex: number, command: string, arg?: string) => string): void {
  let root: HTMLElement | null = null;
  let box: HTMLElement | null = null;
  let captionHead: HTMLElement | null = null;
  let captionPhrases: HTMLElement | null = null;
  let tracked: Element | null = null;

  function ensureDom(): boolean {
    if (root && root.isConnected) return true;
    if (!document.documentElement) return false;
    root = document.createElement("div");
    root.setAttribute("data-a11y-video-overlay", "");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("role", "presentation");
    root.setAttribute("inert", "");
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;";

    box = document.createElement("div");
    box.style.cssText =
      "position:fixed;display:none;border:3px solid #ff2d92;border-radius:6px;" +
      "box-shadow:0 0 0 2px rgba(255,255,255,0.9),0 0 14px 2px rgba(255,45,146,0.8);" +
      "transition:left 120ms ease-out,top 120ms ease-out,width 120ms ease-out,height 120ms ease-out;";
    root.appendChild(box);

    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;background:rgba(10,10,14,0.88);color:#fff;" +
      "padding:10px 18px;line-height:1.45;";
    captionHead = document.createElement("div");
    captionHead.style.cssText = "font-size:17px;font-weight:700;";
    captionPhrases = document.createElement("div");
    captionPhrases.style.cssText =
      "font-size:15px;color:#c9f0ff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
    bar.appendChild(captionHead);
    bar.appendChild(captionPhrases);
    root.appendChild(bar);

    // Sibling of <body>: outside the VSR's traversal container.
    document.documentElement.appendChild(root);

    const reposition = () => {
      if (box) {
        if (tracked && tracked.isConnected) {
          const r = tracked.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            box.style.display = "block";
            box.style.left = `${r.left - 4}px`;
            box.style.top = `${r.top - 4}px`;
            box.style.width = `${r.width + 8}px`;
            box.style.height = `${r.height + 8}px`;
          } else {
            box.style.display = "none";
          }
        } else {
          box.style.display = "none";
        }
      }
      requestAnimationFrame(reposition);
    };
    requestAnimationFrame(reposition);
    return true;
  }

  (window as unknown as Record<string, unknown>)[globalName] = {
    update(payload: { stepIndex: number; command: string; arg?: string; phrases: string[]; node: Element | null }) {
      if (!ensureDom()) return;
      tracked = payload.node;
      if (captionHead) captionHead.textContent = format(payload.stepIndex, payload.command, payload.arg);
      if (captionPhrases) {
        captionPhrases.textContent = payload.phrases.length > 0 ? `🔊 ${payload.phrases.join(" • ")}` : "";
      }
    }
  };
}

/** Install the overlay init script. Call before navigation (video mode only). */
export async function installVideoOverlay(page: Page): Promise<void> {
  const source = `(${overlayInit.toString()})(${JSON.stringify(OVERLAY_GLOBAL)}, ${formatCaption.toString()});`;
  await page.addInitScript(source);
}
