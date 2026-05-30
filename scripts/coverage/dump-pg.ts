/**
 * Postgres coverage dumper.
 *
 * Reads per-statement hit counts from `plpgsql_check.plpgsql_profiler_function_tb`
 * for every plpgsql function in the schemas we care about, then emits an
 * lcov-format report that maps profiler line numbers back to the
 * `supabase/migrations/*.sql` file where each function was last defined.
 *
 * Usage:
 *   npx tsx scripts/coverage/dump-pg.ts > coverage/postgres.lcov
 *
 * Required env (defaults match local Supabase):
 *   SUPABASE_DB_URL  — connection string. Falls back to
 *                      postgres://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Limitations:
 *   - Functions defined outside of `supabase/migrations/*.sql` (e.g. created
 *     ad-hoc, or in Supabase-shipped extensions) are skipped — there's no
 *     source file to report against.
 *   - If a function is `CREATE OR REPLACE`d across multiple migrations,
 *     we use the most recent migration's definition. The earlier ones'
 *     coverage is effectively folded into the latest file/line range.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

type FuncIndexEntry = {
  schema: string;
  name: string;
  argSignature: string; // e.g., "(uuid, integer)"
  file: string; // absolute path
  bodyStartLine: number; // 1-based line in `file` where the dollar-quoted body opens
  bodyLineCount: number; // total lines in the function body
};

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const REPO_ROOT = process.cwd();
const SCHEMAS_TO_INCLUDE = ["public", "pgmq_public"];

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";

// Match CREATE [OR REPLACE] FUNCTION [schema.]name(arglist) ... AS $$ ... $$
//
// This is intentionally line-oriented: PL/pgSQL functions in migrations
// are formatted with a `CREATE OR REPLACE FUNCTION` header followed by an
// `AS $body$` opener. We scan line-by-line so we can record the exact 1-based
// line number where the body opens — that's the offset we add to the
// profiler's reported lineno to land back in the migration file.
const FUNC_HEADER_RE = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)/i;
const DOLLAR_OPEN_RE = /\bAS\s+\$(\w*)\$/i;

async function buildFunctionIndex(): Promise<Map<string, FuncIndexEntry>> {
  // key = "schema.name(normalizedArgTypes)"; later migrations overwrite earlier ones
  const idx = new Map<string, FuncIndexEntry>();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const full = path.join(MIGRATIONS_DIR, file);
    const text = await readFile(full, "utf8");
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const header = lines[i].match(FUNC_HEADER_RE);
      if (!header) continue;
      const schema = header[1] ?? "public";
      const name = header[2];
      const argList = header[3]
        .split(",")
        .map((s) => normalizeArg(s.trim()))
        .filter(Boolean)
        .join(",");

      // Walk forward to find the dollar-quote opener and its closing pair.
      let bodyStart = -1;
      let bodyEnd = -1;
      let dollarTag = "";
      for (let j = i; j < lines.length; j++) {
        const m = lines[j].match(DOLLAR_OPEN_RE);
        if (m) {
          dollarTag = m[1];
          // PostgreSQL dollar-quote tags are PG identifiers — letters,
          // digits, underscores only. Validate before regex construction
          // to avoid ReDoS on a pathological migration.
          if (!/^[A-Za-z0-9_]*$/.test(dollarTag)) {
            console.warn(`[dump-pg] skipping function at ${file}:${j + 1}: unsafe dollar tag "${dollarTag}"`);
            break;
          }
          bodyStart = j + 1; // 1-based, on the line AFTER the AS $tag$
          // Search for the matching closing $tag$ on a subsequent line.
          const closeRe = new RegExp(`\\$${dollarTag}\\$`);
          for (let k = j + 1; k < lines.length; k++) {
            if (closeRe.test(lines[k])) {
              bodyEnd = k + 1; // 1-based
              break;
            }
          }
          break;
        }
      }
      if (bodyStart < 0 || bodyEnd < 0) continue;

      const key = `${schema}.${name}(${argList})`;
      idx.set(key, {
        schema,
        name,
        argSignature: `(${argList})`,
        file: full,
        bodyStartLine: bodyStart,
        bodyLineCount: bodyEnd - bodyStart
      });
    }
  }
  return idx;
}

function normalizeArg(arg: string): string {
  // Strip parameter mode (IN/OUT/INOUT) and name; keep just the type.
  // Postgres records arg types in pg_proc, which is what we'll compare against.
  // Examples we need to handle:
  //   "p_class_id integer"            -> "integer"
  //   "OUT result_id uuid"            -> "uuid"
  //   "INOUT data jsonb DEFAULT '{}'" -> "jsonb"
  //   "integer"                       -> "integer"
  if (!arg) return "";
  let s = arg
    .replace(/^\s*(?:IN|OUT|INOUT|VARIADIC)\s+/i, "")
    .replace(/\s+DEFAULT\b.*$/i, "")
    .replace(/\s+:=.*$/, "")
    .trim();
  // Drop the parameter name if present (everything up to the first space).
  const sp = s.indexOf(" ");
  if (sp >= 0) s = s.slice(sp + 1).trim();
  // Normalize common spellings.
  return s.toLowerCase().replace(/\s+/g, " ");
}

type ProfilerRow = {
  schema: string;
  name: string;
  argSignature: string; // pg_get_function_identity_arguments output
  lineno: number;
  exec_stmts: number;
};

async function fetchProfilerData(client: Client): Promise<ProfilerRow[]> {
  // For every plpgsql function in our schemas, unnest the per-statement
  // profiler array. The plpgsql_check extension installs into `public`
  // in current Supabase images (verified via pg_extension), so the
  // function is reachable via the default search_path. If a future
  // version moves it to its own schema, that schema is already on the
  // default search_path too.
  const sql = `
    SELECT
      n.nspname  AS schema,
      p.proname  AS name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS arg_signature,
      prof.lineno,
      prof.exec_stmts
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    LEFT JOIN LATERAL plpgsql_profiler_function_tb(p.oid) AS prof ON true
    WHERE l.lanname = 'plpgsql'
      AND n.nspname = ANY($1)
      AND prof.lineno IS NOT NULL
    ORDER BY schema, name, lineno
  `;
  const res = await client.query<{
    schema: string;
    name: string;
    arg_signature: string;
    lineno: number;
    exec_stmts: number;
  }>(sql, [SCHEMAS_TO_INCLUDE]);
  return res.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    argSignature: r.arg_signature,
    lineno: r.lineno,
    exec_stmts: r.exec_stmts
  }));
}

function normalizeIdentityArgs(sig: string): string {
  // pg returns e.g. "p_class_id integer, p_user uuid". Convert to "integer,uuid".
  // Empty string = no args.
  if (!sig) return "";
  return sig
    .split(",")
    .map((s) => normalizeArg(s.trim()))
    .filter(Boolean)
    .join(",");
}

type LcovFile = {
  file: string; // absolute path
  lines: Map<number, number>; // 1-based line -> hits
};

function toLcov(byFile: Map<string, LcovFile>): string {
  const out: string[] = [];
  for (const lf of byFile.values()) {
    const rel = path.relative(REPO_ROOT, lf.file);
    out.push("TN:");
    out.push(`SF:${rel}`);
    const lines = [...lf.lines.entries()].sort((a, b) => a[0] - b[0]);
    let lh = 0;
    for (const [line, hits] of lines) {
      out.push(`DA:${line},${hits}`);
      if (hits > 0) lh++;
    }
    out.push(`LF:${lines.length}`);
    out.push(`LH:${lh}`);
    out.push("end_of_record");
  }
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  const index = await buildFunctionIndex();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  let rows: ProfilerRow[];
  try {
    rows = await fetchProfilerData(client);
  } finally {
    await client.end();
  }

  const byFile = new Map<string, LcovFile>();
  let matched = 0;
  let unmatched = 0;
  const missing = new Set<string>();

  for (const row of rows) {
    const argKey = normalizeIdentityArgs(row.argSignature);
    const key = `${row.schema}.${row.name}(${argKey})`;
    const entry = index.get(key);
    if (!entry) {
      // Try fallback without args (single-overload assumption).
      const altKey = `${row.schema}.${row.name}`;
      const candidates = [...index.entries()].filter(([k]) => k.startsWith(`${altKey}(`));
      if (candidates.length === 1) {
        applyHit(byFile, candidates[0][1], row);
        matched++;
        continue;
      }
      unmatched++;
      missing.add(key);
      continue;
    }
    applyHit(byFile, entry, row);
    matched++;
  }

  // Stderr summary so it's visible in CI logs without polluting the lcov stdout.
  console.error(`[dump-pg] matched=${matched} unmatched=${unmatched} files=${byFile.size} index_size=${index.size}`);
  if (missing.size > 0 && missing.size < 50) {
    console.error("[dump-pg] missing keys (first 20):", [...missing].slice(0, 20));
  }

  process.stdout.write(toLcov(byFile));
}

function applyHit(byFile: Map<string, LcovFile>, entry: FuncIndexEntry, row: ProfilerRow): void {
  // Profiler reports lineno as 1-based offset from the *start of the function body*.
  // Our index records the file line where the body opens.
  const absLine = entry.bodyStartLine + row.lineno - 1;
  let lf = byFile.get(entry.file);
  if (!lf) {
    lf = { file: entry.file, lines: new Map() };
    byFile.set(entry.file, lf);
  }
  const prev = lf.lines.get(absLine) ?? 0;
  lf.lines.set(absLine, prev + row.exec_stmts);
}

main().catch((err) => {
  console.error("[dump-pg] FAILED:", err);
  process.exit(1);
});
