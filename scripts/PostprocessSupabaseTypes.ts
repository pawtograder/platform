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

// Columns that a BEFORE INSERT trigger always fills. They are NOT NULL with no default, so the
// generator marks them required on Insert; callers may leave them out.
const TRIGGER_FILLED_INSERT_COLUMNS: Record<string, string[]> = {
  user_roles: ["class_role_id"] // trg_user_roles_set_default_class_role
};

const TABLE_KEY_PATTERN = /^\s{6}(\w+):\s\{$/;
const INSERT_KEY_PATTERN = /^\s{8}Insert:\s\{$/;
const SECTION_END_PATTERN = /^\s{8}\}$/;
const COLUMN_PATTERN = /^(\s{10})(\w+):\s(.*)$/;

function makeTriggerFilledColumnsOptional(content: string) {
  const lines = content.split("\n");
  let columns: string[] | undefined;
  let inInsert = false;

  const updated = lines.map((line) => {
    const tableMatch = line.match(TABLE_KEY_PATTERN);
    if (tableMatch) {
      columns = TRIGGER_FILLED_INSERT_COLUMNS[tableMatch[1]];
      inInsert = false;
      return line;
    }
    if (INSERT_KEY_PATTERN.test(line)) {
      inInsert = true;
      return line;
    }
    if (SECTION_END_PATTERN.test(line)) {
      inInsert = false;
      return line;
    }

    const columnMatch = inInsert && columns ? line.match(COLUMN_PATTERN) : null;
    if (columnMatch && columns?.includes(columnMatch[2])) {
      return `${columnMatch[1]}${columnMatch[2]}?: ${columnMatch[3]}`;
    }
    return line;
  });

  return updated.join("\n");
}

function run() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error("Usage: npx tsx scripts/PostprocessSupabaseTypes.ts <file-path> [more-file-paths...]");
  }

  for (const target of targets) {
    const resolvedPath = path.resolve(target);
    const original = fs.readFileSync(resolvedPath, "utf8");
    const stripped = stripAuditPartitions(original);
    if (stripped !== original) {
      // eslint-disable-next-line no-console
      console.log(`Removed rotating audit partition types from ${target}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`No rotating audit partition types found in ${target}`);
    }

    const updated = makeTriggerFilledColumnsOptional(stripped);
    if (updated !== stripped) {
      // eslint-disable-next-line no-console
      console.log(`Marked trigger-filled Insert columns optional in ${target}`);
    }

    if (updated !== original) {
      fs.writeFileSync(resolvedPath, updated, "utf8");
    }
  }
}

run();
