/**
 * What's New suggestion script (docs/prd-whats-new-bot.md). The author of a PR that users will
 * notice runs it on their own machine:
 *
 *   npm run whats-new                  # the PR for the current branch
 *   npm run whats-new -- --pr 1287     # any PR, open or merged
 *   npm run whats-new -- --write       # also save the draft under lib/whatsNew/entries/
 *   npm run whats-new -- --force       # ask Claude even when the pre-filter would skip the PR
 *
 * It reads the PR with the gh CLI, runs the pre-filter, asks Claude through the author's own
 * `claude` CLI login whether the PR needs a walkthrough, and prints the decision and a draft entry
 * file. It posts nothing to GitHub.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { COURSE_FEATURES } from "../../lib/courseFeatures";
import { decide } from "./model";
import { diffForFiles, prefilter } from "./prefilter";
import { idKey, renderEntryFile, slugify } from "./render";

/* eslint-disable no-console */

/** Diff characters sent to the model. Larger diffs are cut at a file boundary, and the cut is reported. */
const MAX_DIFF_CHARS = 120_000;

type PrView = {
  number: number;
  title: string;
  body: string;
  mergedAt: string | null;
  labels: { name: string }[];
  files: { path: string }[];
};

function parseArgs(argv: string[]) {
  const prIndex = argv.indexOf("--pr");
  const pr = prIndex >= 0 ? Number(argv[prIndex + 1]) : null;
  if (pr !== null && (!Number.isInteger(pr) || pr <= 0))
    throw new Error("Usage: suggest.ts [--pr <number>] [--write] [--force]");
  return { pr, write: argv.includes("--write"), force: argv.includes("--force") };
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Cuts the diff at the last file boundary before `max` characters. */
function capDiff(diff: string, max: number): { diff: string; cut: boolean } {
  if (diff.length <= max) return { diff, cut: false };
  const boundary = diff.lastIndexOf("\ndiff --git ", max);
  return { diff: diff.slice(0, boundary > 0 ? boundary + 1 : max), cut: true };
}

async function main() {
  const { pr, write, force } = parseArgs(process.argv.slice(2));
  // Without a number, gh picks the PR for the current branch.
  const prArg = pr === null ? [] : [String(pr)];
  const view = JSON.parse(gh(["pr", "view", ...prArg, "--json", "number,title,body,mergedAt,labels,files"])) as PrView;

  const filter = prefilter({
    title: view.title,
    labels: view.labels.map((label) => label.name),
    files: view.files.map((file) => file.path)
  });
  console.log(`#${view.number} ${view.title}`);
  if (!filter.send && !force) {
    console.log(`Pre-filter: skip (${filter.reason}). No model call. Add --force to ask Claude anyway.`);
    return;
  }
  // With --force and no UI files, Claude sees the whole diff, such as a migration that changes
  // what users can see (#1275).
  const files = filter.matchedFiles.length > 0 ? filter.matchedFiles : view.files.map((file) => file.path);
  console.log(
    filter.send
      ? `Pre-filter: send. ${files.length} matched file(s):`
      : `Pre-filter: skip (${filter.reason}), sent anyway because of --force:`
  );
  for (const file of files) console.log(`  ${file}`);

  const { diff, cut } = capDiff(diffForFiles(gh(["pr", "diff", String(view.number)]), files), MAX_DIFF_CHARS);
  if (cut) console.log(`The matched diff is longer than ${MAX_DIFF_CHARS} characters; the model sees the first part.`);

  // Run from the repository root, as the npm scripts are.
  const repoRoot = process.cwd();
  let decision;
  try {
    decision = await decide({ number: view.number, title: view.title, body: view.body, diff }, repoRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Model: the claude CLI isn't installed. Install Claude Code and run `claude` once to sign in.");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`\nDecision: ${decision.significant ? "significant" : "not significant"}`);
  console.log(`Reason: ${decision.reason}`);
  if (!decision.significant) return;
  if (decision.feature && !(Object.values(COURSE_FEATURES) as string[]).includes(decision.feature)) {
    console.log(`Feature "${decision.feature}" is not in COURSE_FEATURES, so the entry has none.`);
    decision.feature = null;
  }

  const slug = slugify(decision.title.replace(/^new(\s+in\s+[^:]+)?:\s*/i, ""));
  const mergedAt = view.mergedAt ? new Date(view.mergedAt) : new Date();
  console.log(`Audience: ${decision.audience}, page: ${decision.page}, feature: ${decision.feature ?? "none"}`);
  const file = renderEntryFile(decision, { slug, prNumber: view.number, mergedAt });
  const relative = `lib/whatsNew/entries/${slug}.tsx`;
  if (!write) {
    console.log(`\n--- ${relative} ---\n`);
    console.log(file);
    console.log("Run again with --write to save this draft.");
    return;
  }
  const target = path.join(repoRoot, relative);
  if (fs.existsSync(target)) throw new Error(`${relative} already exists. Move it, or pick a different title.`);
  fs.writeFileSync(target, file);
  console.log(`\nWrote ${relative}. To finish it:`);
  console.log(`  1. Add ${idKey(slug)}: "${slug}:v1" to WHATS_NEW_IDS in lib/whatsNew/ids.ts.`);
  console.log("  2. Add the entry to WHATS_NEW_ENTRIES in lib/whatsNew/registry.ts.");
  console.log("  3. Replace each TODO preview, and check every point against the real UI.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
