/* eslint-disable no-console */
/**
 * Global teardown for `BUG_REPORT_TRACE=1` runs: merges the workers' partial files into
 * `lib/bugReport/generated/privacy.observed.json` and `pii-sinks.json`, writes a coverage and
 * detail report next to the partials, and prints the check results and coverage gaps (test I4).
 *
 * The generated files are replaced by this run's results, so a full-suite run can drop stale
 * entries. `BUG_REPORT_TRACE_MERGE=1` instead adds this run's results to the committed files, for
 * building them up from partial runs. `BUG_REPORT_TRACE_STRICT=1` fails the run when a check fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  blockCandidates,
  checkObserved,
  isBlocking,
  checkSinks,
  normalizeObserved,
  normalizeSinks,
  stableJson,
  type ObservedFlow,
  type PiiSinks
} from "@/lib/bugReport/traceCheck";
import type { TracePartial } from "./taintTrace";

export const OBSERVED_PATH = path.join("lib", "bugReport", "generated", "privacy.observed.json");
export const SINKS_PATH = path.join("lib", "bugReport", "generated", "pii-sinks.json");

function traceDir(): string {
  return process.env.BUG_REPORT_TRACE_DIR || path.join(process.cwd(), "test-results", "bug-report-trace");
}

export type CoverageRow = { column: string; seeded: number; atSource: number; atSink: number };

/** Seeded canaries per column, and how many were seen at a source and at a sink. */
export function coverage(partials: TracePartial[]) {
  const seeded = new Map<string, { column: string; kind: string; rowId: string | number }>();
  const atSource = new Set<string>();
  const atSink = new Set<string>();
  for (const p of partials) {
    for (const { value, entry } of p.seeded)
      seeded.set(value, { column: entry.column, kind: entry.kind, rowId: entry.rowId });
    p.seenAtSource.forEach((v) => atSource.add(v));
    p.seenAtSink.forEach((v) => atSink.add(v));
  }
  const rows = new Map<string, CoverageRow>();
  const never: { value: string; column: string; kind: string; rowId: string | number }[] = [];
  for (const [value, e] of seeded) {
    const row = rows.get(e.column) ?? { column: e.column, seeded: 0, atSource: 0, atSink: 0 };
    rows.set(e.column, row);
    row.seeded++;
    if (atSource.has(value)) row.atSource++;
    if (atSink.has(value)) row.atSink++;
    if (!atSource.has(value) && !atSink.has(value)) never.push({ value, ...e });
  }
  const table = [...rows.values()].sort((a, b) => (a.column < b.column ? -1 : 1));
  return {
    columns: table,
    gaps: table.filter((r) => r.atSource === 0 && r.atSink === 0).map((r) => r.column),
    neverObserved: never,
    totals: {
      seeded: seeded.size,
      atSource: [...seeded.keys()].filter((v) => atSource.has(v)).length,
      atSink: [...seeded.keys()].filter((v) => atSink.has(v)).length
    }
  };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export default async function traceTeardown() {
  const dir = traceDir();
  const partialDir = path.join(dir, "partials");
  if (!existsSync(partialDir)) {
    console.log("[bug-report-trace] no worker output found; nothing to write");
    return;
  }
  const partials = readdirSync(partialDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<TracePartial | null>(path.join(partialDir, f), null))
    .filter((p): p is TracePartial => p !== null);

  const merge = process.env.BUG_REPORT_TRACE_MERGE === "1";
  const priorObserved = merge ? readJson<ObservedFlow[]>(OBSERVED_PATH, []) : [];
  const priorSinks = merge ? readJson<PiiSinks>(SINKS_PATH, {}) : {};
  const observed = normalizeObserved([...priorObserved, ...partials.flatMap((p) => p.observed)]);
  const sinks = normalizeSinks(priorSinks, ...partials.map((p) => p.sinks));
  writeFileSync(OBSERVED_PATH, stableJson(observed));
  writeFileSync(SINKS_PATH, stableJson(sinks));

  const cov = coverage(partials);
  const failures = [...checkObserved(observed), ...checkSinks(sinks)];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "report.json"),
    stableJson({
      failures,
      coverage: cov,
      blockCandidates: blockCandidates(sinks),
      pages: partials.flatMap((p) => p.pages),
      sourceDetails: partials.flatMap((p) => p.sourceDetails),
      sinkDetails: partials.flatMap((p) => p.sinkDetails)
    })
  );
  rmSync(partialDir, { recursive: true, force: true });

  console.log(
    `[bug-report-trace] ${observed.length} observed flows, ${Object.keys(sinks).length} routes with sinks → ${OBSERVED_PATH}, ${SINKS_PATH}`
  );
  console.log(
    `[bug-report-trace] canaries: ${cov.totals.seeded} seeded, ${cov.totals.atSource} seen at a source, ${cov.totals.atSink} seen rendered`
  );
  if (cov.gaps.length > 0)
    console.log(`[bug-report-trace] coverage gaps (seeded, never observed): ${cov.gaps.join(", ")}`);
  const blocking = failures.filter(isBlocking);
  const warnings = failures.filter((f) => !isBlocking(f));
  if (warnings.length > 0) {
    console.log(`[bug-report-trace] ${warnings.length} warnings:\n  ${warnings.map((f) => f.message).join("\n  ")}`);
  }
  if (blocking.length > 0) {
    console.log(
      `[bug-report-trace] ${blocking.length} check failures:\n  ${blocking.map((f) => f.message).join("\n  ")}`
    );
    if (process.env.BUG_REPORT_TRACE_STRICT === "1") {
      throw new Error(`bug report taint trace: ${blocking.length} check failures (see above)`);
    }
  }
  console.log(`[bug-report-trace] details: ${path.join(dir, "report.json")}`);
}
