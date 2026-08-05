/**
 * Known-issues baseline for the student a11y sweep.
 *
 * The sweep turns on scanning for ~29 routes that have never been scanned, in
 * two color schemes, with the third-party widget subtrees no longer excluded
 * and axe's `incomplete` bucket read for the first time. That surfaces a large
 * amount of PRE-EXISTING debt at once. Failing the suite on all of it would
 * mean the coverage cannot land until every violation is fixed, which couples
 * two unrelated pieces of work and produces a branch that never merges.
 *
 * So: findings present when the baseline was recorded are reported but do not
 * fail. Anything NEW fails. The debt is visible, attributable per route, and
 * can only shrink — `baseline.json` is a checked-in ledger, and removing a line
 * from it is the proof that something got fixed.
 *
 * Regenerate after intentional changes:
 *   A11Y_BASELINE_UPDATE=1 npx playwright test tests/e2e/a11y-coverage.test.tsx --project=chromium
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ColorScheme, Finding } from "./scan";
import { findingKey } from "./scan";

export const BASELINE_PATH = path.join(__dirname, "baseline.json");

export type BaselineEntry = {
  route: string;
  scheme: ColorScheme;
  rule: string;
  kind: "violation" | "incomplete";
  /** Node count when recorded — informational; growth is not itself a failure. */
  nodes: number;
  impact: string;
  sample: string;
};

export type Baseline = {
  /** Recorded so a stale baseline is obvious in review. */
  recordedAt: string;
  note: string;
  entries: Record<string, BaselineEntry>;
};

export function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    return { recordedAt: "never", note: "no baseline recorded yet", entries: {} };
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

export function isUpdateMode(): boolean {
  return Boolean(process.env.A11Y_BASELINE_UPDATE);
}

/** Findings not present in the baseline — these are what fail the run. */
export function newFindings(baseline: Baseline, routeId: string, scheme: ColorScheme, findings: Finding[]): Finding[] {
  return findings.filter((f) => !(findingKey(routeId, scheme, f) in baseline.entries));
}

export function toEntries(routeId: string, scheme: ColorScheme, findings: Finding[]): Record<string, BaselineEntry> {
  const out: Record<string, BaselineEntry> = {};
  for (const f of findings) {
    out[findingKey(routeId, scheme, f)] = {
      route: routeId,
      scheme,
      rule: f.rule,
      kind: f.kind,
      nodes: f.nodes,
      impact: f.impact,
      sample: f.sample
    };
  }
  return out;
}

export function writeBaseline(entries: Record<string, BaselineEntry>, note: string): void {
  const sorted: Record<string, BaselineEntry> = {};
  for (const k of Object.keys(entries).sort()) sorted[k] = entries[k];
  const payload: Baseline = { recordedAt: new Date().toISOString(), note, entries: sorted };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n");
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `  ${f.kind === "incomplete" ? "?" : "x"} ${f.rule} (${f.impact}, ${f.nodes} node(s)) — ${f.sample}`)
    .join("\n");
}
