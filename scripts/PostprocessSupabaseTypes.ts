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

// Columns of a set-returning function that can be NULL. The generator marks every column a
// function returns as non-null, whatever the SQL does.
const NULLABLE_FUNCTION_RETURN_COLUMNS: Record<string, string[]> = {
  forgejo_group_repo_revocations_needed: ["repository_id"], // returns the nullable table column
  office_hours_queue_health: ["unstaffed_seconds"] // NULL while a shift is running (CASE ... ELSE NULL)
};

const RETURNS_KEY_PATTERN = /^\s{8}Returns:\s\{$/;
const RETURNS_END_PATTERN = /^\s{8}\}/;

function makeFunctionReturnColumnsNullable(content: string) {
  const lines = content.split("\n");
  let columns: string[] | undefined;
  let inReturns = false;

  const updated = lines.map((line) => {
    const functionMatch = line.match(TABLE_KEY_PATTERN);
    if (functionMatch) {
      columns = NULLABLE_FUNCTION_RETURN_COLUMNS[functionMatch[1]];
      inReturns = false;
      return line;
    }
    if (RETURNS_KEY_PATTERN.test(line)) {
      inReturns = true;
      return line;
    }
    if (RETURNS_END_PATTERN.test(line)) {
      inReturns = false;
      return line;
    }

    const columnMatch = inReturns && columns ? line.match(COLUMN_PATTERN) : null;
    if (columnMatch && columns?.includes(columnMatch[2])) {
      const [, indent, name, rest] = columnMatch;
      const type = rest.replace(/;$/, "");
      if (/\|\s*null$/.test(type)) return line;
      return `${indent}${name}: ${type} | null${rest.endsWith(";") ? ";" : ""}`;
    }
    return line;
  });

  return updated.join("\n");
}

async function run() {
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

    let updated = makeTriggerFilledColumnsOptional(stripped);
    if (updated !== stripped) {
      // eslint-disable-next-line no-console
      console.log(`Marked trigger-filled Insert columns optional in ${target}`);
    }

    const beforeNullable = updated;
    updated = makeFunctionReturnColumnsNullable(updated);
    if (updated !== beforeNullable) {
      // eslint-disable-next-line no-console
      console.log(`Marked nullable function return columns in ${target}`);
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
