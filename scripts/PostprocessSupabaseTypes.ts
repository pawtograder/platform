import fs from "fs";
import path from "path";
import { COLUMNS } from "../lib/bugReport/privacy";
import { brandPiiColumns } from "./bugReport/brandPiiColumns";
import { runBugReportPostprocess } from "./bugReport/privacyArtifacts";

const AUDIT_PARTITION_KEY_PATTERN = /^\s{6}audit_\d{8}:\s\{$/;

function getBraceDelta(line: string) {
  const openBraces = (line.match(/\{/g) ?? []).length;
  const closeBraces = (line.match(/\}/g) ?? []).length;
  return openBraces - closeBraces;
}

function stripAuditPartitions(content: string) {
  const lines = content.split("\n");
  const filtered: string[] = [];

  let skippingPartitionBlock = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!skippingPartitionBlock && AUDIT_PARTITION_KEY_PATTERN.test(line)) {
      skippingPartitionBlock = true;
      braceDepth = getBraceDelta(line);
      continue;
    }

    if (skippingPartitionBlock) {
      braceDepth += getBraceDelta(line);
      if (braceDepth <= 0) {
        skippingPartitionBlock = false;
      }
      continue;
    }

    filtered.push(line);
  }

  return filtered.join("\n");
}

async function run() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error("Usage: npx tsx scripts/PostprocessSupabaseTypes.ts <file-path> [more-file-paths...]");
  }

  for (const target of targets) {
    const resolvedPath = path.resolve(target);
    const original = fs.readFileSync(resolvedPath, "utf8");
    let updated = stripAuditPartitions(original);
    if (updated !== original) {
      // eslint-disable-next-line no-console
      console.log(`Removed rotating audit partition types from ${target}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`No rotating audit partition types found in ${target}`);
    }

    // Brand classified Row columns as Pii<kind, T> for the pii-render lint rule (bug reporter, package 4b).
    if (path.basename(resolvedPath) === "SupabaseTypes.d.ts") {
      const branded = brandPiiColumns(updated, (key) => COLUMNS[key]);
      updated = branded.source;
      // eslint-disable-next-line no-console
      console.log(`Branded ${branded.branded} classified Row columns as Pii<kind, T> in ${target}`);
    }
    if (updated !== original) fs.writeFileSync(resolvedPath, updated, "utf8");

    // The bug reporter's privacy classification must cover the public schema (lib/bugReport/privacy.ts).
    if (path.basename(resolvedPath) === "SupabaseTypes.d.ts") {
      const error = await runBugReportPostprocess(updated);
      if (error) {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
      }
    }
  }
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
