/**
 * Diff the axe-core baseline scans (tests/e2e/a11y-axe-baseline.spec.ts)
 * against the clean runs and score each seeded mutation.
 *
 *   npx tsx tools/a11y-judge/axe-baseline/analyze.ts --run a11y-axe-baseline/<runId>
 *
 * A mutation counts as DETECTED under a config when some (page, state) scan has
 * a violation node that appears in neither clean run. It is SC-matched when
 * that rule carries the mutation's WCAG tag (e.g. 4.1.2 -> "wcag412"). New
 * `incomplete` nodes (axe's "needs review") are reported separately: a human
 * would have to look, which is the axe analogue of the judge's needs_human.
 *
 * Writes <run>/report.md and <run>/summary.json.
 */
import fs from "fs";
import path from "path";
import { MUTATIONS, type Mutation } from "../mutations";

type Node = { target: unknown; html: string; failureSummary?: string };
type Rule = { id: string; impact?: string | null; tags: string[]; help: string; nodes: Node[] };
type Footprint = Record<string, number | boolean>;
type Scan = {
  variant: string;
  pageId: string;
  state: string;
  config: string;
  url: string;
  footprint: Footprint;
  violations: Rule[];
  incomplete: Rule[];
};

const CONFIGS = ["gate", "full", "experimental"] as const;
const CLEAN = ["clean-a", "clean-b"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const runDir = path.resolve(arg("run") ?? "a11y-axe-baseline/latest");

// scans[variant][pageId][state][config]
const scans: Record<string, Record<string, Record<string, Record<string, Scan>>>> = {};
const errors: { variant: string; pageId: string; message: string }[] = [];
for (const variant of fs.readdirSync(runDir).filter((d) => fs.statSync(path.join(runDir, d)).isDirectory())) {
  for (const pageId of fs.readdirSync(path.join(runDir, variant))) {
    const dir = path.join(runDir, variant, pageId);
    for (const file of fs.readdirSync(dir)) {
      if (file === "error.txt") {
        errors.push({ variant, pageId, message: fs.readFileSync(path.join(dir, file), "utf8").split("\n")[0] });
        continue;
      }
      const m = file.match(/^(.+)\.(gate|full|experimental)\.json$/);
      if (!m) continue;
      const scan = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Scan;
      (((scans[variant] ??= {})[pageId] ??= {})[m[1]] ??= {})[m[2]] = scan;
    }
  }
}

/** React useId tokens ("«r1a»", ":r1a:") differ between loads; keep them out of node identity. */
const normalizeTarget = (target: unknown) =>
  JSON.stringify(target)
    .replace(/«[^»]*»/g, "«id»")
    .replace(/:r[0-9a-z]+:/g, ":r:");
const nodeKey = (ruleId: string, n: Node) => `${ruleId} ${normalizeTarget(n.target)}`;
const nodeKeys = (rules: Rule[] | undefined) =>
  new Set((rules ?? []).flatMap((r) => r.nodes.map((n) => nodeKey(r.id, n))));

/** Nodes in `rules` that appear in no clean run of the same (page, state, config). */
function newNodes(rules: Rule[], pageId: string, state: string, config: string, bucket: "violations" | "incomplete") {
  const clean = new Set<string>();
  for (const c of CLEAN) for (const k of nodeKeys(scans[c]?.[pageId]?.[state]?.[config]?.[bucket])) clean.add(k);
  const out: { rule: Rule; node: Node }[] = [];
  for (const r of rules) {
    // A rule that already flickered between the clean runs here is noise, not a detection.
    if (noisyRules.has(`${pageId}/${state}/${config}/${bucket}/${r.id}`)) continue;
    for (const n of r.nodes) if (!clean.has(nodeKey(r.id, n))) out.push({ rule: r, node: n });
  }
  return out;
}

/** Did the mutation's DOM footprint differ from clean-a on this page/state? */
function tookEffect(m: Scored, pageId: string, state: string): boolean | null {
  const mut = scans[m.id]?.[pageId]?.[state]?.full?.footprint;
  const clean = scans["clean-a"]?.[pageId]?.[state]?.full?.footprint;
  if (!mut || !clean) return null;
  const n = (f: Footprint, k: string) => Number(f[k] ?? 0);
  switch (m.baseId) {
    case "111-alt-degrade":
      return n(mut, "imgAltImage") + n(mut, "svgNamedIcon") > n(clean, "imgAltImage") + n(clean, "svgNamedIcon");
    case "132-survey-options-first":
      return n(mut, "surveyQuestionsReordered") > 0;
    case "243-tabindex-shuffle":
      return n(mut, "positiveTabindex") > n(clean, "positiveTabindex");
    case "246-headings-generic":
      return n(mut, "headingsSection") > n(clean, "headingsSection");
    case "247-outline-none":
      return mut.outlineNoneStyle === true;
    case "331-hide-error-text":
      return (
        n(mut, "ariaDescribedby") < n(clean, "ariaDescribedby") || n(mut, "alertsWithText") < n(clean, "alertsWithText")
      );
    case "412-strip-labels":
      return n(mut, "iconButtonsWithoutName") > n(clean, "iconButtonsWithoutName");
    case "413-silent-toast":
      return n(mut, "liveRegions") < n(clean, "liveRegions");
    default:
      return null;
  }
}

// Noise floor: nodes that differ between the two clean runs.
const noise: string[] = [];
const noisyRules = new Set<string>();
for (const pageId of Object.keys(scans["clean-a"] ?? {})) {
  for (const state of Object.keys(scans["clean-a"][pageId])) {
    for (const config of CONFIGS) {
      for (const bucket of ["violations", "incomplete"] as const) {
        const a = nodeKeys(scans["clean-a"][pageId][state][config]?.[bucket]);
        const b = nodeKeys(scans["clean-b"]?.[pageId]?.[state]?.[config]?.[bucket]);
        const diff = [
          ...[...a].filter((k) => !b.has(k)).map((k) => ["clean-a", k]),
          ...[...b].filter((k) => !a.has(k)).map((k) => ["clean-b", k])
        ];
        for (const [which, k] of diff) {
          noisyRules.add(`${pageId}/${state}/${config}/${bucket}/${k.split(" ")[0]}`);
          if (bucket === "violations") noise.push(`${pageId}/${state}/${config}: only ${which}: ${k}`);
        }
      }
    }
  }
}

type ConfigScore = {
  detected: boolean;
  scMatched: boolean;
  newViolationRules: Record<string, { tags: string[]; pages: string[]; nodes: number }>;
  newIncompleteRules: Record<string, { pages: string[]; nodes: number }>;
};
type MutationScore = {
  id: string;
  criterion: string;
  description: string;
  pagesScanned: number;
  pagesTookEffect: number;
  byConfig: Record<string, ConfigScore>;
};

/** A registry mutation, or a spec variant of one ("<id>@<how>", e.g. re-applied after page ready). */
type Scored = Pick<Mutation, "id" | "criterion" | "description"> & { baseId: string };
const scored: Scored[] = MUTATIONS.map((m) => ({
  id: m.id,
  criterion: m.criterion,
  description: m.description,
  baseId: m.id
}));
for (const variant of Object.keys(scans).filter((v) => v.includes("@"))) {
  const [baseId, how] = variant.split("@");
  const base = MUTATIONS.find((m) => m.id === baseId);
  if (base)
    scored.push({ id: variant, criterion: base.criterion, description: `${base.description} (${how})`, baseId });
}

const results: MutationScore[] = [];
for (const m of scored) {
  const pages = scans[m.id] ?? {};
  const scTag = `wcag${m.criterion.replace(/\./g, "")}`;
  const effectPages = new Set<string>();
  const byConfig: Record<string, ConfigScore> = {};
  for (const config of CONFIGS) {
    const score: ConfigScore = { detected: false, scMatched: false, newViolationRules: {}, newIncompleteRules: {} };
    for (const [pageId, states] of Object.entries(pages)) {
      for (const [state, cfgs] of Object.entries(states)) {
        if (tookEffect(m, pageId, state)) effectPages.add(pageId);
        const scan = cfgs[config];
        if (!scan) continue;
        for (const { rule } of newNodes(scan.violations, pageId, state, config, "violations")) {
          const e = (score.newViolationRules[rule.id] ??= { tags: rule.tags, pages: [], nodes: 0 });
          e.nodes++;
          const where = `${pageId}${state === "load" ? "" : `(${state})`}`;
          if (!e.pages.includes(where)) e.pages.push(where);
          score.detected = true;
          if (rule.tags.includes(scTag)) score.scMatched = true;
        }
        for (const { rule } of newNodes(scan.incomplete, pageId, state, config, "incomplete")) {
          const e = (score.newIncompleteRules[rule.id] ??= { pages: [], nodes: 0 });
          e.nodes++;
          const where = `${pageId}${state === "load" ? "" : `(${state})`}`;
          if (!e.pages.includes(where)) e.pages.push(where);
        }
      }
    }
    byConfig[config] = score;
  }
  results.push({
    id: m.id,
    criterion: m.criterion,
    description: m.description,
    pagesScanned: Object.keys(pages).length,
    pagesTookEffect: effectPages.size,
    byConfig
  });
}

const cell = (s: ConfigScore) => {
  if (!s.detected) return Object.keys(s.newIncompleteRules).length ? "missed (needs-review only)" : "missed";
  const rules = Object.entries(s.newViolationRules)
    .map(([id, e]) => `${id}×${e.nodes}`)
    .join(", ");
  return `${s.scMatched ? "caught" : "caught, other SC"}: ${rules}`;
};

const lines: string[] = [];
lines.push(`# axe-core baseline vs seeded mutations`);
lines.push("");
lines.push(`Run: \`${path.relative(process.cwd(), runDir)}\``);
const anyScan = Object.values(scans["clean-a"] ?? {})[0];
const axeVersion = anyScan
  ? (Object.values(Object.values(anyScan)[0])[0] as unknown as { axeVersion?: string }).axeVersion
  : "?";
lines.push(`axe-core ${axeVersion}. Detection = a violation node present in neither clean run.`);
lines.push("");
lines.push("| Mutation | SC | took effect | gate (CI config) | full (no excludes) | experimental |");
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const r of results) {
  lines.push(
    `| ${r.id} | ${r.criterion} | ${r.pagesTookEffect}/${r.pagesScanned} pages | ${cell(r.byConfig.gate)} | ${cell(r.byConfig.full)} | ${cell(r.byConfig.experimental)} |`
  );
}
lines.push("");
lines.push("## New violations by mutation");
for (const r of results) {
  lines.push("");
  lines.push(`### ${r.id} (${r.criterion})`);
  lines.push(r.description);
  for (const config of CONFIGS) {
    const s = r.byConfig[config];
    const v = Object.entries(s.newViolationRules);
    const inc = Object.entries(s.newIncompleteRules);
    if (!v.length && !inc.length) continue;
    lines.push(`- **${config}**`);
    for (const [id, e] of v)
      lines.push(`  - violation \`${id}\` [${e.tags.join(", ")}]: ${e.nodes} nodes on ${e.pages.join(", ")}`);
    for (const [id, e] of inc) lines.push(`  - needs review \`${id}\`: ${e.nodes} nodes on ${e.pages.join(", ")}`);
  }
}
lines.push("");
lines.push(`## Clean-run noise floor (${noise.length} node differences between clean-a and clean-b)`);
for (const n of noise.slice(0, 40)) lines.push(`- ${n}`);
if (errors.length) {
  lines.push("");
  lines.push(`## Scan errors (${errors.length})`);
  for (const e of errors) lines.push(`- ${e.variant} / ${e.pageId}: ${e.message}`);
}

fs.writeFileSync(path.join(runDir, "report.md"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ results, noise, errors }, null, 2));
// eslint-disable-next-line no-console
console.log(lines.join("\n"));
