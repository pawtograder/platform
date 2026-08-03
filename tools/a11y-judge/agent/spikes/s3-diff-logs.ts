/**
 * Spike S3 (THROWAWAY): diff the two seed-variant spoken logs after
 * normalization; derive the placeholder rule set for the future normalize.ts.
 *
 * Run: npx tsx tools/a11y-judge/agent/spikes/s3-diff-logs.ts
 */
import fs from "fs";
import path from "path";

const DIR = path.resolve(process.cwd(), "a11y-trajectories", "spike-s1");

type Bindings = Record<string, string>;

const NOISE = [/realtime connection/i, /connections? active/i];

function normalize(phrase: string, bindings: Bindings): string | null {
  let p = phrase;
  // 1. Seed-binding substitution (longest value first so overlaps resolve).
  for (const [key, value] of Object.entries(bindings).sort((x, y) => y[1].length - x[1].length)) {
    if (!value) continue;
    p = p.split(value).join(`{{${key}}}`);
  }
  // 2. Noise phrases vanish entirely.
  if (NOISE.some((re) => re.test(p))) return null;
  // 3. Generic dynamics.
  p = p
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi, "{{time}}")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(, \d{4})?\b/gi, "{{date}}")
    .replace(/\b\d+\b/g, "{{number}}");
  // 4. Case/whitespace.
  return p.toLowerCase().replace(/\s+/g, " ").trim();
}

function load(variant: string): { log: string[]; bindings: Bindings } {
  return {
    log: JSON.parse(fs.readFileSync(path.join(DIR, `survey-spoken-log.${variant}.json`), "utf8")),
    bindings: JSON.parse(fs.readFileSync(path.join(DIR, `bindings.${variant}.json`), "utf8"))
  };
}

// Usage: s3-diff-logs.ts [suffixA] [suffixB] — e.g. `a.r1 a.r2` for the
// Wave-1 back-to-back gate; defaults to the S3 cross-seed pair a vs b.
const a = load(process.argv[2] ?? "a");
const b = load(process.argv[3] ?? "b");

const normA = a.log.map((p) => normalize(p, a.bindings)).filter((p): p is string => p !== null);
const normB = b.log.map((p) => normalize(p, b.bindings)).filter((p): p is string => p !== null);

console.log(`raw lengths: a=${a.log.length} b=${b.log.length}`);
console.log(`normalized lengths: a=${normA.length} b=${normB.length}`);

let mismatches = 0;
const max = Math.max(normA.length, normB.length);
for (let i = 0; i < max; i++) {
  if (normA[i] !== normB[i]) {
    mismatches++;
    if (mismatches <= 20) {
      console.log(
        `#${i}\n  a: ${JSON.stringify(normA[i] ?? "<missing>")}\n  b: ${JSON.stringify(normB[i] ?? "<missing>")}`
      );
    }
  }
}
console.log(
  mismatches === 0 ? "S3 GATE: PASS — normalized logs identical" : `S3 GATE: FAIL — ${mismatches} mismatches`
);
process.exit(mismatches === 0 ? 0 : 1);
