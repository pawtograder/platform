/* eslint-disable no-console */
/**
 * a11y-judge CLI — judge frozen evidence bundles with the LLM judge.
 *
 * Usage (mirrors scripts/demo/GenerateDemoFixtures.ts: dotenv .env.local first):
 *   npx tsx tools/a11y-judge/judge/run.ts --evidence a11y-evidence/latest --samples 3
 *
 * Flags:
 *   --evidence <dir>   evidence root (default a11y-evidence/latest)
 *   --criteria <csv>   only these criteria (default: all found)
 *   --pages <csv>      only these page ids (default: all found)
 *   --samples <n>      samples per bundle (default 3)
 *   --batch            use the Message Batches API (50% off; api backend only)
 *   --force            ignore the verdict cache
 *   --backend <b>      api | cli | auto (default auto: api when ANTHROPIC_API_KEY
 *                      is set, else `claude -p` over the standing OAuth session)
 *
 * Output contract (SHARED with the report renderer — do not deviate):
 *   a11y-verdicts/<runId>/run.json
 *   a11y-verdicts/<runId>/samples/<pageId>__<criterion>__s<i>.json
 *   a11y-verdicts/<runId>/majority/<pageId>__<criterion>.json
 *   a11y-verdicts/latest -> <runId>   (symlink)
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { EvidenceBundleSchema, type EvidenceBundle } from "../schema/evidence";
import type { Verdict, VerdictValue } from "../schema/verdict";
import {
  addUsage,
  emptyUsage,
  JUDGE_MODEL,
  judgeBundle,
  PROMPT_VERSION,
  worseVerdict,
  type RejectedFinding,
  type UsageTotals
} from "./client";
import { computeCacheKey, getCached, putCached, sha256File } from "./cache";
import { judgeBundlesBatch, type BatchJob } from "./batch";
import { CLI_PROMPT_SUFFIX, judgeBundleViaCli } from "./cliBackend";

dotenv.config({ path: ".env.local", quiet: true });

// Opus 4.8 pricing (USD per token). Cache writes 1.25x input, reads 0.1x input.
const PRICE_INPUT = 5 / 1_000_000;
const PRICE_OUTPUT = 25 / 1_000_000;
const PRICE_CACHE_WRITE = 6.25 / 1_000_000;
const PRICE_CACHE_READ = 0.5 / 1_000_000;

const RUBRICS_DIR = path.resolve(__dirname, "..", "rubrics");
const OUTPUT_ROOT = "a11y-verdicts";

type Backend = "api" | "cli";

interface CliArgs {
  evidence: string;
  criteria?: string[];
  pages?: string[];
  samples: number;
  batch: boolean;
  force: boolean;
  backend: Backend | "auto";
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = { evidence: "a11y-evidence/latest", samples: 3, batch: false, force: false, backend: "auto" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--evidence" && args[i + 1]) out.evidence = args[++i];
    else if (a === "--criteria" && args[i + 1])
      out.criteria = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--pages" && args[i + 1])
      out.pages = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--samples" && args[i + 1]) out.samples = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (a === "--batch") out.batch = true;
    else if (a === "--force") out.force = true;
    else if (a === "--backend" && args[i + 1]) {
      const b = args[++i];
      if (b !== "api" && b !== "cli" && b !== "auto") {
        console.error(`--backend must be api|cli|auto, got "${b}"`);
        process.exit(1);
      }
      out.backend = b;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx tools/a11y-judge/judge/run.ts --evidence <dir> [--criteria a,b] [--pages p1,p2] [--samples n] [--batch] [--force]"
      );
      process.exit(0);
    }
  }
  return out;
}

function listDirs(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Locate the rubric for a criterion by prefix (`<criterion>-*.md`) — no hardcoded filenames. */
function findRubric(criterion: string): string | null {
  if (!fs.existsSync(RUBRICS_DIR)) return null;
  const match = fs.readdirSync(RUBRICS_DIR).find((f) => f.startsWith(`${criterion}-`) && f.endsWith(".md"));
  return match ? path.join(RUBRICS_DIR, match) : null;
}

interface BundleTask {
  pageId: string;
  criterion: string;
  bundle: EvidenceBundle;
  bundleDir: string;
  manifestPath: string;
  rubricText: string;
  rubricSha: string;
}

/** Walk <evidence>/<pageId>/<criterion>/manifest.json into tasks, filtered by CLI flags. */
function collectBundles(args: CliArgs): { tasks: BundleTask[]; errors: RunError[] } {
  const tasks: BundleTask[] = [];
  const errors: RunError[] = [];
  const pageIds = listDirs(args.evidence).filter((p) => !args.pages || args.pages.includes(p));

  for (const pageId of pageIds) {
    const pageDir = path.join(args.evidence, pageId);
    const criteria = listDirs(pageDir).filter((c) => !args.criteria || args.criteria.includes(c));
    for (const criterion of criteria) {
      const bundleDir = path.join(pageDir, criterion);
      const manifestPath = path.join(bundleDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const bundle = EvidenceBundleSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8")));
        const rubricPath = findRubric(criterion);
        if (!rubricPath) {
          errors.push({ pageId, criterion, message: `no rubric found for criterion ${criterion} in ${RUBRICS_DIR}` });
          continue;
        }
        tasks.push({
          pageId,
          criterion,
          bundle,
          bundleDir,
          manifestPath,
          rubricText: fs.readFileSync(rubricPath, "utf-8"),
          rubricSha: sha256File(rubricPath)
        });
      } catch (e) {
        errors.push({ pageId, criterion, message: `failed to load bundle: ${(e as Error).message}` });
      }
    }
  }
  return { tasks, errors };
}

interface RunError {
  pageId: string;
  criterion: string;
  sampleIndex?: number;
  message: string;
}

/** The persisted verdict cache value. */
interface CachedVerdict {
  verdict: Verdict;
  rejectedFindings: RejectedFinding[];
  usage: UsageTotals;
}

interface SampleResult {
  pageId: string;
  criterion: string;
  sampleIndex: number;
  cached: boolean;
  cacheKey: string;
  verdict: Verdict;
  rejectedFindings: RejectedFinding[];
  usage: UsageTotals;
  evidenceManifestPath: string;
}

function writeSampleFile(runDir: string, s: SampleResult): void {
  fs.writeFileSync(
    path.join(runDir, "samples", `${s.pageId}__${s.criterion}__s${s.sampleIndex}.json`),
    JSON.stringify(
      {
        pageId: s.pageId,
        criterion: s.criterion,
        sampleIndex: s.sampleIndex,
        cached: s.cached,
        verdict: s.verdict,
        rejectedFindings: s.rejectedFindings,
        usage: s.usage,
        evidenceManifestPath: s.evidenceManifestPath
      },
      null,
      2
    )
  );
}

/** Majority vote across samples; ties resolve to the worse verdict. */
export function majorityVerdict(values: VerdictValue[]): VerdictValue {
  const counts = new Map<VerdictValue, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: VerdictValue = "pass";
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && worseVerdict(value, best) === value)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function estimateCost(u: UsageTotals): number {
  return (
    u.inputTokens * PRICE_INPUT +
    u.outputTokens * PRICE_OUTPUT +
    u.cacheCreationInputTokens * PRICE_CACHE_WRITE +
    u.cacheReadInputTokens * PRICE_CACHE_READ
  );
}

function refreshLatestSymlink(runId: string): void {
  const latest = path.join(OUTPUT_ROOT, "latest");
  try {
    if (fs.existsSync(latest) || fs.lstatSync(latest)) fs.rmSync(latest, { force: true });
  } catch {
    /* not present */
  }
  fs.symlinkSync(runId, latest);
}

function resolveBackend(args: CliArgs): Backend {
  if (args.backend !== "auto") return args.backend;
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

async function main(): Promise<void> {
  const args = parseArgs();
  const backend = resolveBackend(args);
  if (args.batch && backend !== "api") {
    console.error("--batch requires the api backend (set ANTHROPIC_API_KEY or pass --backend api).");
    process.exit(1);
  }
  // The two backends frame the prompt differently (system blocks + inline images
  // vs. inlined charter + Read-tool images), so their cached verdicts never mix.
  const effectivePromptVersion = backend === "cli" ? `${PROMPT_VERSION}${CLI_PROMPT_SUFFIX}` : PROMPT_VERSION;
  const startedAt = new Date().toISOString();
  const runId = `run-${startedAt.replace(/[:.]/g, "-")}`;
  const runDir = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(path.join(runDir, "samples"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "majority"), { recursive: true });

  const { tasks, errors } = collectBundles(args);
  if (tasks.length === 0) {
    console.warn(`No evidence bundles found under ${args.evidence}.`);
  }

  // Expand tasks × samples, splitting cache hits from pending work.
  const samples: SampleResult[] = [];
  const pending: { task: BundleTask; sampleIndex: number; cacheKey: string }[] = [];
  let cacheHits = 0;

  for (const task of tasks) {
    for (let i = 0; i < args.samples; i++) {
      const cacheKey = computeCacheKey({
        evidenceContentHash: task.bundle.contentHash,
        rubricFileSha256: task.rubricSha,
        promptVersion: effectivePromptVersion,
        model: JUDGE_MODEL,
        sampleIndex: i
      });
      const cached = args.force ? null : getCached<CachedVerdict>(cacheKey);
      if (cached) {
        cacheHits++;
        samples.push({
          pageId: task.pageId,
          criterion: task.criterion,
          sampleIndex: i,
          cached: true,
          cacheKey,
          verdict: cached.verdict,
          rejectedFindings: cached.rejectedFindings,
          usage: cached.usage,
          evidenceManifestPath: task.manifestPath
        });
      } else {
        pending.push({ task, sampleIndex: i, cacheKey });
      }
    }
  }

  let calls = 0;
  let runUsage = emptyUsage();

  if (pending.length > 0) {
    const client = backend === "api" ? new Anthropic() : null;

    if (args.batch && client) {
      const jobs: BatchJob[] = pending.map((p) => ({
        cacheKey: p.cacheKey,
        bundle: p.task.bundle,
        evidenceDir: p.task.bundleDir,
        rubricText: p.task.rubricText
      }));
      const batchResults = await judgeBundlesBatch({ client, jobs });
      for (const p of pending) {
        const res = batchResults.get(p.cacheKey);
        if (!res || res.status === "error") {
          errors.push({
            pageId: p.task.pageId,
            criterion: p.task.criterion,
            sampleIndex: p.sampleIndex,
            message: res?.message ?? "no batch result returned"
          });
          continue;
        }
        calls++;
        runUsage = addUsage(runUsage, res.result.usage);
        const value: CachedVerdict = {
          verdict: res.result.verdict,
          rejectedFindings: res.result.rejectedFindings,
          usage: res.result.usage
        };
        putCached(p.cacheKey, value);
        samples.push({
          pageId: p.task.pageId,
          criterion: p.task.criterion,
          sampleIndex: p.sampleIndex,
          cached: false,
          cacheKey: p.cacheKey,
          verdict: value.verdict,
          rejectedFindings: value.rejectedFindings,
          usage: value.usage,
          evidenceManifestPath: p.task.manifestPath
        });
      }
    } else {
      let done = 0;
      for (const p of pending) {
        console.log(
          `[a11y-judge] ${++done}/${pending.length} judging ${p.task.pageId}/${p.task.criterion} s${p.sampleIndex}…`
        );
        try {
          const result = client
            ? await judgeBundle({
                client,
                bundle: p.task.bundle,
                evidenceDir: p.task.bundleDir,
                rubricText: p.task.rubricText
              })
            : await judgeBundleViaCli({
                bundle: p.task.bundle,
                evidenceDir: p.task.bundleDir,
                rubricText: p.task.rubricText
              });
          calls++;
          runUsage = addUsage(runUsage, result.usage);
          const value: CachedVerdict = {
            verdict: result.verdict,
            rejectedFindings: result.rejectedFindings,
            usage: result.usage
          };
          putCached(p.cacheKey, value);
          const sample: SampleResult = {
            pageId: p.task.pageId,
            criterion: p.task.criterion,
            sampleIndex: p.sampleIndex,
            cached: false,
            cacheKey: p.cacheKey,
            verdict: value.verdict,
            rejectedFindings: value.rejectedFindings,
            usage: value.usage,
            evidenceManifestPath: p.task.manifestPath
          };
          samples.push(sample);
          // Persist incrementally: a killed/crashed run keeps its finished
          // judgments visible (the cache already had them; now samples/ too).
          writeSampleFile(runDir, sample);
          console.log(`[a11y-judge]   → ${value.verdict.verdict} (${value.verdict.confidence})`);
        } catch (e) {
          errors.push({
            pageId: p.task.pageId,
            criterion: p.task.criterion,
            sampleIndex: p.sampleIndex,
            message: (e as Error).message
          });
          console.log(`[a11y-judge]   → ERROR: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    }
  }

  // Write sample files (cache hits; fresh ones were written incrementally).
  for (const s of samples) {
    if (s.cached) writeSampleFile(runDir, s);
  }

  // Group by (pageId, criterion) and write majority files.
  const groups = new Map<string, SampleResult[]>();
  for (const s of samples) {
    const key = `${s.pageId}__${s.criterion}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  for (const [key, groupSamples] of groups) {
    const ordered = [...groupSamples].sort((a, b) => a.sampleIndex - b.sampleIndex);
    const values = ordered.map((s) => s.verdict.verdict);
    const mergedValue = majorityVerdict(values);
    const representative = ordered.find((s) => s.verdict.verdict === mergedValue) ?? ordered[0];
    const merged: Verdict = { ...representative.verdict, verdict: mergedValue };
    const unanimous = values.every((v) => v === values[0]);
    fs.writeFileSync(
      path.join(runDir, "majority", `${key}.json`),
      JSON.stringify(
        {
          pageId: representative.pageId,
          criterion: representative.criterion,
          samples: ordered.length,
          unanimous,
          verdict: merged,
          perSampleVerdicts: values
        },
        null,
        2
      )
    );
  }

  const finishedAt = new Date().toISOString();
  const runLog = {
    runId,
    model: JUDGE_MODEL,
    promptVersion: effectivePromptVersion,
    backend,
    evidenceDir: args.evidence,
    startedAt,
    finishedAt,
    totals: {
      calls,
      cacheHits,
      inputTokens: runUsage.inputTokens,
      outputTokens: runUsage.outputTokens,
      cacheReadInputTokens: runUsage.cacheReadInputTokens,
      cacheCreationInputTokens: runUsage.cacheCreationInputTokens,
      estimatedCostUsd: Number(estimateCost(runUsage).toFixed(4))
    },
    errors
  };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(runLog, null, 2));
  refreshLatestSymlink(runId);

  console.log(
    `[a11y-judge] ${runId} [${backend}]: ${samples.length} samples (${calls} calls, ${cacheHits} cache hits), ` +
      `${errors.length} errors, est $${runLog.totals.estimatedCostUsd}${backend === "cli" ? " (API-equivalent; CLI runs on the subscription)" : ""}. Output: ${runDir}`
  );
  if (runUsage.cacheReadInputTokens > 0) {
    console.log(`[a11y-judge] cache_read_input_tokens observed: ${runUsage.cacheReadInputTokens}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
