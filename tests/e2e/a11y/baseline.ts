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
 * That proof is only worth anything because the sweep runs on every PR (the
 * `e2e-local` job in .github/workflows/deploy.yml). While it was opt-in,
 * deleting rows without running it looked exactly like fixing the defects.
 *
 * Regenerate after intentional changes — unfiltered, or the write is refused:
 *   npm run a11y:coverage:update
 *
 * Re-record locally and commit the result. CI runs in check mode and fails if
 * the sweep modifies this file, so a regeneration cannot ride in on a PR that
 * did not mean to make one.
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
  /**
   * Node count when recorded. Growth IS a failure — see newFindings.
   *
   * The key is route|scheme|rule|kind, so without this a second inaccessible
   * control on a route that already baselines that rule would only lengthen
   * axe's `nodes` array and slip through as "already known". Counting is the
   * stable way to catch that: keying on node targets instead would churn on
   * every build, because the selectors carry React's generated ids (`«r12»`).
   */
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
  // This ledger is edited by hand — deleting a line is how a fix is claimed — so
  // a conflicted merge is the likely way it breaks. Name the file and the
  // recovery, rather than letting a bare SyntaxError surface in 37 route tests.
  let parsed: Partial<Baseline>;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Partial<Baseline>;
  } catch (e) {
    throw new Error(
      `a11y baseline at ${BASELINE_PATH} is not valid JSON (${(e as Error).message}). ` +
        `Fix the file, or regenerate it with A11Y_BASELINE_UPDATE=1.`
    );
  }
  if (parsed.entries !== undefined && (typeof parsed.entries !== "object" || parsed.entries === null)) {
    throw new Error(`a11y baseline at ${BASELINE_PATH} has a non-object "entries" field.`);
  }
  // A file without `entries` would otherwise reach `key in undefined`, which is
  // a TypeError in every route test rather than an explicable failure.
  return {
    recordedAt: parsed.recordedAt ?? "unknown",
    note: parsed.note ?? "",
    entries: parsed.entries ?? {}
  };
}

export function isUpdateMode(): boolean {
  // Not `Boolean(env)`: this flag both skips the per-route regression gate and
  // rewrites a checked-in ledger, and `A11Y_BASELINE_UPDATE=0` — which a CI job
  // exporting every a11y flag as "0" would produce — is truthy as a string.
  const raw = process.env.A11Y_BASELINE_UPDATE?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

/**
 * Findings not covered by the baseline — these are what fail the run.
 *
 * "Covered" means both the key is recorded AND the rule matches no more nodes
 * than when it was recorded. A rule that grows from 3 nodes to 4 has a newly
 * inaccessible control on it, which is a regression the key alone cannot see.
 */
export function newFindings(baseline: Baseline, routeId: string, scheme: ColorScheme, findings: Finding[]): Finding[] {
  return findings.filter((f) => {
    const known = baseline.entries[findingKey(routeId, scheme, f)];
    if (!known) return true;
    // Fail closed on a malformed row. This file is hand-edited (deleting a line
    // is how a fix is claimed), so a merge or a bad edit can drop `nodes` or
    // leave it a string — and `f.nodes > undefined` / `f.nodes > "3"` is false
    // for every value, which would exempt that rule on that route forever.
    const recordedNodes = typeof known.nodes === "number" && Number.isFinite(known.nodes) ? known.nodes : 0;
    return f.nodes > recordedNodes;
  });
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

/**
 * Replace the ledger — but only from a run that actually covered everything.
 *
 * `writeBaseline` rewrites the whole file, while the caller's accumulator only
 * holds routes that ran AND reached the recording line. A `--grep` filter, a
 * crashed route, or a second worker therefore rewrites the ledger from a
 * subset, silently deleting rows for routes nobody scanned. Since deleting a
 * row is how this repo claims a defect is fixed, a partial write fabricates
 * that proof. Demand the covered set and refuse otherwise.
 */
export function writeBaseline(
  entries: Record<string, BaselineEntry>,
  note: string,
  coverage: { expected: string[]; covered: Set<string> }
): void {
  const missing = coverage.expected.filter((id) => !coverage.covered.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to rewrite ${path.basename(BASELINE_PATH)} from a partial run: ` +
        `${coverage.covered.size}/${coverage.expected.length} routes recorded, missing ${missing.join(", ")}.\n` +
        `Regenerate with a full, unfiltered run:\n` +
        `  npm run a11y:coverage:update`
    );
  }
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
