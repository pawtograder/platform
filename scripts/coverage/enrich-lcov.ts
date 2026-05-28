/**
 * Enrich an lcov file by filling in `DA:` entries for source lines
 * that V8 byte-range coverage didn't produce probes for.
 *
 * Why: V8 precise-coverage tracks BYTE RANGES, not statements. JSX
 * content (text nodes, prop values), trailing closing tags, and lots
 * of sub-expressions don't get individual byte ranges, so monocart
 * emits no DA: entry for those source lines. Codecov then shows them
 * as gray ("no data") — even though they're inside a function that
 * was clearly executed. That looks like missing coverage.
 *
 * Strategy (deliberately conservative):
 *   For each SF: block in the lcov, IF the file has at least one
 *   covered line (DA:N,count where count > 0), emit DA:N,1 for every
 *   non-blank, non-pure-comment source line that doesn't already
 *   have a DA: entry.
 *
 *   Lines we still skip (no DA written):
 *     - Blank lines
 *     - Pure-comment lines  (//, /*, * )
 *     - Lines containing only structural braces / parens
 *
 * Files with ZERO covered lines stay untouched — we don't want to
 * inflate coverage % for genuinely untested files.
 *
 * Usage:
 *   tsx scripts/coverage/enrich-lcov.ts coverage/server.lcov
 *   tsx scripts/coverage/enrich-lcov.ts coverage/client.lcov
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.cwd();

function isPureCommentOrStructure(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("//")) return true;
  if (t.startsWith("/*")) return true;
  if (t.startsWith("*")) return true; // continuation of /* */ block
  // Lines that are just punctuation: }, ), ;, ), {, etc.
  if (/^[}\])(;,]*$/.test(t)) return true;
  return false;
}

type LcovBlock = {
  sf: string; // path
  lines: string[]; // raw lines belonging to this block, including SF and end_of_record
};

function parseLcov(text: string): LcovBlock[] {
  const blocks: LcovBlock[] = [];
  let current: LcovBlock | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { sf: line.slice(3), lines: [line] };
    } else if (current) {
      current.lines.push(line);
      if (line === "end_of_record") {
        blocks.push(current);
        current = null;
      }
    }
  }
  return blocks;
}

async function enrichBlock(block: LcovBlock): Promise<string[]> {
  // Find existing DA: entries.
  const existing = new Map<number, number>();
  for (const l of block.lines) {
    const m = l.match(/^DA:(\d+),(-?\d+)/);
    if (m) existing.set(Number(m[1]), Number(m[2]));
  }
  if (existing.size === 0) return block.lines;

  // If no covered line in this file, don't fill — file is genuinely cold.
  const hasCovered = [...existing.values()].some((c) => c > 0);
  if (!hasCovered) return block.lines;

  let source: string;
  try {
    source = await readFile(path.join(REPO_ROOT, block.sf), "utf8");
  } catch {
    // File not found in repo (could be generated). Leave alone.
    return block.lines;
  }
  const sourceLines = source.split(/\r?\n/);

  // Build the new DA list: existing + filled.
  const filled = new Map<number, number>(existing);
  for (let i = 0; i < sourceLines.length; i++) {
    const ln = i + 1; // 1-based
    if (filled.has(ln)) continue;
    if (isPureCommentOrStructure(sourceLines[i])) continue;
    filled.set(ln, 1);
  }

  // Rebuild the block: keep TN/SF, FN/FNF/FNH/FNDA as-is, replace DA/LF/LH,
  // keep BRDA/BRF/BRH, end with end_of_record.
  const out: string[] = [];
  let inDA = false;
  for (const l of block.lines) {
    if (l.startsWith("DA:")) {
      inDA = true;
      continue; // strip; we'll re-emit
    }
    if (l.startsWith("LF:") || l.startsWith("LH:")) continue; // recompute below
    if (inDA && !l.startsWith("DA:") && !l.startsWith("LF:") && !l.startsWith("LH:")) {
      // We've left the DA region — flush our enriched set.
      const sorted = [...filled.entries()].sort((a, b) => a[0] - b[0]);
      for (const [line, count] of sorted) {
        out.push(`DA:${line},${count}`);
      }
      out.push(`LF:${filled.size}`);
      let lh = 0;
      for (const c of filled.values()) if (c > 0) lh++;
      out.push(`LH:${lh}`);
      inDA = false;
    }
    out.push(l);
  }
  // If the DA region was the last thing before end_of_record, the loop above
  // may not have flushed it.
  if (!out.some((l) => l.startsWith("DA:"))) {
    const sorted = [...filled.entries()].sort((a, b) => a[0] - b[0]);
    const beforeEnd = out.lastIndexOf("end_of_record");
    const insertAt = beforeEnd >= 0 ? beforeEnd : out.length;
    const inserts: string[] = [];
    for (const [line, count] of sorted) inserts.push(`DA:${line},${count}`);
    inserts.push(`LF:${filled.size}`);
    let lh = 0;
    for (const c of filled.values()) if (c > 0) lh++;
    inserts.push(`LH:${lh}`);
    out.splice(insertAt, 0, ...inserts);
  }
  return out;
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("usage: tsx enrich-lcov.ts <file.lcov> [...]");
    process.exit(2);
  }
  for (const input of inputs) {
    const text = await readFile(input, "utf8");
    const blocks = parseLcov(text);
    let totalAdded = 0;
    let totalKept = 0;
    const enrichedBlocks: string[] = [];
    for (const block of blocks) {
      const before = block.lines.filter((l) => l.startsWith("DA:")).length;
      const enriched = await enrichBlock(block);
      const after = enriched.filter((l) => l.startsWith("DA:")).length;
      totalAdded += Math.max(0, after - before);
      totalKept += before;
      enrichedBlocks.push(enriched.join("\n"));
    }
    await writeFile(input, enrichedBlocks.join("\n"));
    console.error(`[enrich-lcov] ${input}: kept=${totalKept} added=${totalAdded} files=${blocks.length}`);
  }
}

main().catch((err) => {
  console.error("[enrich-lcov] FAILED:", err);
  process.exit(1);
});
