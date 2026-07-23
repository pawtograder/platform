/**
 * Evaluation scorecard CLI (a11y-judge v2, Wave 5).
 *
 * Usage:
 *   tsx tools/a11y-judge/agent/evalReport.ts \
 *     --clean a11y-trajectories/<clean-run> \
 *     --gauntlet a11y-trajectories/<gauntlet-run-1> [--gauntlet ...] \
 *     [--out a11y-trajectories/<clean-run>/eval.md]
 *
 * Reads verdict.json + trajectory.json + groundTruth.json under each run and
 * emits a Markdown scorecard: clean reliability, mutation detection, and the
 * ablation row-set vs the round-1 static-judge gauntlet.
 */
import fs from "fs";
import path from "path";
import {
  mutationDetection,
  taskReliability,
  type SampleData,
  type TaskReliability
} from "./metrics";
import type { Trajectory } from "../schema/trajectory";

/** Round-1 static-judge gauntlet result per mutation (from PROGRESS.md). */
const R1_GAUNTLET: Record<string, string> = {
  "247-outline-none": "fail 15/15",
  "412-strip-labels": "fail 3/3",
  "243-tabindex-shuffle": "fail 3/3",
  "111-alt-degrade": "fail 3/3",
  "331-hide-error-text": "fail 3/3",
  "132-survey-options-first": "fail 3/3",
  "246-headings-generic": "fail 3/3",
  "413-silent-toast": "needs_human 3/3 (unreachable mutant)"
};

function readGroundTruth(cellDir: string): { id: string | null; criterion: string | null } {
  const p = path.join(cellDir, "groundTruth.json");
  if (!fs.existsSync(p)) return { id: null, criterion: null };
  try {
    const gt = JSON.parse(fs.readFileSync(p, "utf8"));
    return { id: gt.mutationId ?? gt.id ?? null, criterion: gt.criterion ?? gt.wcagCriterion ?? null };
  } catch {
    return { id: null, criterion: null };
  }
}

function loadRun(runDir: string): SampleData[] {
  const out: SampleData[] = [];
  for (const cell of fs.readdirSync(runDir).sort()) {
    const cellDir = path.join(runDir, cell);
    if (!fs.statSync(cellDir).isDirectory()) continue;
    const gt = readGroundTruth(cellDir);
    for (const sample of fs.readdirSync(cellDir).sort()) {
      const dir = path.join(cellDir, sample);
      const vPath = path.join(dir, "verdict.json");
      if (!fs.existsSync(vPath)) continue;
      const v = JSON.parse(fs.readFileSync(vPath, "utf8"));
      const trajectory: Trajectory | null = fs.existsSync(path.join(dir, "trajectory.json"))
        ? JSON.parse(fs.readFileSync(path.join(dir, "trajectory.json"), "utf8"))
        : null;
      const [pageId, taskId] = cell.split("__");
      out.push({
        cell,
        pageId,
        taskId,
        sampleIndex: Number(sample.replace(/^s/, "")) || 0,
        outcome: v.verdict?.outcome ?? null,
        predicateSuccess: Boolean(v.predicate?.success),
        isError: Boolean(v.isError),
        salvaged: Boolean(v.salvaged),
        steps: trajectory?.steps.length ?? 0,
        turns: v.numTurns ?? null,
        costUsd: v.costUsd ?? null,
        toolSequence: trajectory?.steps.map((s) => s.tool) ?? [],
        barrierCriteria: (v.verdict?.barriers ?? []).map((b: { wcagCriterion: string }) => b.wcagCriterion),
        mutationId: gt.id,
        mutationCriterion: gt.criterion
      });
    }
  }
  return out;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) (m.get(key(it)) ?? m.set(key(it), []).get(key(it))!).push(it);
  return m;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function render(cleanDir: string, gauntletDirs: string[]): string {
  const clean = loadRun(cleanDir);
  const cleanByTask = groupBy(clean, (s) => s.cell);
  const cleanReliability: TaskReliability[] = [...cleanByTask.values()].map(taskReliability);
  const cleanMeanStepsByTask = new Map<string, number>();
  for (const r of cleanReliability) cleanMeanStepsByTask.set(r.cell.split("__")[1], r.meanSteps);

  const lines: string[] = [];
  lines.push(`# Agentic SR-driving evaluation`, "");
  lines.push(`Clean run: \`${path.basename(cleanDir)}\` (${clean.length} samples). ` +
    `Gauntlet runs: ${gauntletDirs.map((d) => `\`${path.basename(d)}\``).join(", ") || "none"}.`, "");

  lines.push(`## Clean reliability (per task, across samples)`, "");
  lines.push(`| Task | n | predicate✓ | outcome (consistency) | mean steps | mean turns | mean $ | tool variance |`);
  lines.push(`|---|--|--|--|--|--|--|--|`);
  for (const r of cleanReliability) {
    lines.push(
      `| ${r.cell} | ${r.samples} | ${pct(r.predicatePassRate)} | ${r.modalOutcome} (${pct(r.outcomeConsistency)}) | ` +
        `${r.meanSteps.toFixed(1)} | ${r.meanTurns.toFixed(0)} | $${r.meanCostUsd.toFixed(2)} | ${r.meanToolEditDistance.toFixed(2)} |`
    );
  }
  lines.push("");

  const allGauntlet = gauntletDirs.flatMap(loadRun).filter((s) => s.mutationId);
  if (allGauntlet.length) {
    lines.push(`## Mutation gauntlet — agent detection`, "");
    lines.push(`Detection = task blocked OR a barrier reported with the planted WCAG SC.`, "");
    lines.push(`| Mutation | SC | Task | n | blocked | SC-match | detection | steps Δ vs clean | R1 static judge |`);
    lines.push(`|---|--|--|--|--|--|--|--|--|`);
    const byMutTask = groupBy(allGauntlet, (s) => `${s.mutationId}__${s.taskId}`);
    for (const samples of byMutTask.values()) {
      const d = mutationDetection(samples, cleanMeanStepsByTask.get(samples[0].taskId) ?? 0);
      lines.push(
        `| ${d.mutationId} | ${d.mutationCriterion ?? "-"} | ${d.taskId} | ${d.samples} | ${pct(d.blockedRate)} | ` +
          `${pct(d.scMatchRate)} | **${pct(d.detectionRate)}** | ${d.meanStepsDelta >= 0 ? "+" : ""}${d.meanStepsDelta.toFixed(1)} | ${R1_GAUNTLET[d.mutationId] ?? "—"} |`
      );
    }
    lines.push("");

    // Complementarity synthesis: agent detection (≥50% of samples) vs whether
    // the R1 static judge caught it (everything except 413, which it could not
    // reach). This is the ablation thesis — the two methods cover different
    // failure classes.
    const dets = [...byMutTask.values()].map((s) =>
      mutationDetection(s, cleanMeanStepsByTask.get(s[0].taskId) ?? 0)
    );
    const agentCatches = (id: string) => (dets.find((d) => d.mutationId === id)?.detectionRate ?? 0) >= 0.5;
    const r1Catches = (id: string) => /fail/.test(R1_GAUNTLET[id] ?? "");
    const both = dets.filter((d) => agentCatches(d.mutationId) && r1Catches(d.mutationId)).map((d) => d.mutationId);
    const agentOnly = dets.filter((d) => agentCatches(d.mutationId) && !r1Catches(d.mutationId)).map((d) => d.mutationId);
    const judgeOnly = dets.filter((d) => !agentCatches(d.mutationId) && r1Catches(d.mutationId)).map((d) => d.mutationId);
    lines.push(`### Complementarity (agent ≥50% detection vs R1 static judge)`, "");
    lines.push(`- **Both** catch: ${both.join(", ") || "—"}`);
    lines.push(
      `- **Agent uniquely** reaches: ${agentOnly.join(", ") || "—"} ` +
        `— the interactive channel detects what frozen evidence cannot manifest.`
    );
    lines.push(
      `- **Static judge uniquely** catches: ${judgeOnly.join(", ") || "—"} ` +
        `— visual-only or name-quality defects a screen-reader user can complete the task despite.`
    );
    lines.push(
      "",
      "The two methods are complementary, not redundant: agent mode scores *task-level* " +
        "barriers a real screen-reader user hits, the static judge scores *conformance* over " +
        "frozen evidence. Neither dominates — which is the argument for running both."
    );
    lines.push("");
    lines.push(`### 413-silent-toast note`, "");
    lines.push(
      `Round 1's static judge could not reach 413 (no visible status text ever appears during survey ` +
        `autosave, so "visible but unannounced" cannot manifest — it abstained needs_human 3/3). The agentic ` +
        `run answers a different question: does a screen-reader user completing the task ever learn their action ` +
        `succeeded? See the 413 rows above for whether the agent completed blind / flagged the missing feedback.`
    );
  } else {
    lines.push(`## Mutation gauntlet`, "", `_No gauntlet runs supplied (pass --gauntlet <dir> ...)._`);
  }
  return lines.join("\n") + "\n";
}

function main(): void {
  const args = process.argv.slice(2);
  const cleanDir = path.resolve(args[args.indexOf("--clean") + 1] ?? "a11y-trajectories/latest");
  const gauntletDirs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--gauntlet") gauntletDirs.push(path.resolve(args[i + 1]));
  const outIdx = args.indexOf("--out");
  const outPath = outIdx > -1 ? path.resolve(args[outIdx + 1]) : path.join(cleanDir, "eval.md");
  const md = render(cleanDir, gauntletDirs);
  fs.writeFileSync(outPath, md);
  console.log(md);
  console.log(`\nwrote ${outPath}`);
}

if (require.main === module) main();
