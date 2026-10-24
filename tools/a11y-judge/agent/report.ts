/**
 * Agent-run HTML report (a11y-judge v2, Wave 3).
 *
 * Usage: tsx tools/a11y-judge/agent/report.ts --trajectories a11y-trajectories/latest
 * Writes report.html into the run directory: a task × sample matrix plus
 * per-sample cards (outcome, machine predicate, barriers with step citations,
 * narrative, cost/turns) with a collapsible step-by-step trajectory.
 */
import fs from "fs";
import path from "path";
import type { Trajectory } from "../schema/trajectory";

interface SampleRecord {
  cell: string;
  sampleIndex: number;
  verdict: any;
  trajectory: Trajectory | null;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loadRun(runDir: string): SampleRecord[] {
  const records: SampleRecord[] = [];
  for (const cell of fs.readdirSync(runDir).sort()) {
    const cellDir = path.join(runDir, cell);
    if (!fs.statSync(cellDir).isDirectory()) continue;
    for (const sample of fs.readdirSync(cellDir).sort()) {
      const dir = path.join(cellDir, sample);
      const verdictPath = path.join(dir, "verdict.json");
      if (!fs.existsSync(verdictPath)) continue;
      const trajectoryPath = path.join(dir, "trajectory.json");
      records.push({
        cell,
        sampleIndex: Number(sample.replace(/^s/, "")) || 0,
        verdict: JSON.parse(fs.readFileSync(verdictPath, "utf8")),
        trajectory: fs.existsSync(trajectoryPath) ? JSON.parse(fs.readFileSync(trajectoryPath, "utf8")) : null
      });
    }
  }
  return records;
}

function outcomeBadge(v: any): string {
  if (v.isError) return `<span class="badge err">error</span>`;
  const outcome = v.verdict?.outcome ?? "?";
  const cls = outcome === "completed" ? "ok" : outcome === "blocked" ? "err" : "warn";
  return `<span class="badge ${cls}">${esc(outcome)}</span>`;
}

function sampleCard(r: SampleRecord): string {
  const v = r.verdict;
  const barriers = (v.verdict?.barriers ?? [])
    .map(
      (b: any) =>
        `<li><b>${esc(b.wcagCriterion)}</b> (sev ${esc(b.severity)}) ${esc(b.summary)}<br>
         <i>fix:</i> ${esc(b.suggestedFix)} <i>steps:</i> ${esc(b.evidenceRefs.join(", "))}</li>`
    )
    .join("");
  const rejected = (v.rejectedBarriers ?? [])
    .map((b: any) => `<li class="muted">${esc(b.summary)} (refs: ${esc(b.evidenceRefs.join(", "))})</li>`)
    .join("");
  const steps = (r.trajectory?.steps ?? [])
    .map(
      (s) =>
        `<tr><td>${s.index}</td><td>${esc(s.tool)}</td><td>${esc(s.argsJson)}</td><td>${esc(
          s.rawSpoken.join(" | ").slice(0, 220)
        )}</td></tr>`
    )
    .join("");
  return `<details class="card">
    <summary>${esc(r.cell)} s${r.sampleIndex} ${outcomeBadge(v)}
      <span class="badge ${v.predicate?.success ? "ok" : "err"}">predicate ${v.predicate?.success ? "PASS" : "FAIL"}</span>
      <span class="muted">${esc(v.numTurns ?? "-")} turns, $${esc(v.costUsd?.toFixed?.(2) ?? "-")}, ${r.trajectory?.steps.length ?? "-"} steps</span>
    </summary>
    <p><b>Predicate:</b> ${esc(v.predicate?.detail)}</p>
    ${v.errorText ? `<p class="err"><b>Error:</b> ${esc(v.errorText)}</p>` : ""}
    ${v.salvaged ? `<p class="warn"><b>Salvaged:</b> verdict reconstructed from the last structured-output attempt; barriers may be lost.</p>` : ""}
    ${v.barriersParseError ? `<p class="err"><b>barriersJson parse:</b> ${esc(v.barriersParseError)}</p>` : ""}
    <p><b>Task answer:</b> ${esc(v.verdict?.taskAnswer ?? "-")}</p>
    <p><b>Narrative:</b> ${esc(v.verdict?.narrative ?? "-")}</p>
    ${barriers ? `<p><b>Barriers</b></p><ul>${barriers}</ul>` : "<p><b>Barriers:</b> none</p>"}
    ${rejected ? `<p><b>Rejected (invalid citations)</b></p><ul>${rejected}</ul>` : ""}
    ${(v.verdict?.evidenceGaps ?? []).length ? `<p><b>Evidence gaps:</b> ${esc(v.verdict.evidenceGaps.join("; "))}</p>` : ""}
    <details><summary>Trajectory (${r.trajectory?.steps.length ?? 0} steps)</summary>
      <table><tr><th>#</th><th>tool</th><th>args</th><th>spoken</th></tr>${steps}</table>
    </details>
  </details>`;
}

function render(runDir: string): string {
  const records = loadRun(runDir);
  const cells = [...new Set(records.map((r) => r.cell))];
  const matrix = cells
    .map((cell) => {
      const samples = records.filter((r) => r.cell === cell);
      const cols = samples
        .map((r) => `<td>${outcomeBadge(r.verdict)} ${r.verdict.predicate?.success ? "✓" : "✗"}</td>`)
        .join("");
      return `<tr><td>${esc(cell)}</td>${cols}</tr>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>a11y agent run — ${esc(path.basename(runDir))}</title>
<style>
  body{font:14px/1.5 system-ui;margin:2rem;max-width:75rem}
  table{border-collapse:collapse;margin:.5rem 0}
  td,th{border:1px solid #ccc;padding:.3rem .6rem;text-align:left;vertical-align:top}
  .badge{padding:.1rem .45rem;border-radius:.6rem;font-size:.85em}
  .ok{background:#d7f0d7}.warn{background:#fce8b8}.err{background:#f6cdd0}
  .muted{color:#666}.card{border:1px solid #ddd;border-radius:.5rem;padding:.5rem .8rem;margin:.6rem 0}
  summary{cursor:pointer}
</style>
<h1>Agentic SR-driving run: ${esc(path.basename(fs.realpathSync(runDir)))}</h1>
<p>${records.length} samples, ${cells.length} (page, task) cells. Outcome badge = agent self-report; ✓/✗ = machine predicate.</p>
<table><tr><th>page__task</th><th colspan="9">samples</th></tr>${matrix}</table>
${records.map(sampleCard).join("\n")}`;
}

const dirFlag = process.argv.indexOf("--trajectories");
const runDir = path.resolve(dirFlag > -1 ? process.argv[dirFlag + 1] : "a11y-trajectories/latest");
const html = render(runDir);
const outPath = path.join(runDir, "report.html");
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath}`);
