/**
 * Self-contained HTML report renderer for a11y-judge verdicts.
 *
 * EXTRACTABLE CORE: imports only node builtins. No template engine, no bundler —
 * the report is assembled from hand-rolled HTML template strings and emitted as
 * ONE self-contained file (all CSS inline, all cited screenshots inlined as
 * base64 data URIs). It reads the verdict directory produced by the judge
 * (agent 2D) DEFENSIVELY: every field is optional and tolerated-missing, so a
 * partial or in-progress sweep still renders.
 *
 * Verdict-directory contract (read-only; local reader types below mirror it):
 *   run.json                         run metadata + usage/cost totals
 *   majority/<pageId>__<crit>.json   merged majority verdict per (page, criterion)
 *   samples/<pageId>__<crit>__s<i>.json   individual sample verdicts
 *
 * SECURITY: all model-generated text (rationales, findings, fixes) is untrusted
 * and HTML-entity-escaped before insertion. Image alt text is derived only from
 * trusted manifest metadata (attachment role + probeId).
 */
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Local reader types — the verdict schema lives in schema/verdict.ts (agent 2D)
// which may not exist yet, so we DO NOT import it. Everything is optional.
// ---------------------------------------------------------------------------

type VerdictValue = "pass" | "fail" | "needs_human" | string;

interface ElementPointer {
  selector?: string;
  testId?: string;
  ariaName?: string;
}

interface Finding {
  summary?: string;
  severity?: number | string;
  evidenceRefs?: string[];
  elementPointer?: string | ElementPointer;
  suggestedFix?: string;
}

interface Verdict {
  criterion?: string;
  verdict?: VerdictValue;
  confidence?: string;
  rationale?: string;
  findings?: Finding[];
  evidenceGaps?: string[];
  requestedProbes?: string[];
}

interface SampleFile {
  pageId?: string;
  criterion?: string;
  sampleIndex?: number;
  cached?: boolean;
  verdict?: Verdict;
  rejectedFindings?: unknown[];
  usage?: Record<string, unknown>;
  evidenceManifestPath?: string;
}

interface MajorityFile {
  pageId?: string;
  criterion?: string;
  samples?: number;
  unanimous?: boolean;
  /** The judge writes the full merged Verdict object; a bare enum string is also tolerated. */
  verdict?: Verdict | VerdictValue;
  perSampleVerdicts?: VerdictValue[];
}

interface RunTotals {
  calls?: number;
  cacheHits?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

interface RunFile {
  runId?: string;
  model?: string;
  promptVersion?: string;
  evidenceDir?: string;
  startedAt?: string;
  finishedAt?: string;
  totals?: RunTotals;
  errors?: unknown[];
}

/** Minimal projection of an EvidenceBundle manifest we need for image inlining. */
interface ManifestAttachment {
  file?: string;
  sha256?: string;
  mime?: string;
  role?: string;
  probeId?: string | null;
}
interface Manifest {
  attachments?: ManifestAttachment[];
}

export interface RenderReportOptions {
  verdictsDir: string;
  evidenceDir: string;
  /** When provided, the assembled HTML is also written to this path. */
  outFile?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTML-entity-escape untrusted text before inserting into markup. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Cell key = `${pageId}|${criterion}`. */
function cellKey(pageId: string, criterion: string): string {
  return `${pageId}|${criterion}`;
}

/**
 * Normalize a majority `verdict` field to the bare enum string. The judge
 * writes the full merged Verdict object into majority files; older or foreign
 * producers may write the string directly. Anything else renders as missing.
 */
function verdictValueOf(v: Verdict | VerdictValue | undefined | null): VerdictValue | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.verdict === "string") return v.verdict;
  return undefined;
}

/** Render an elementPointer (object or legacy string) as compact text. */
function formatElementPointer(pointer: string | ElementPointer): string {
  if (typeof pointer === "string") return pointer;
  const parts: string[] = [];
  if (pointer.testId) parts.push(`testId=${pointer.testId}`);
  if (pointer.selector) parts.push(pointer.selector);
  if (pointer.ariaName) parts.push(`name="${pointer.ariaName}"`);
  return parts.join(" · ");
}

const VERDICT_LABEL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  needs_human: "NEEDS HUMAN"
};

function verdictClass(verdict: VerdictValue | undefined): string {
  if (verdict === "pass") return "v-pass";
  if (verdict === "fail") return "v-fail";
  if (verdict === "needs_human") return "v-human";
  return "v-missing";
}

function verdictLabel(verdict: VerdictValue | undefined): string {
  if (!verdict) return "—";
  return VERDICT_LABEL[verdict] ?? String(verdict);
}

/**
 * Resolve an evidenceRef to a data URI by looking it up in the bundle manifest
 * referenced by a sample. Matches the ref against attachment `file` (its id).
 * Returns `null` silently if the manifest or file is missing.
 */
function resolveEvidenceImage(
  ref: string,
  manifestPath: string | undefined,
  evidenceDir: string,
  verdictsDir: string
): { dataUri: string; alt: string } | null {
  if (!manifestPath) return null;
  const manifestCandidates = [
    manifestPath,
    path.resolve(evidenceDir, manifestPath),
    path.resolve(verdictsDir, manifestPath)
  ];
  let manifestFile: string | null = null;
  let manifest: Manifest | null = null;
  for (const candidate of manifestCandidates) {
    const parsed = readJson<Manifest>(candidate);
    if (parsed) {
      manifestFile = candidate;
      manifest = parsed;
      break;
    }
  }
  if (!manifest || !manifestFile || !Array.isArray(manifest.attachments)) return null;
  const attachment = manifest.attachments.find((a) => a.file === ref || a.sha256 === ref);
  if (!attachment || !attachment.file) return null;

  const manifestDir = path.dirname(manifestFile);
  const imageCandidates = [path.resolve(manifestDir, attachment.file), path.resolve(evidenceDir, attachment.file)];
  for (const imagePath of imageCandidates) {
    try {
      const buffer = fs.readFileSync(imagePath);
      const mime = attachment.mime || "image/png";
      const alt = `${attachment.role ?? "evidence"}${attachment.probeId ? ` (${attachment.probeId})` : ""}`;
      return { dataUri: `data:${mime};base64,${buffer.toString("base64")}`, alt };
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 1.5rem;
  line-height: 1.5; color: #1a1a1a; background: #fafafa; }
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 0.75rem; border-bottom: 2px solid #ddd; padding-bottom: 0.25rem; }
h3 { font-size: 1rem; margin: 0.5rem 0 0.25rem; }
.meta { color: #555; font-size: 0.9rem; }
.meta dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1rem; margin: 0.5rem 0; }
.meta dt { font-weight: 600; }
.meta dd { margin: 0; }
table.matrix { border-collapse: collapse; margin: 0.5rem 0 1rem; }
table.matrix th, table.matrix td { border: 1px solid #ccc; padding: 0.4rem 0.55rem; text-align: center;
  font-size: 0.85rem; white-space: nowrap; }
table.matrix th { background: #f0f0f0; }
table.matrix th.rowhead { text-align: left; background: #f7f7f7; }
.cell { font-weight: 600; }
.v-pass { background: #d7f3dd; color: #14532d; }
.v-fail { background: #fbd8d8; color: #7f1d1d; }
.v-human { background: #fdeecb; color: #7c5a12; }
.v-missing { background: #ececec; color: #777; }
.nonunanimous { font-weight: 400; }
.card { border: 1px solid #ccc; border-radius: 6px; margin: 0.5rem 0; background: #fff; }
.card > summary { cursor: pointer; padding: 0.5rem 0.75rem; font-weight: 600; list-style: none; }
.card > summary::-webkit-details-marker { display: none; }
.card[open] > summary { border-bottom: 1px solid #eee; }
.card .body { padding: 0.5rem 0.85rem 0.85rem; }
.pill { display: inline-block; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.75rem;
  font-weight: 700; vertical-align: middle; }
.finding { border-left: 3px solid #ccc; padding: 0.25rem 0.6rem; margin: 0.5rem 0; background: #fafafa; }
.sev { display: inline-block; padding: 0.02rem 0.4rem; border-radius: 4px; font-size: 0.72rem; font-weight: 700;
  background: #444; color: #fff; }
.rationale { white-space: pre-wrap; background: #f6f6f6; padding: 0.4rem 0.6rem; border-radius: 4px; }
.evrefs img { max-width: 340px; max-height: 260px; border: 1px solid #bbb; border-radius: 4px; margin: 0.3rem 0.3rem 0 0; }
.muted { color: #666; font-size: 0.85rem; }
ul.tight { margin: 0.2rem 0; padding-left: 1.2rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem;
  background: #eee; padding: 0.05rem 0.3rem; border-radius: 3px; }
footer { margin-top: 2.5rem; padding-top: 0.75rem; border-top: 2px solid #ddd; color: #555; font-size: 0.85rem; }
`;

function renderSeverity(severity: number | string | undefined): string {
  if (severity === undefined || severity === null || severity === "") return "";
  return `<span class="sev">sev ${esc(severity)}</span> `;
}

function renderFindings(
  findings: Finding[] | undefined,
  manifestPath: string | undefined,
  evidenceDir: string,
  verdictsDir: string
): string {
  if (!findings || findings.length === 0) return `<p class="muted">No findings.</p>`;
  return findings
    .map((finding) => {
      const refs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : [];
      const images = refs
        .map((ref) => resolveEvidenceImage(ref, manifestPath, evidenceDir, verdictsDir))
        .filter((r): r is { dataUri: string; alt: string } => r !== null)
        .map((img) => `<img src="${img.dataUri}" alt="${esc(img.alt)}" />`)
        .join("");
      const pointerText = finding.elementPointer ? formatElementPointer(finding.elementPointer) : "";
      const pointer = pointerText ? `<div class="muted">Element: <code>${esc(pointerText)}</code></div>` : "";
      const fix = finding.suggestedFix ? `<div><strong>Suggested fix:</strong> ${esc(finding.suggestedFix)}</div>` : "";
      const refList =
        refs.length > 0 ? `<div class="muted">Refs: ${refs.map((r) => `<code>${esc(r)}</code>`).join(" ")}</div>` : "";
      return `<div class="finding">
        <div>${renderSeverity(finding.severity)}${esc(finding.summary) || '<span class="muted">(no summary)</span>'}</div>
        ${pointer}
        ${fix}
        ${refList}
        ${images ? `<div class="evrefs">${images}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderList(label: string, items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lis = items.map((item) => `<li>${esc(item)}</li>`).join("");
  return `<div><strong>${esc(label)}:</strong><ul class="tight">${lis}</ul></div>`;
}

function renderCard(
  pageId: string,
  criterion: string,
  majority: MajorityFile | undefined,
  samples: SampleFile[],
  evidenceDir: string,
  verdictsDir: string
): string {
  const mergedVerdict = verdictValueOf(majority?.verdict);
  const unanimous = majority?.unanimous;
  const perSample =
    majority?.perSampleVerdicts && majority.perSampleVerdicts.length > 0
      ? majority.perSampleVerdicts
      : samples.map((s) => s.verdict?.verdict).filter((v): v is string => Boolean(v));
  // Prefer a sample verdict for the rich detail (rationale/findings).
  const detail = samples.find((s) => s.verdict?.verdict === mergedVerdict)?.verdict ?? samples[0]?.verdict;
  const detailSample = samples.find((s) => s.verdict?.verdict === mergedVerdict) ?? samples[0];

  const unanimityBadge =
    unanimous === false ? `<span class="pill v-human" title="Samples disagreed">○ non-unanimous</span>` : "";

  const perSampleLine =
    perSample.length > 0
      ? `<div class="muted">Per-sample: ${perSample
          .map((v) => `<span class="pill ${verdictClass(v)}">${esc(verdictLabel(v))}</span>`)
          .join(" ")}</div>`
      : "";

  const sampleBlocks = samples
    .map((sample) => {
      const v = sample.verdict;
      if (!v) return "";
      const cachedTag = sample.cached ? ` <span class="muted">(cached)</span>` : "";
      const rejected = Array.isArray(sample.rejectedFindings) ? sample.rejectedFindings.length : 0;
      const rejectedTag = rejected > 0 ? ` · <span class="muted">${rejected} rejected finding(s)</span>` : "";
      return `<details class="card">
        <summary>Sample ${esc(sample.sampleIndex ?? "?")}: <span class="pill ${verdictClass(v.verdict)}">${esc(
          verdictLabel(v.verdict)
        )}</span> <span class="muted">conf: ${esc(v.confidence ?? "?")}</span>${cachedTag}${rejectedTag}</summary>
        <div class="body">
          ${v.rationale ? `<div class="rationale">${esc(v.rationale)}</div>` : ""}
          <h3>Findings</h3>
          ${renderFindings(v.findings, sample.evidenceManifestPath, evidenceDir, verdictsDir)}
          ${renderList("Evidence gaps", v.evidenceGaps)}
          ${renderList("Requested probes", v.requestedProbes)}
        </div>
      </details>`;
    })
    .join("");

  return `<details class="card" id="cell-${esc(pageId)}-${esc(criterion)}">
    <summary>
      <span class="pill ${verdictClass(mergedVerdict)}">${esc(verdictLabel(mergedVerdict))}</span>
      <code>${esc(pageId)}</code> × <code>${esc(criterion)}</code> ${unanimityBadge}
    </summary>
    <div class="body">
      <div class="meta"><dl>
        <dt>Merged verdict</dt><dd>${esc(verdictLabel(mergedVerdict))}</dd>
        <dt>Confidence</dt><dd>${esc(detail?.confidence ?? "—")}</dd>
        <dt>Samples</dt><dd>${esc(majority?.samples ?? samples.length)}</dd>
        <dt>Unanimous</dt><dd>${unanimous === undefined ? "—" : esc(String(unanimous))}</dd>
      </dl></div>
      ${perSampleLine}
      ${detail?.rationale ? `<h3>Rationale</h3><div class="rationale">${esc(detail.rationale)}</div>` : ""}
      <h3>Findings</h3>
      ${renderFindings(detail?.findings, detailSample?.evidenceManifestPath, evidenceDir, verdictsDir)}
      ${renderList("Evidence gaps", detail?.evidenceGaps)}
      ${renderList("Requested probes", detail?.requestedProbes)}
      <h3>Per-sample detail</h3>
      ${sampleBlocks || `<p class="muted">No sample files found.</p>`}
    </div>
  </details>`;
}

/**
 * Assemble the full self-contained HTML report and (optionally) write it to
 * `options.outFile`. Returns the HTML string. Exported for unit testing.
 */
export function renderReport(options: RenderReportOptions): string {
  const { verdictsDir, evidenceDir } = options;
  const run = readJson<RunFile>(path.join(verdictsDir, "run.json")) ?? {};

  // Load majority + sample files.
  const majorityDir = path.join(verdictsDir, "majority");
  const samplesDir = path.join(verdictsDir, "samples");

  const majorities = new Map<string, MajorityFile>();
  for (const file of readDirSafe(majorityDir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = readJson<MajorityFile>(path.join(majorityDir, file));
    if (!parsed) continue;
    const pageId = parsed.pageId ?? file.replace(/\.json$/, "").split("__")[0] ?? "";
    const criterion = parsed.criterion ?? file.replace(/\.json$/, "").split("__")[1] ?? "";
    majorities.set(cellKey(pageId, criterion), { ...parsed, pageId, criterion });
  }

  const samplesByCell = new Map<string, SampleFile[]>();
  for (const file of readDirSafe(samplesDir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = readJson<SampleFile>(path.join(samplesDir, file));
    if (!parsed) continue;
    const base = file.replace(/\.json$/, "").split("__");
    const pageId = parsed.pageId ?? base[0] ?? "";
    const criterion = parsed.criterion ?? base[1] ?? "";
    const key = cellKey(pageId, criterion);
    const list = samplesByCell.get(key) ?? [];
    list.push({ ...parsed, pageId, criterion });
    samplesByCell.set(key, list);
  }
  for (const list of samplesByCell.values()) {
    list.sort((a, b) => (a.sampleIndex ?? 0) - (b.sampleIndex ?? 0));
  }

  // Axes: union of pageIds and criteria across majority + sample files.
  const pageIds = new Set<string>();
  const criteria = new Set<string>();
  const allKeys = new Set<string>([...majorities.keys(), ...samplesByCell.keys()]);
  for (const key of allKeys) {
    const [pageId, criterion] = key.split("|");
    if (pageId) pageIds.add(pageId);
    if (criterion) criteria.add(criterion);
  }
  const sortedPages = [...pageIds].sort();
  const sortedCriteria = [...criteria].sort();

  // Matrix.
  const headerCells = sortedCriteria.map((c) => `<th scope="col">${esc(c)}</th>`).join("");
  const matrixRows = sortedPages
    .map((pageId) => {
      const cells = sortedCriteria
        .map((criterion) => {
          const majority = majorities.get(cellKey(pageId, criterion));
          const verdict = verdictValueOf(majority?.verdict);
          const marker =
            majority?.unanimous === false ? ` <span class="nonunanimous" title="non-unanimous">○</span>` : "";
          const anchor = `#cell-${esc(pageId)}-${esc(criterion)}`;
          const inner = majority
            ? `<a href="${anchor}" style="color:inherit;text-decoration:none">${esc(verdictLabel(verdict))}${marker}</a>`
            : esc(verdictLabel(verdict));
          return `<td class="cell ${verdictClass(verdict)}">${inner}</td>`;
        })
        .join("");
      return `<tr><th scope="row" class="rowhead">${esc(pageId)}</th>${cells}</tr>`;
    })
    .join("");

  const matrix = `<table class="matrix">
    <thead><tr><th scope="col">Page \\ Criterion</th>${headerCells}</tr></thead>
    <tbody>${matrixRows || `<tr><td class="muted">No verdicts found.</td></tr>`}</tbody>
  </table>`;

  // Per-cell cards.
  const cards = sortedPages
    .flatMap((pageId) =>
      sortedCriteria
        .filter((criterion) => allKeys.has(cellKey(pageId, criterion)))
        .map((criterion) => {
          const key = cellKey(pageId, criterion);
          return renderCard(
            pageId,
            criterion,
            majorities.get(key),
            samplesByCell.get(key) ?? [],
            evidenceDir,
            verdictsDir
          );
        })
    )
    .join("");

  const totals = run.totals ?? {};
  const errorsCount = Array.isArray(run.errors) ? run.errors.length : 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>a11y-judge report${run.runId ? ` — ${esc(run.runId)}` : ""}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>a11y-judge — WCAG 2.1 AA verdict report</h1>
  <div class="meta">
    <dl>
      <dt>Run id</dt><dd>${esc(run.runId ?? "—")}</dd>
      <dt>Model</dt><dd>${esc(run.model ?? "—")}</dd>
      <dt>Prompt version</dt><dd>${esc(run.promptVersion ?? "—")}</dd>
      <dt>Evidence dir</dt><dd><code>${esc(run.evidenceDir ?? evidenceDir)}</code></dd>
      <dt>Started</dt><dd>${esc(run.startedAt ?? "—")}</dd>
      <dt>Finished</dt><dd>${esc(run.finishedAt ?? "—")}</dd>
      <dt>Errors</dt><dd>${esc(errorsCount)}</dd>
    </dl>
  </div>
</header>

<main>
  <h2>Verdict matrix</h2>
  <p class="muted">Legend:
    <span class="pill v-pass">PASS</span>
    <span class="pill v-fail">FAIL</span>
    <span class="pill v-human">NEEDS HUMAN</span>
    <span class="pill v-missing">missing</span>
    — ○ marks a non-unanimous majority.</p>
  ${matrix}

  <h2>Per-cell verdicts</h2>
  ${cards || `<p class="muted">No verdict cells to display.</p>`}
</main>

<footer>
  <strong>Usage &amp; cost:</strong>
  ${esc(totals.calls ?? 0)} calls ·
  ${esc(totals.cacheHits ?? 0)} cache hits ·
  ${esc(totals.inputTokens ?? 0)} input tokens ·
  ${esc(totals.outputTokens ?? 0)} output tokens ·
  estimated cost $${esc(typeof totals.estimatedCostUsd === "number" ? totals.estimatedCostUsd.toFixed(4) : (totals.estimatedCostUsd ?? "0"))}
</footer>
</body>
</html>`;

  if (options.outFile) {
    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    fs.writeFileSync(options.outFile, html);
  }
  return html;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { verdicts: string; evidence: string; out?: string } {
  const opts: { verdicts: string; evidence: string; out?: string } = {
    verdicts: "a11y-verdicts/latest",
    evidence: "a11y-evidence/latest"
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verdicts") opts.verdicts = argv[++i];
    else if (arg === "--evidence") opts.evidence = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
  }
  return opts;
}

function isMain(): boolean {
  // Works whether executed via tsx (process.argv[1] is this file) or imported.
  const entry = process.argv[1] ?? "";
  return entry.includes("render.ts") || entry.includes("render.js");
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const outFile = args.out ?? path.join(args.verdicts, "report.html");
  renderReport({ verdictsDir: args.verdicts, evidenceDir: args.evidence, outFile });
  process.stdout.write(`Wrote a11y-judge report to ${outFile}\n`);
}
