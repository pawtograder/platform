/* eslint-disable no-console */
/**
 * Runs the built binary the way a user would.
 *
 * This is wired into `prepublishOnly` because the failure modes of bundling a
 * CLI are all invisible to `tsc`: an unresolved `@/cli/*` alias, a missing
 * shebang, a dependency that got externalized but not declared, or a stale
 * `dist/` from before the last version bump. Each of those produces a package
 * that installs cleanly and then throws on first run.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "dist/pawtograder.js");
const pkg = JSON.parse(await readFile(resolve(here, "package.json"), "utf8"));

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

console.log(`smoke-testing ${bin}`);

const bundle = await readFile(bin, "utf8");
check("starts with a node shebang", bundle.startsWith("#!/usr/bin/env node"));
check(
  "no unresolved @/cli alias survived bundling",
  !bundle.includes('require("@/cli'),
  "esbuild alias config did not cover every import"
);
check(
  "does not pull in dotenv",
  !bundle.includes('require("dotenv")'),
  "the published entry should not read .env files"
);

// Every bare require in the bundle must be a node builtin or a declared dependency.
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const required = new Set();
for (const match of bundle.matchAll(/require\("([^"./][^"]*)"\)/g)) {
  required.add(match[1]);
}
const undeclared = [...required].filter((id) => {
  if (id.startsWith("node:")) return false;
  const root = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
  if (declared.has(root)) return false;
  // Node builtins used without the node: prefix.
  return !builtinModules.includes(root);
});
check("all external requires are declared dependencies", undeclared.length === 0, undeclared.join(", "));

async function runBin(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { cwd: here });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const version = await runBin(["--version"]);
check("--version exits 0", version.code === 0, version.stderr.trim());
check(
  "--version reports the package version",
  version.stdout.trim() === pkg.version,
  `got "${version.stdout.trim()}", expected "${pkg.version}"`
);

const help = await runBin(["--help"]);
check("--help exits 0", help.code === 0, help.stderr.trim());
for (const group of [
  "classes",
  "assignments",
  "surveys",
  "flashcards",
  "rubrics",
  "submissions",
  "help-requests",
  "discussions",
  "reviews",
  "repos",
  "assessment"
]) {
  check(`--help lists the ${group} group`, help.stdout.includes(group));
}

// Exercises a nested command module end to end: if the alias or a command
// import were broken, building the subcommand's options would throw.
const assignHelp = await runBin(["reviews", "assign", "--help"]);
check("reviews assign --help exits 0", assignHelp.code === 0, assignHelp.stderr.trim());
check("reviews assign declares --due-date", assignHelp.stdout.includes("--due-date"));
check("reviews assign declares --by-part", assignHelp.stdout.includes("by-part"));
check(
  "reviews assign declares --include-non-submitters",
  assignHelp.stdout.includes("include-non-submitters"),
  assignHelp.stdout
);

const listHelp = await runBin(["submissions", "list", "--help"]);
check("submissions list --help exits 0", listHelp.code === 0, listHelp.stderr.trim());
check("submissions list offers --json", listHelp.stdout.includes("--json"));

const noArgs = await runBin([]);
check("bare invocation exits non-zero", noArgs.code !== 0);
check(
  "bare invocation explains that a command is required",
  `${noArgs.stdout}${noArgs.stderr}`.includes("You must specify a command")
);

const bogus = await runBin(["definitely-not-a-command"]);
check("unknown command exits non-zero", bogus.code !== 0);

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke test(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall smoke tests passed");
