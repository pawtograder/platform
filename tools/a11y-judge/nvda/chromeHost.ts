/**
 * ChromeHost — the host channel for the real-NVDA runner, driving a real
 * Chromium via Playwright. It is the Windows/Chrome analogue of SafariHost
 * (vo/safari.ts) and is used ONLY for host duties: navigation, localStorage
 * seeding, readiness polling, URL assertions, clipboard. All interaction and
 * every content assertion goes through NVDA (nvdaHarness.ts) so the evidence
 * stays screen-reader-legitimate.
 *
 * Unlike the VoiceOver lane (where Safari is a standing desktop app driven by
 * AppleScript), here ChromeHost OWNS the browser lifecycle: it launches a
 * headed Chromium that NVDA then reads. Playwright's CDP channel coexists with
 * NVDA cleanly — NVDA keystrokes are OS-level input, not WebDriver commands, so
 * they don't terminate the automation session.
 *
 * The public surface mirrors SafariHost exactly so vo/login.ts + vo/ready.ts
 * logic ports over unchanged: activate / openUrl / currentUrl / evalJs /
 * waitForJs / setClipboard / closeAllWindows.
 */
import { spawn } from "node:child_process";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export class ChromeHostError extends Error {}

const LAUNCH_ARGS = [
  // Chromium only builds the a11y tree once it detects an AT; force it on so
  // NVDA sees content deterministically regardless of detection timing.
  "--force-renderer-accessibility",
  "--window-position=0,0",
  "--window-size=1360,960",
  "--no-first-run",
  "--no-default-browser-check"
];

export class ChromeHost {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pageRef: Page | null = null;

  /** Launch a headed Chromium. Cookies live in the context and survive the
   *  per-task page churn that closeAllWindows()/openUrl() perform. */
  async launch(): Promise<void> {
    const { chromium } = await import("@playwright/test");
    this.browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    this.context = await this.browser.newContext({ viewport: null });
    try {
      await this.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    } catch {
      /* best effort */
    }
    this.pageRef = await this.context.newPage();
  }

  private get page(): Page {
    if (!this.pageRef) throw new ChromeHostError("ChromeHost not launched — call launch() first");
    return this.pageRef;
  }

  /** Bring the Chromium window to the foreground (best effort; the load-bearing
   *  foregrounding for NVDA is the Alt+Esc app-switch in nvdaHarness). */
  async activate(): Promise<void> {
    await this.page.bringToFront().catch(() => {});
  }

  /** Navigate the working page to `url` (creating a page if none). */
  async openUrl(url: string): Promise<void> {
    if (!this.pageRef || this.pageRef.isClosed()) {
      this.pageRef = await this.ctx.newPage();
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.activate();
  }

  async currentUrl(): Promise<string> {
    return this.pageRef && !this.pageRef.isClosed() ? this.page.url() : "";
  }

  /**
   * Evaluate a JS expression string in the page and return its string result.
   * Host duties only — never for interaction or content assertions. Mirrors
   * SafariHost.evalJs (which returns the osascript string result).
   */
  async evalJs(js: string): Promise<string> {
    try {
      const result = await this.page.evaluate(`(() => (${js}))()` as unknown as string);
      return result === undefined || result === null ? "" : String(result);
    } catch (e) {
      throw new ChromeHostError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Poll an in-page JS expression until it returns "true"; false on timeout. */
  async waitForJs(js: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evalJs(js).catch(() => "");
      if (result === "true") return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /** Put text on the Windows clipboard for the paste-based type retry (an
   *  atomic Ctrl+V beats a per-character-typing race against an app rerender). */
  async setClipboard(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Set-Clipboard via stdin avoids all shell-escaping of `text`.
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "$in=[Console]::In.ReadToEnd(); Set-Clipboard -Value $in"],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
      ps.on("error", reject);
      ps.on("close", () => resolve());
      ps.stdin.write(text);
      ps.stdin.end();
    });
  }

  /** Best-effort browser-state hygiene between tasks: drop all pages (cookies
   *  persist in the context), leaving a fresh page for the next openUrl. */
  async closeAllWindows(): Promise<void> {
    if (!this.context) return;
    for (const p of this.context.pages()) {
      await p.close().catch(() => {});
    }
    this.pageRef = await this.ctx.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.pageRef = null;
  }

  private get ctx(): BrowserContext {
    if (!this.context) throw new ChromeHostError("ChromeHost not launched — call launch() first");
    return this.context;
  }
}
