import fs from "fs";
import path from "path";

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

function run() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error("Usage: npx tsx scripts/PostprocessSupabaseTypes.ts <file-path> [more-file-paths...]");
  }

  for (const target of targets) {
    const resolvedPath = path.resolve(target);
    const original = fs.readFileSync(resolvedPath, "utf8");
    const updated = stripAuditPartitions(original);
    if (updated !== original) {
      fs.writeFileSync(resolvedPath, updated, "utf8");
      // eslint-disable-next-line no-console
      console.log(`Removed rotating audit partition types from ${target}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`No rotating audit partition types found in ${target}`);
    }
  }
}

run();
