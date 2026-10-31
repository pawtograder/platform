/**
 * Checks that every code path deleting `repositories` or `submissions` rows still handles
 * every table that references them.
 *
 * Foreign keys into these tables are deliberately not ON DELETE CASCADE. A submission carries
 * grades, reviews, comments and regrade requests, and a cascade would delete all of it without
 * anyone deciding to. With NO ACTION, a delete path that misses a new child table raises 23503
 * and rolls back: it fails safe, and someone notices. The cost is that a missed table surfaces
 * as an error in production (dissolving a group whose repo had workflow_events rows did exactly
 * this). This script moves that failure to CI.
 *
 * Errors (exit 1), all read from the catalog of a migrated database:
 *   - a foreign key into repositories or submissions that FOREIGN_KEYS below does not list, or
 *     lists with a different ON DELETE rule. Decide how each delete path handles the new table,
 *     then add it to FOREIGN_KEYS. A new key should be NO ACTION, not CASCADE.
 *   - an entry in FOREIGN_KEYS that no longer exists.
 *   - a SQL path in SQL_DELETE_PATHS whose body (comments stripped) does not name a table that
 *     references its target with NO ACTION or RESTRICT, unless the path lists it in `leaves`.
 *   - a SQL function, or a file under supabase/functions, app, lib or scripts, that deletes from
 *     repositories or submissions and is not registered here. Delete repositories through
 *     public.delete_repository_rows; register a new submission delete path below.
 *
 * Not checked automatically: the TypeScript rollbacks in TS_DELETE_PATHS. Each deletes one
 * submission it has just created, so it only clears the child rows the create-submission path
 * itself writes. When that path starts writing a new child table, add the table to the rollback
 * by hand. The rollbacks throw on any delete error, so a missed table fails safe.
 *
 * Usage: npx tsx scripts/CheckDeletePaths.ts
 * Connects to SUPABASE_DB_URL, then DATABASE_URL, then the local Supabase default.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "pg";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type Target = "repositories" | "submissions";
type OnDelete = "no action" | "restrict" | "cascade" | "set null" | "set default";

/**
 * Every foreign key into repositories and submissions, keyed by constraint name. `note` says how
 * the delete paths treat it; CASCADE and SET NULL entries predate this check.
 */
const FOREIGN_KEYS: Record<
  string,
  { table: string; column: string; target: Target; onDelete: OnDelete; note: string }
> = {
  // ── into repositories ──
  submissions_repository_id_fkey: {
    table: "submissions",
    column: "repository_id",
    target: "repositories",
    onDelete: "no action",
    note: "delete_repository_rows never deletes submissions, so a repo with submissions cannot be deleted by accident"
  },
  repository_check_run_repository_id_fkey: {
    table: "repository_check_runs",
    column: "repository_id",
    target: "repositories",
    onDelete: "no action",
    note: "deleted by every repository delete path"
  },
  workflow_events_repository_id_fkey: {
    table: "workflow_events",
    column: "repository_id",
    target: "repositories",
    onDelete: "no action",
    note: "deleted by every repository delete path"
  },
  workflow_run_error_repository_id_fkey: {
    table: "workflow_run_error",
    column: "repository_id",
    target: "repositories",
    onDelete: "cascade",
    note: "telemetry"
  },
  repository_analytics_daily_repository_id_fkey: {
    table: "repository_analytics_daily",
    column: "repository_id",
    target: "repositories",
    onDelete: "cascade",
    note: "derived analytics, recomputable"
  },
  repository_analytics_items_repository_id_fkey: {
    table: "repository_analytics_items",
    column: "repository_id",
    target: "repositories",
    onDelete: "cascade",
    note: "derived analytics, recomputable"
  },
  repository_analytics_fetch_status_repository_id_fkey: {
    table: "repository_analytics_fetch_status",
    column: "repository_id",
    target: "repositories",
    onDelete: "cascade",
    note: "derived analytics, recomputable"
  },
  repository_analytics_repo_status_repository_id_fkey: {
    table: "repository_analytics_repo_status",
    column: "repository_id",
    target: "repositories",
    onDelete: "cascade",
    note: "derived analytics, recomputable"
  },
  github_deployments_repository_id_fkey: {
    table: "github_deployments",
    column: "repository_id",
    target: "repositories",
    onDelete: "set null",
    note: "deployment history outlives the repo row"
  },
  // ── into submissions ──
  grader_results_submission_id_fkey: {
    table: "grader_results",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grades"
  },
  grader_results_rerun_for_submission_id_fkey: {
    table: "grader_results",
    column: "rerun_for_submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grades"
  },
  grader_result_tests_submission_id_fkey: {
    table: "grader_result_tests",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grades"
  },
  submission_files_submissions_id_fkey: {
    table: "submission_files",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "also has storage blobs, which the delete path removes first"
  },
  submission_comments_submissions_id_fkey: {
    table: "submission_comments",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grading comments"
  },
  submission_file_lcomments_submissions_id_fkey: {
    table: "submission_file_comments",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grading comments"
  },
  submission_artifact_comments_submission_id_fkey: {
    table: "submission_artifact_comments",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grading comments"
  },
  submission_artifact_comments_submission_id_fkey1: {
    table: "submission_artifact_comments",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "duplicate of submission_artifact_comments_submission_id_fkey"
  },
  submission_artifacts_submission_id_fkey: {
    table: "submission_artifacts",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "autograder output"
  },
  submission_reviews_submission_id_fkey: {
    table: "submission_reviews",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "grading reviews; submissions.grading_review_id points back, so unlink it first"
  },
  submission_regrade_requests_submission_id_fkey: {
    table: "submission_regrade_requests",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "student regrade requests"
  },
  submission_regrade_request_comments_submission_id_fkey: {
    table: "submission_regrade_request_comments",
    column: "submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "student regrade requests"
  },
  repository_check_runs_target_submission_id_fkey: {
    table: "repository_check_runs",
    column: "target_submission_id",
    target: "submissions",
    onDelete: "no action",
    note: "commit history"
  },
  review_assignments_submission_id_fkey: {
    table: "review_assignments",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "the delete paths also delete these explicitly"
  },
  workflow_run_error_submission_id_fkey: {
    table: "workflow_run_error",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "telemetry"
  },
  grader_result_tests_hint_feedback_submission_id_fkey: {
    table: "grader_result_tests_hint_feedback",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "student feedback on hints"
  },
  llm_inference_usage_submission_id_fkey: {
    table: "llm_inference_usage",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "usage telemetry"
  },
  error_pin_submission_matches_submission_id_fkey: {
    table: "error_pin_submission_matches",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "derived, recomputable"
  },
  submission_file_symbol_index_submission_fkey: {
    table: "submission_file_symbol_index",
    column: "submission_id",
    target: "submissions",
    onDelete: "cascade",
    note: "derived, recomputable"
  },
  help_requests_referenced_submission_id_fkey: {
    table: "help_requests",
    column: "referenced_submission_id",
    target: "submissions",
    onDelete: "set null",
    note: "office-hours history outlives the submission"
  },
  help_request_file_references_submission_id_fkey: {
    table: "help_request_file_references",
    column: "submission_id",
    target: "submissions",
    onDelete: "set null",
    note: "office-hours history outlives the submission"
  },
  assignment_leaderboard_submission_id_fkey: {
    table: "assignment_leaderboard",
    column: "submission_id",
    target: "submissions",
    onDelete: "set null",
    note: "leaderboard keeps the score"
  }
};

/**
 * SQL functions allowed to delete from repositories or submissions. Each must name every table
 * that references each of its `targets` with NO ACTION/RESTRICT, except the ones in `leaves`:
 * tables it relies on to block the delete instead of clearing them.
 */
const SQL_DELETE_PATHS: Record<string, { targets: Target[]; leaves?: string[] }> = {
  delete_repository_rows: { targets: ["repositories"], leaves: ["submissions"] },
  cleanup_individual_repositories_for_assignment: { targets: ["repositories", "submissions"] },
  delete_assignment_with_all_data: { targets: ["repositories", "submissions"] }
};

/**
 * TypeScript files allowed to delete from repositories or submissions directly. These rollbacks
 * remove one submission that the create-submission path just made; review them by hand when that
 * path starts writing a new child table.
 */
const TS_DELETE_PATHS: Record<string, string> = {
  "supabase/functions/autograder-create-submission/index.ts": "safeCleanupRejectedSubmission",
  "supabase/functions/github-repo-webhook/index.ts": "cleanupPushDirectSubmission"
};

const SOURCE_DIRS = ["app", "components", "hooks", "lib", "utils", "scripts", "supabase/functions"];
const TS_DELETE = /\.from\(\s*["'](repositories|submissions)["']\s*\)\s*\.delete\(/g;
const SQL_DELETE = /\bdelete\s+from\s+(?:"?public"?\.)?"?(repositories|submissions)"?(?![\w"])/i;

const ON_DELETE: Record<string, OnDelete> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default"
};

const FOREIGN_KEYS_SQL = `
select c.conname as name, c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as target,
       c.confdeltype as deltype,
       (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
         where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as col
from pg_constraint c
where c.contype = 'f' and c.confrelid in ('public.repositories'::regclass, 'public.submissions'::regclass)
`;

// Every function in public, so unregistered delete sites are found as well as registered ones.
const FUNCTIONS_SQL = `
select p.proname as name, p.prosrc as src
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.prolang in (
  select oid from pg_language where lanname in ('plpgsql', 'sql'))
`;

function stripSqlComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function bareTable(regclass: string): string {
  return regclass.replace(/^public\./, "").replace(/"/g, "");
}

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const REVIEW_HINT =
  `review the delete paths: SQL ${Object.keys(SQL_DELETE_PATHS).join(", ")}; ` +
  `TypeScript ${Object.entries(TS_DELETE_PATHS)
    .map(([f, fn]) => `${fn} (${f})`)
    .join(", ")}`;

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const errors: string[] = [];
  try {
    // 1. Catalog vs FOREIGN_KEYS.
    const fks = (
      await client.query<{ name: string; tbl: string; target: string; deltype: string; col: string }>(FOREIGN_KEYS_SQL)
    ).rows;
    const seen = new Set<string>();
    for (const fk of fks) {
      seen.add(fk.name);
      const actual = ON_DELETE[fk.deltype] ?? fk.deltype;
      const expected = FOREIGN_KEYS[fk.name];
      const where = `${fk.tbl}.${fk.col} -> ${fk.target} (${fk.name}, ON DELETE ${actual})`;
      if (!expected) {
        errors.push(
          `New foreign key ${where}. ` +
            (actual === "cascade" ? "Make it NO ACTION, not CASCADE, and delete its rows explicitly. " : "") +
            `To decide how each delete path handles it, ${REVIEW_HINT}; then add it to FOREIGN_KEYS in scripts/CheckDeletePaths.ts`
        );
      } else if (expected.onDelete !== actual) {
        errors.push(
          `${where} was ON DELETE ${expected.onDelete}. To check each delete path, ${REVIEW_HINT}; then update FOREIGN_KEYS in scripts/CheckDeletePaths.ts`
        );
      }
    }
    for (const name of Object.keys(FOREIGN_KEYS)) {
      if (!seen.has(name)) errors.push(`FOREIGN_KEYS lists ${name}, which no longer exists; remove it`);
    }

    // 2. Registered SQL paths name every blocking child table; nothing else deletes directly.
    const blocking = new Map<Target, Set<string>>([
      ["repositories", new Set()],
      ["submissions", new Set()]
    ]);
    for (const fk of fks) {
      if (fk.deltype === "a" || fk.deltype === "r") {
        blocking.get(bareTable(fk.target) as Target)?.add(bareTable(fk.tbl));
      }
    }
    const functions = (await client.query<{ name: string; src: string }>(FUNCTIONS_SQL)).rows;
    const bodies = new Map<string, string[]>();
    for (const f of functions) bodies.set(f.name, [...(bodies.get(f.name) ?? []), stripSqlComments(f.src)]);

    for (const [name, path] of Object.entries(SQL_DELETE_PATHS)) {
      const srcs = bodies.get(name);
      if (!srcs) {
        errors.push(`SQL_DELETE_PATHS lists public.${name}, which does not exist; remove it`);
        continue;
      }
      for (const target of path.targets) {
        for (const child of blocking.get(target)!) {
          if (path.leaves?.includes(child)) continue;
          if (!srcs.some((src) => new RegExp(`\\b${child}\\b`, "i").test(src))) {
            errors.push(
              `public.${name} deletes ${target} but never touches ${child}, which references it with NO ACTION; ` +
                `the delete will fail with 23503 once ${child} has a row. Delete those rows first, or list ${child} in its \`leaves\``
            );
          }
        }
      }
    }
    for (const [name, srcs] of bodies) {
      if (SQL_DELETE_PATHS[name]) continue;
      const match = srcs.map((src) => SQL_DELETE.exec(src)).find((m) => m);
      if (match) {
        errors.push(
          `public.${name} deletes from ${match[1]} directly. ` +
            (match[1] === "repositories"
              ? "Call public.delete_repository_rows instead"
              : "Register it in SQL_DELETE_PATHS in scripts/CheckDeletePaths.ts")
        );
      }
    }

    // 3. No unregistered TypeScript delete sites.
    const root = process.cwd();
    for (const file of SOURCE_DIRS.flatMap((d) => sourceFiles(join(root, d)))) {
      const rel = relative(root, file);
      if (TS_DELETE_PATHS[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(TS_DELETE)) {
        const line = text.slice(0, m.index).split("\n").length;
        console.log(
          `::error file=${rel},line=${line}::Direct delete from ${m[1]}. ` +
            (m[1] === "repositories"
              ? `Call the delete_repository_rows RPC instead.`
              : `Register it in TS_DELETE_PATHS in scripts/CheckDeletePaths.ts, and make it throw on any delete error.`)
        );
        errors.push(`${rel}:${line} deletes from ${m[1]} directly`);
      }
    }

    for (const e of errors) console.log(`::error::${e}`);
    console.log(
      `Delete paths: ${errors.length} error(s); checked ${fks.length} foreign keys, ` +
        `${Object.keys(SQL_DELETE_PATHS).length} SQL and ${Object.keys(TS_DELETE_PATHS).length} TypeScript delete paths.`
    );
    if (errors.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
