/**
 * Page-readiness/settling for the real-Safari host channel — a port of
 * agent/pageReady.ts semantics (strict content wait, then live-region
 * quiescence) onto SafariHost.evalJs polling, so the VO runner settles pages
 * the same way the virtual-SR drivers do.
 */
import type { SafariHost } from "./safari";

export const SETTLE_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the main content region exists and is visible. */
export async function waitForPageReady(safari: SafariHost, timeoutMs = 30_000): Promise<void> {
  const visible = await safari.waitForJs(
    `(() => {
      const el = document.querySelector('#main-content, main');
      if (!el) return 'false';
      const rect = el.getBoundingClientRect();
      return String(rect.width > 0 && rect.height > 0);
    })()`,
    timeoutMs
  );
  if (!visible) {
    const url = await safari.currentUrl().catch(() => "?");
    const readyState = await safari.evalJs("document.readyState").catch(() => "?");
    const bodySnippet = await safari
      .evalJs("(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)")
      .catch(() => "?");
    throw new Error(
      `page never became ready (no visible #main-content/main within ${timeoutMs}ms) at ${url} ` +
        `[readyState=${readyState}] body: ${JSON.stringify(bodySnippet)}`
    );
  }
}

const LIVE_REGION_TEXT_JS = `(() =>
  Array.from(document.querySelectorAll("[role='status'],[aria-live],[role='log']"))
    .map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim())
    .join("|"))()`;

/**
 * Same steady-state contract as agent/pageReady.ts settlePage: fixed settle
 * wait, wait for the realtime status region to report connected (bounded,
 * best-effort), then require two consecutive identical live-region samples.
 */
export async function settlePage(safari: SafariHost): Promise<void> {
  await sleep(SETTLE_MS);
  await safari.waitForJs(
    `(() =>
      String(Array.from(document.querySelectorAll("[role='status'],[aria-live]"))
        .map((el) => (el.textContent || "").toLowerCase())
        .join(" ")
        .includes("all realtime connections active")))()`,
    20_000,
    1000
  );
  let prev: string | null = null;
  for (let i = 0; i < 24; i++) {
    const cur = await safari.evalJs(LIVE_REGION_TEXT_JS).catch(() => null);
    if (cur !== null && cur === prev) return;
    prev = cur;
    await sleep(500);
  }
}
