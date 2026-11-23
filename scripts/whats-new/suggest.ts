/**
 * What's New suggestion bot, build steps 1 and 2 of docs/prd-whats-new-bot.md.
 *
 *   npx tsx scripts/whats-new/suggest.ts --pr 1287 --dry-run
 *
 * Reads the PR with the gh CLI, runs the pre-filter, asks claude-sonnet-5-5 whether the PR needs a
 * walkthrough, and prints the decision and the entry file it would generate. It posts nothing:
 * --dry-run is required until the workflow (build step 3) exists. The model call needs
 * ANTHROPIC_API_KEY (or another credential the Anthropic SDK reads).
 */
import { execFileSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { COURSE_FEATURES } from "../../lib/courseFeatures";
import { decide, RefusalError } from "./model";
import { diffForFiles, prefilter } from "./prefilter";
import { renderEntryFile, slugify } from "./render";

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
  const pr = prIndex >= 0 ? Number(argv[prIndex + 1]) : NaN;
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("Usage: suggest.ts --pr <number> --dry-run");
  if (!argv.includes("--dry-run")) {
    throw new Error("Only --dry-run exists so far. Posting comments and draft PRs is build step 3 and 4.");
  }
  return { pr };
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
  const { pr } = parseArgs(process.argv.slice(2));
  const view = JSON.parse(
    gh(["pr", "view", String(pr), "--json", "number,title,body,mergedAt,labels,files"])
  ) as PrView;

  const filter = prefilter({
    title: view.title,
    labels: view.labels.map((label) => label.name),
    files: view.files.map((file) => file.path)
  });
  console.log(`#${view.number} ${view.title}`);
  if (!filter.send) {
    console.log(`Pre-filter: skip (${filter.reason}). No model call.`);
    return;
  }
  console.log(`Pre-filter: send. ${filter.matchedFiles.length} matched file(s):`);
  for (const file of filter.matchedFiles) console.log(`  ${file}`);

  const { diff, cut } = capDiff(diffForFiles(gh(["pr", "diff", String(pr)]), filter.matchedFiles), MAX_DIFF_CHARS);
  if (cut) console.log(`The matched diff is longer than ${MAX_DIFF_CHARS} characters; the model sees the first part.`);

  // Run from the repository root, as the npm scripts are.
  const repoRoot = process.cwd();
  let decision;
  try {
    decision = await decide({ number: view.number, title: view.title, body: view.body, diff }, repoRoot);
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error(`Model: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof Anthropic.AuthenticationError || /api key|apiKey|authToken|credentials/i.test(String(error))) {
      console.error("Model: no usable Anthropic credential. Set ANTHROPIC_API_KEY to run the model call.");
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
  console.log(`\n--- lib/whatsNew/entries/${slug}.tsx ---\n`);
  console.log(renderEntryFile(decision, { slug, prNumber: view.number, mergedAt }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
