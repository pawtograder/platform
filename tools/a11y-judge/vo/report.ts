/**
 * Artifact writers for the real-VoiceOver runner: per-task spoken logs,
 * a junit.xml for CI, and a human summary. Everything lands under
 * a11y-vo-artifacts/<runId>/ (uploaded by the workflow). Artifacts contain
 * only spoken text, task ids and predicate details — never env values.
 */
import fs from "node:fs";
import path from "node:path";
import type { AtStepRecord } from "../agent/atHarness";

export const ARTIFACT_ROOT = "a11y-vo-artifacts";

export interface CalibrationEntry {
  stepIndex: number;
  command: string;
  milestone: string;
  observedItem: string;
  matched: boolean;
  /** Presses needed to resync to the milestone; null when never found. */
  resyncPresses: number | null;
}

export interface TaskReport {
  id: string;
  pageId: string;
  taskId: string;
  taskKind: "read" | "write";
  status: "passed" | "failed" | "blocked";
  error?: string;
  blockedBy?: string;
  durationMs: number;
  stepCount: number;
  resyncs: Array<{ stepIndex: number; presses: number; milestone: string }>;
  calibration?: CalibrationEntry[];
  recordingPath?: string;
  steps: AtStepRecord[];
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderJunit(reports: TaskReport[], suiteDurationMs: number): string {
  const failures = reports.filter((r) => r.status === "failed").length;
  const skipped = reports.filter((r) => r.status === "blocked").length;
  const cases = reports
    .map((r) => {
      const open = `  <testcase classname="a11y-vo.${xmlEscape(r.pageId)}" name="${xmlEscape(r.id)}" time="${(r.durationMs / 1000).toFixed(1)}">`;
      if (r.status === "blocked") {
        return `${open}\n    <skipped message="${xmlEscape(r.blockedBy ?? "known app defect")}"/>\n  </testcase>`;
      }
      if (r.status === "failed") {
        return `${open}\n    <failure message="${xmlEscape(r.error ?? "failed")}"/>\n  </testcase>`;
      }
      return `${open}</testcase>`;
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="a11y-voiceover" tests="${reports.length}" failures="${failures}" skipped="${skipped}" time="${(suiteDurationMs / 1000).toFixed(1)}">`,
    cases,
    `</testsuite>`,
    ``
  ].join("\n");
}

export function renderSummary(reports: TaskReport[], meta: Record<string, string>): string {
  const lines: string[] = ["# a11y VoiceOver run", ""];
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}**: ${v}`);
  lines.push("", "| task | kind | status | duration | resyncs | notes |", "|---|---|---|---|---|---|");
  for (const r of reports) {
    const icon = r.status === "passed" ? "✅" : r.status === "blocked" ? "⏭️" : "❌";
    const notes =
      r.status === "blocked"
        ? (r.blockedBy ?? "")
        : (r.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
    lines.push(
      `| ${r.id} | ${r.taskKind} | ${icon} ${r.status} | ${(r.durationMs / 1000).toFixed(0)}s | ${r.resyncs.length} | ${notes} |`
    );
  }
  const calibrated = reports.filter((r) => r.calibration?.length);
  if (calibrated.length > 0) {
    lines.push("", "## Calibration (milestone drift)", "");
    for (const r of calibrated) {
      const misses = r.calibration!.filter((c) => !c.matched);
      lines.push(`### ${r.id} — ${misses.length}/${r.calibration!.length} milestones missed on first observe`);
      for (const c of misses) {
        lines.push(
          `- step ${c.stepIndex} (${c.command}): template \`${c.milestone}\` vs observed \`${c.observedItem}\`` +
            (c.resyncPresses === null ? " — **never found**" : ` — resynced after ${c.resyncPresses} presses`)
        );
      }
      lines.push("");
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function writeRunArtifacts(runId: string, reports: TaskReport[], meta: Record<string, string>): string {
  const runDir = path.join(ARTIFACT_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const suiteDurationMs = reports.reduce((total, r) => total + r.durationMs, 0);

  for (const r of reports) {
    const taskDir = path.join(runDir, "tasks", r.id);
    fs.mkdirSync(taskDir, { recursive: true });
    const { steps, ...result } = r;
    fs.writeFileSync(path.join(taskDir, "result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(taskDir, "steps.json"), JSON.stringify(steps, null, 2));
    fs.writeFileSync(
      path.join(taskDir, "spoken.jsonl"),
      steps
        .map((s) => JSON.stringify({ index: s.index, command: s.command, arg: s.arg, rawSpoken: s.rawSpoken }))
        .join("\n") + "\n"
    );
  }
  fs.writeFileSync(path.join(runDir, "junit.xml"), renderJunit(reports, suiteDurationMs));
  fs.writeFileSync(path.join(runDir, "summary.md"), renderSummary(reports, meta));

  const latest = path.join(ARTIFACT_ROOT, "latest");
  try {
    fs.rmSync(latest, { force: true });
    fs.symlinkSync(runId, latest);
  } catch {
    /* symlinks are a convenience; never fail the run over one */
  }
  return runDir;
}
