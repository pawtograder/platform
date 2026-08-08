/**
 * Artifact writers for the real-NVDA runner — the Windows/NVDA counterpart of
 * vo/report.ts. Per-task spoken logs, a junit.xml for CI, and a human summary,
 * all under a11y-nvda-artifacts/<runId>/ (uploaded by the workflow). Artifacts
 * contain only spoken text, task ids and predicate details — never env values.
 */
import fs from "node:fs";
import path from "node:path";
import type { AtStepRecord } from "../agent/atHarness";
import type { NvdaCursorCheck, SweepMutation, TypeStepFidelity } from "./nvdaHarness";

export const ARTIFACT_ROOT = "a11y-nvda-artifacts";

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
  /** One entry per `type` step: which rung of the type ladder carried it and
   *  whether it landed. Kept in the artifacts even for passed tasks — in
   *  calibrate mode a degraded step only warns, so this is the only durable
   *  record that the keyboard did not do the typing. */
  typeFidelity?: TypeStepFidelity[];
  /** One entry per milestone-bearing state-changing step: what NVDA answered
   *  when asked where its cursor was (nvdaHarness corroborateCursor). Kept for
   *  passed tasks too — "0 resyncs" was the number that hid run 30483480823's
   *  wrong-element `act`, and these are what make that visible. */
  cursorChecks?: NvdaCursorCheck[];
  /** One entry per `next`/`previous` step that changed an answer instead of
   *  reading one. Kept for passed tasks too, for the reason issue #913 exists:
   *  the survey lane asserted only `is_submitted`, so a sweep that rewrote the
   *  radio group 27 times left no trace anywhere in a green run. */
  sweepMutations?: SweepMutation[];
  recordingPath?: string;
  steps: AtStepRecord[];
}

/**
 * One-line rendering of a degraded `type` step, shared by the console warning,
 * summary.md and junit so all three say the same thing.
 */
export function describeTypeDegradation(f: TypeStepFidelity): string {
  const how = f.hostSetValue
    ? "rung 4 hostSetValue FIRED — keyboard input never reached the field"
    : `carried by rung ${f.carriedBy ?? "none"}`;
  return `step ${f.stepIndex} (${JSON.stringify(f.text)}): ${how}; landed=${f.landed} (${f.reason})${describeHostClear(f)}${
    f.detail ? ` — ${f.detail}` : ""
  }`;
}

/**
 * The pre-retype host clear, rendered wherever a step is described. It is a DOM
 * write (setup for the retype, not the interaction under test) and so is never
 * left implicit: "dirty" in particular means the ladder REFUSED to type into a
 * field it could not empty, which is the doubled-value defect from run
 * 30457321723 being caught rather than repeated.
 */
export function describeHostClear(f: TypeStepFidelity): string {
  switch (f.hostClear) {
    case "none":
      return "";
    case "cleared":
      return "; field host-cleared before retype (confirmed empty)";
    case "dirty":
      return "; field host-clear FAILED — still held content, retype/paste refused";
    case "unknown":
      return "; field host-cleared before retype (clear UNCONFIRMED — probe failed)";
  }
}

/**
 * One-line rendering of a cursor contradiction, shared by the console warning
 * and summary.md. Both token bags are printed: the reader has to be able to see
 * WHY the harness called it a contradiction (no content word in common) rather
 * than take the verdict on trust.
 */
export function describeCursorContradiction(c: NvdaCursorCheck): string {
  return (
    `step ${c.stepIndex} (${c.command}): milestone ${JSON.stringify(c.milestone)} [${c.milestoneTokens.join(" ")}] ` +
    `but NVDA's navigator object was ${JSON.stringify(c.reply)} [${c.objectTokens.join(" ")}] — nothing in common`
  );
}

/**
 * One-line rendering of a sweep step that wrote instead of reading, shared by
 * the console warning and summary.md.
 *
 * Both answers are printed, and so is whether the pre-emptive exitFocusMode
 * fired: "the guard did not run" and "the guard ran and the arrow mutated
 * anyway" are different bugs, and only the second one means NVDA was still in
 * focus mode after an Escape.
 */
export function describeSweepMutation(m: SweepMutation): string {
  return (
    `step ${m.stepIndex} (${m.command}): arrowing past ${m.kind} ${JSON.stringify(m.key)} changed the answer ` +
    `${JSON.stringify(m.before)} → ${JSON.stringify(m.after)} — this step wrote, it did not read ` +
    `(left focus mode first: ${m.leftFocusMode}; restore: ${m.restored ? "confirmed" : `FAILED (${m.restore})`})`
  );
}

/** Verdict tally for the summary table: agreed/contradicted/abstained/… */
export function tallyCursorChecks(checks: NvdaCursorCheck[] = []): string {
  if (checks.length === 0) return "—";
  const counts = new Map<string, number>();
  for (const c of checks) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
  return [...counts.entries()].map(([verdict, n]) => `${verdict} ${n}`).join(", ");
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderJunit(reports: TaskReport[], suiteDurationMs: number): string {
  const failures = reports.filter((r) => r.status === "failed").length;
  const skipped = reports.filter((r) => r.status === "blocked").length;
  const cases = reports
    .map((r) => {
      const open = `  <testcase classname="a11y-nvda.${xmlEscape(r.pageId)}" name="${xmlEscape(r.id)}" time="${(r.durationMs / 1000).toFixed(1)}">`;
      if (r.status === "blocked") {
        return `${open}\n    <skipped message="${xmlEscape(r.blockedBy ?? "known app defect")}"/>\n  </testcase>`;
      }
      // Degradation rides along as system-out so it survives into CI even on a
      // PASSED case (calibrate mode warns rather than failing).
      const degraded = (r.typeFidelity ?? []).filter((f) => f.degraded);
      const sysOut = degraded.length
        ? `\n    <system-out>DEGRADED TYPE STEPS\n${xmlEscape(degraded.map(describeTypeDegradation).join("\n"))}</system-out>`
        : "";
      if (r.status === "failed") {
        return `${open}\n    <failure message="${xmlEscape(r.error ?? "failed")}"/>${sysOut}\n  </testcase>`;
      }
      return sysOut ? `${open}${sysOut}\n  </testcase>` : `${open}</testcase>`;
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="a11y-nvda" tests="${reports.length}" failures="${failures}" skipped="${skipped}" time="${(suiteDurationMs / 1000).toFixed(1)}">`,
    cases,
    `</testsuite>`,
    ``
  ].join("\n");
}

export function renderSummary(reports: TaskReport[], meta: Record<string, string>): string {
  const lines: string[] = ["# a11y NVDA run", ""];
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}**: ${v}`);
  lines.push(
    "",
    "| task | kind | status | duration | resyncs | degraded type steps | cursor oracle | notes |",
    "|---|---|---|---|---|---|---|---|"
  );
  for (const r of reports) {
    const icon = r.status === "passed" ? "✅" : r.status === "blocked" ? "⏭️" : "❌";
    const notes =
      r.status === "blocked"
        ? (r.blockedBy ?? "")
        : (r.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
    const degradedCount = (r.typeFidelity ?? []).filter((f) => f.degraded).length;
    const contradicted = (r.cursorChecks ?? []).filter((c) => c.verdict === "contradicted").length;
    lines.push(
      `| ${r.id} | ${r.taskKind} | ${icon} ${r.status} | ${(r.durationMs / 1000).toFixed(0)}s | ${r.resyncs.length} | ` +
        `${degradedCount > 0 ? `⚠️ ${degradedCount}` : "0"} | ` +
        `${contradicted > 0 ? `⚠️ ${tallyCursorChecks(r.cursorChecks)}` : tallyCursorChecks(r.cursorChecks)} | ${notes} |`
    );
  }
  // Directly under the table, because a contradiction explains a failure the
  // resync count cannot: in run 30483480823 the wrong-element `act` produced 0
  // resyncs, and the run summary said nothing at all.
  const contradictedReports = reports.filter((r) => (r.cursorChecks ?? []).some((c) => c.verdict === "contradicted"));
  if (contradictedReports.length > 0) {
    lines.push(
      "",
      "## Cursor contradictions (a state-changing step fired somewhere the plan never recorded)",
      "",
      "NVDA was asked where its review cursor was (reportCurrentObject) immediately before each",
      "state-changing step. Each line below is a step whose milestone and whose actual navigator",
      "object had no word in common — the speech tail matched, the cursor did not.",
      ""
    );
    for (const r of contradictedReports) {
      lines.push(`### ${r.id}`);
      for (const c of r.cursorChecks!.filter((x) => x.verdict === "contradicted")) {
        lines.push(`- ${describeCursorContradiction(c)}`);
      }
      lines.push("");
    }
  }
  // Next, because a mutating sweep invalidates the answer a write task then
  // asserts on — it has to be read before the predicate result is believed.
  const mutatingReports = reports.filter((r) => (r.sweepMutations ?? []).length > 0);
  if (mutatingReports.length > 0) {
    lines.push(
      "",
      "## Sweep mutations (a reading step changed the page's answers)",
      "",
      "`next`/`previous` are ArrowDown/ArrowUp. In NVDA focus mode an arrow inside a radio group",
      "moves AND selects, so a sweep looking for a milestone rewrites the answer it is reading.",
      "Each line below is such a step: the recorded answer is the driver's, not the user's.",
      "This is issue #913, which was filed against the app as an NVDA announcement bug — NVDA was",
      "reporting the state correctly every time.",
      ""
    );
    for (const r of mutatingReports) {
      lines.push(`### ${r.id}`);
      for (const m of r.sweepMutations!) lines.push(`- ${describeSweepMutation(m)}`);
      lines.push("");
    }
  }
  // Ahead of the calibration section: this explains failures in the table above,
  // and in calibrate mode it is the ONLY place a keyboard-bypassed write shows up.
  const degradedReports = reports.filter((r) => (r.typeFidelity ?? []).some((f) => f.degraded));
  if (degradedReports.length > 0) {
    lines.push(
      "",
      "## Degraded type steps (keyboard input did not do the typing)",
      "",
      "Each line below means a screen-reader user could not have completed that write by keyboard.",
      ""
    );
    for (const r of degradedReports) {
      lines.push(`### ${r.id}`);
      for (const f of r.typeFidelity!.filter((x) => x.degraded)) {
        lines.push(`- ${describeTypeDegradation(f)} (focus route: ${f.focusRoute})`);
      }
      lines.push("");
    }
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
