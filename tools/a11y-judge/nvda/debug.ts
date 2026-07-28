/**
 * Always-on diagnostic log for the real-NVDA runner — the Windows/NVDA
 * counterpart of vo/debug.ts. Every entry is mirrored to the console (CI log)
 * AND appended immediately to a11y-nvda-artifacts/<runId>/debug/debug.jsonl, so
 * a run that dies mid-login still leaves a complete trace in the artifact.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AtStepRecord } from "../agent/atHarness";
import { ARTIFACT_ROOT } from "./report";

export class NvdaDebugLog {
  private readonly file: string;
  private readonly dir: string;

  constructor(runId: string) {
    this.dir = path.join(ARTIFACT_ROOT, runId, "debug");
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, "debug.jsonl");
  }

  /** Free-form stage marker ("login attempt 2: magic link opened"). */
  log(stage: string, detail?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), stage, ...detail };
    console.log(`[a11y:nvda:debug] ${stage}${detail ? " " + JSON.stringify(detail) : ""}`);
    this.append(entry);
  }

  /** Full harness command record (written live, unlike the per-task steps.json). */
  step(record: AtStepRecord): void {
    const durationMs = new Date(record.endedTimestamp).getTime() - new Date(record.startedTimestamp).getTime();
    console.log(
      `[a11y:nvda:debug] cmd#${record.index} ${record.command}${record.arg ? `(${JSON.stringify(record.arg)})` : ""} ` +
        `${durationMs}ms item=${JSON.stringify(record.observation.currentItem.slice(0, 120))} ` +
        `spoken=${record.rawSpoken.length}${record.observation.error ? ` ERROR=${record.observation.error}` : ""}`
    );
    this.append({ ts: record.endedTimestamp, stage: "command", durationMs, ...record });
  }

  /** Best-effort full-screen screenshot into the debug dir via PowerShell +
   *  System.Drawing (needs an interactive desktop session — which NVDA needs
   *  anyway). */
  async screenshot(label: string): Promise<void> {
    const file = path.join(this.dir, `${label.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${Date.now()}.png`);
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
      "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
      `$bmp.Save(${JSON.stringify(file)}); $g.Dispose(); $bmp.Dispose()`;
    await new Promise<void>((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 15_000 }, (error) => {
        if (error) this.log("screenshot failed", { label, error: error.message.split("\n")[0] });
        else this.log("screenshot captured", { file });
        resolve();
      });
    });
  }

  fatal(error: unknown): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    fs.writeFileSync(path.join(this.dir, "fatal.txt"), `${new Date().toISOString()}\n${message}\n`);
    this.append({ ts: new Date().toISOString(), stage: "fatal", message });
  }

  private append(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch {
      /* the console mirror already has it */
    }
  }
}
