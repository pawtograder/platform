/**
 * SafariHost — the host channel for the real-VoiceOver runner, driving real
 * Safari via AppleScript (osascript). It is the analogue of the Playwright
 * `page` in the virtual-SR path and is used ONLY for host duties: navigation,
 * localStorage seeding, readiness polling, URL assertions. All interaction and
 * every content assertion goes through VoiceOver (voHarness.ts) so the
 * evidence stays screen-reader-legitimate.
 *
 * Deliberately NOT safaridriver/WebDriver: a WebDriver-controlled Safari shows
 * the "remotely controlled" glass pane and terminates the session on outside
 * input — which is exactly what VoiceOver-driven keystrokes look like.
 * AppleScript coexists with VoiceOver cleanly (guidepup's own pattern).
 *
 * Requires (see docs/a11y-voiceover-mac-runbook.md): Safari's Develop menu
 * enabled with "Allow JavaScript from Apple Events", and Automation TCC grants
 * for the invoking process.
 */
import { execFile } from "node:child_process";

const OSASCRIPT_TIMEOUT_MS = 30_000;

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class SafariHostError extends Error {}

export class SafariHost {
  constructor(private readonly timeoutMs: number = OSASCRIPT_TIMEOUT_MS) {}

  private osascript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "osascript",
        ["-e", script],
        { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new SafariHostError(
                `osascript failed (${error.message.split("\n")[0]}): ${stderr.trim() || "no stderr"}. ` +
                  `If this is a permission error, re-check the Automation/Accessibility TCC grants (runbook §3).`
              )
            );
            return;
          }
          resolve(stdout.replace(/\n$/, ""));
        }
      );
    });
  }

  async activate(): Promise<void> {
    await this.osascript('tell application "Safari" to activate');
  }

  /** Open a URL in the front window (creating one if needed) and bring Safari forward. */
  async openUrl(url: string): Promise<void> {
    const u = escapeAppleScriptString(url);
    await this.osascript(
      [
        'tell application "Safari"',
        "  activate",
        // A Start Page / Favorites window counts as a window but has no
        // document, so gate on documents (not windows) to avoid -1719.
        "  if (count of documents) = 0 then",
        `    make new document with properties {URL:"${u}"}`,
        "  else",
        `    set URL of front document to "${u}"`,
        "  end if",
        "end tell"
      ].join("\n")
    );
  }

  async currentUrl(): Promise<string> {
    return this.osascript(
      [
        'tell application "Safari"',
        '  if (count of windows) = 0 then return ""',
        "  return URL of front document",
        "end tell"
      ].join("\n")
    );
  }

  /**
   * Evaluate JavaScript in the front document and return its string result.
   * Host duties only — never use this for interaction or content assertions.
   */
  async evalJs(js: string): Promise<string> {
    const script = [
      'tell application "Safari"',
      '  if (count of windows) = 0 then error "no Safari window"',
      `  return do JavaScript "${escapeAppleScriptString(js)}" in front document`,
      "end tell"
    ].join("\n");
    try {
      return await this.osascript(script);
    } catch (e) {
      if (String(e).includes("Allow JavaScript from Apple Events")) throw e;
      throw new SafariHostError(
        `${e instanceof Error ? e.message : e} — if JavaScript execution is blocked, enable ` +
          `Safari ▸ Develop ▸ Allow JavaScript from Apple Events (runbook §4).`
      );
    }
  }

  /**
   * Poll an in-page JS expression until it returns "true" (as a string).
   * Returns true on success, false on timeout — callers decide severity.
   */
  async waitForJs(js: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evalJs(js).catch(() => "");
      if (result === "true") return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /**
   * Put text on the system clipboard (for the VO harness's paste-based
   * typing retry — an atomic Cmd+V can't lose a race against an app rerender
   * the way seconds of per-character typing can).
   */
  async setClipboard(text: string): Promise<void> {
    await this.osascript(`set the clipboard to "${escapeAppleScriptString(text)}"`);
  }

  /** Best-effort browser-state hygiene between runs. */
  async closeAllWindows(): Promise<void> {
    await this.osascript('tell application "Safari" to close every window').catch(() => {});
  }
}
