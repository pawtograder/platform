/* eslint-disable no-console */
/**
 * Checks the committed taint trace output against the privacy classification (package 2a):
 *
 *   npx tsx scripts/bugReport/checkTrace.ts            # fail on unclassified flows or unmasked PII
 *   npx tsx scripts/bugReport/checkTrace.ts --sinks    # also list components rendering free_text/grade
 *
 * Regenerate the inputs with a trace run: `BUG_REPORT_TRACE=1 npx playwright test ...`
 * (see tests/e2e/bugReport/traceFixture.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  blockCandidates,
  checkObserved,
  checkSinks,
  isBlocking,
  type ObservedFlow,
  type PiiSinks
} from "../../lib/bugReport/traceCheck";

const root = path.resolve(__dirname, "..", "..");
const observed = JSON.parse(
  readFileSync(path.join(root, "lib/bugReport/generated/privacy.observed.json"), "utf8")
) as ObservedFlow[];
const sinks = JSON.parse(readFileSync(path.join(root, "lib/bugReport/generated/pii-sinks.json"), "utf8")) as PiiSinks;

const failures = [...checkObserved(observed), ...checkSinks(sinks)];
const blocking = failures.filter(isBlocking);
const warnings = failures.filter((f) => !isBlocking(f));

console.log(`${observed.length} observed flows, ${Object.keys(sinks).length} routes with sinks`);
for (const w of warnings) console.log(`warning: ${w.message}`);
for (const f of blocking) console.log(`FAIL: ${f.message}`);
if (process.argv.includes("--sinks")) {
  console.log("\nComponents rendering free_text or grade (candidates for <ReportBlock>):");
  for (const c of blockCandidates(sinks))
    console.log(`  ${c.component}: ${c.kinds.join(", ")} (${c.routes.length} routes)`);
}
process.exit(blocking.length > 0 ? 1 : 0);
