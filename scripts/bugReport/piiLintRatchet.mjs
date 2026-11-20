// Ratchet for the `pii/pii-render` lint rule (bug reporter, package 4b). Runs the typed lint pass in
// eslint.pii.config.mjs and fails only when the violation count rises above the baseline in
// eslint-rules/pii-baseline.json. The rule stays in warn mode; existing violations are the baseline.
//
//   npm run lint:pii               check against the baseline (CI)
//   npm run lint:pii -- --list     also print each violation
//   npm run lint:pii -- --update   rewrite the baseline to the current count (after fixing some)
import { ESLint } from "eslint";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PII_LINT_FILES } from "../../eslint.pii.config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.join(ROOT, "eslint-rules/pii-baseline.json");
const RULE = "pii/pii-render";

const args = new Set(process.argv.slice(2));
const started = Date.now();
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, "eslint.pii.config.mjs") });
const results = await eslint.lintFiles(PII_LINT_FILES);

let count = 0;
const byMessage = {};
const byFile = {};
const fatal = [];
for (const result of results) {
  const file = path.relative(ROOT, result.filePath);
  for (const m of result.messages) {
    if (m.ruleId === RULE) {
      count++;
      byMessage[m.messageId] = (byMessage[m.messageId] ?? 0) + 1;
      byFile[file] = (byFile[file] ?? 0) + 1;
      if (args.has("--list")) console.log(`${file}:${m.line}:${m.column} ${m.messageId}: ${m.message}`);
    } else if (m.fatal || m.severity === 2) {
      fatal.push(`${file}:${m.line}:${m.column} ${m.message}`);
    }
  }
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (fatal.length > 0) {
  console.error(`pii lint could not check ${fatal.length} location(s):\n  ${fatal.join("\n  ")}`);
  process.exit(1);
}

if (args.has("--update")) {
  const sortedFiles = Object.fromEntries(
    Object.keys(byFile)
      .sort()
      .map((f) => [f, byFile[f]])
  );
  const baseline = {
    about:
      "Violation count of the pii/pii-render lint rule (eslint-rules/pii-render.js). CI fails when the count rises above `count`. Lower it with `npm run lint:pii -- --update` after fixing violations; never raise it to let a new one in.",
    count,
    byMessage,
    byFile: sortedFiles
  };
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(
    `pii lint: wrote baseline ${count} to ${path.relative(ROOT, BASELINE)} (${results.length} files, ${seconds}s)`
  );
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const summary = `pii lint: ${count} violation(s), baseline ${baseline.count} (${JSON.stringify(byMessage)}; ${results.length} files, ${seconds}s)`;
if (count > baseline.count) {
  const grew = Object.keys(byFile)
    .filter((f) => byFile[f] > (baseline.byFile?.[f] ?? 0))
    .map((f) => `${f}: ${baseline.byFile?.[f] ?? 0} -> ${byFile[f]}`);
  console.error(
    `${summary}\nThe count rose above the baseline. Files with more violations than before:\n  ${grew.join("\n  ")}`
  );
  console.error(
    "Run `npm run lint:pii -- --list` to see each one. Wrap free text and grades in <ReportBlock>, and keep classified values out of data-report-unmask elements."
  );
  process.exit(1);
}
console.log(summary);
if (count < baseline.count) {
  console.log(
    `The count fell below the baseline; lower it with \`npm run lint:pii -- --update\` so it cannot creep back.`
  );
}
