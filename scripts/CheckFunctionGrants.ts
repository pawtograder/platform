/**
 * Checks that the database roles which have to execute a function can.
 *
 * Since 20261015120000_lock_down_security_definer_functions.sql, functions that migrations create
 * get no EXECUTE for PUBLIC, anon or authenticated by default (service_role keeps it in `public`).
 * A migration that adds a function, or drops and recreates one, has to GRANT it explicitly. When
 * it forgets, nothing fails until a user hits the code path and gets SQLSTATE 42501.
 *
 * Errors (exit 1), from the catalog of a migrated database:
 *   - a function used by an RLS policy, a security_invoker view, a column default or a CHECK
 *     constraint that a role reaching that object (anon/authenticated) cannot execute. These fail
 *     every read or write of the table or view, not only one RPC.
 *   - a function in pgmq_public that service_role cannot execute (an ALTER EXTENSION UPDATE
 *     creates new ones with no grants).
 *
 * Warnings (printed as GitHub annotations, exit 0), from the source tree:
 *   - a `.rpc("name")` call that does not look like it uses a service-role client, where no
 *     overload of public.name is executable by authenticated. A call counts as service-role when
 *     its receiver is named like one (adminSupabase.rpc, getAdminClient().rpc), when its file
 *     creates one, or when the line above it says `// function-grants: service-role` (for helpers
 *     that take the client as a parameter). The file test means a file that uses both kinds of
 *     client hides its calls from this check.
 *
 * Usage: npx tsx scripts/CheckFunctionGrants.ts
 * Connects to SUPABASE_DB_URL, then DATABASE_URL, then the local Supabase default.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "pg";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const SOURCE_DIRS = ["app", "components", "hooks", "lib", "utils", "supabase/functions"];
const SERVICE_ROLE_CLIENT = /createAdminClient|AdminClient\b|SERVICE_ROLE_KEY/;
const SERVICE_ROLE_RECEIVER = /admin|service/i;
const SERVICE_ROLE_MARKER = "function-grants: service-role";
// Receiver (optionally through .schema("public") or a call), then the quoted function name.
const RPC_CALL = /([\w$]+)(?:\([^()]*\))?\s*(?:\.schema\([^)]*\)\s*)?\.rpc\(\s*["']([a-z_][a-z0-9_]*)["']/g;

const OBJECT_USES_SQL = `
with uses as (
  -- RLS policies: every role the policy applies to evaluates its expressions.
  select d.refobjid as fn, format('policy %I on %s', p.polname, p.polrelid::regclass) as used_by,
         r.rolname as needed_by
  from pg_depend d
  join pg_policy p on d.classid = 'pg_policy'::regclass and p.oid = d.objid
  join pg_roles r on r.rolname in ('anon', 'authenticated')
   and (r.oid = any (p.polroles) or 0 = any (p.polroles))
  where d.refclassid = 'pg_proc'::regclass
  union all
  -- security_invoker views run their functions as whoever selects from them.
  select d.refobjid, format('view %s', rw.ev_class::regclass), r.rolname
  from pg_depend d
  join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and rw.oid = d.objid
  join pg_class c on c.oid = rw.ev_class and c.relkind = 'v'
   and coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on'], false)
  join pg_roles r on r.rolname in ('anon', 'authenticated') and has_table_privilege(r.oid, c.oid, 'SELECT')
  where d.refclassid = 'pg_proc'::regclass
  union all
  -- Column defaults and CHECK constraints run as the inserting or updating user.
  select d.refobjid, format('default for %s.%I', ad.adrelid::regclass, a.attname), 'authenticated'
  from pg_depend d
  join pg_attrdef ad on d.classid = 'pg_attrdef'::regclass and ad.oid = d.objid
  join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
  where d.refclassid = 'pg_proc'::regclass and has_table_privilege('authenticated', ad.adrelid, 'INSERT')
  union all
  select d.refobjid, format('constraint %I on %s', con.conname, con.conrelid::regclass), 'authenticated'
  from pg_depend d
  join pg_constraint con on d.classid = 'pg_constraint'::regclass and con.oid = d.objid and con.conrelid <> 0
  where d.refclassid = 'pg_proc'::regclass and has_table_privilege('authenticated', con.conrelid, 'INSERT, UPDATE')
)
select distinct u.fn::regprocedure::text as fn, u.needed_by, u.used_by
from uses u
where not has_function_privilege(u.needed_by, u.fn, 'EXECUTE')
order by 1, 2, 3`;

const QUEUE_API_SQL = `
select p.oid::regprocedure::text as fn
from pg_proc p
where p.pronamespace = 'pgmq_public'::regnamespace
  and not has_function_privilege('service_role', p.oid, 'EXECUTE')
order by 1`;

const RPC_GRANTS_SQL = `
select n as name,
       bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as executable
from unnest($1::text[]) n
join pg_proc p on p.proname = n and p.pronamespace = 'public'::regnamespace
group by n`;

type RpcCall = { name: string; file: string; line: number };

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [path] : [];
  });
}

function userClientRpcCalls(root: string): RpcCall[] {
  return SOURCE_DIRS.flatMap((dir) => sourceFiles(join(root, dir))).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    if (SERVICE_ROLE_CLIENT.test(text)) return [];
    const lines = text.split("\n");
    return [...text.matchAll(RPC_CALL)].flatMap((m) => {
      const line = text.slice(0, m.index).split("\n").length;
      if (SERVICE_ROLE_RECEIVER.test(m[1]) || lines[line - 2]?.includes(SERVICE_ROLE_MARKER)) return [];
      return [{ name: m[2], file: relative(root, path), line }];
    });
  });
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const errors: string[] = [];

    const objectUses = await client.query<{ fn: string; needed_by: string; used_by: string }>(OBJECT_USES_SQL);
    for (const row of objectUses.rows) {
      errors.push(`${row.needed_by} cannot execute ${row.fn}, which ${row.used_by} uses`);
    }

    const queueApi = await client.query<{ fn: string }>(QUEUE_API_SQL);
    for (const row of queueApi.rows) {
      errors.push(`service_role cannot execute ${row.fn}`);
    }

    const calls = userClientRpcCalls(process.cwd());
    const names = [...new Set(calls.map((c) => c.name))];
    const grants = await client.query<{ name: string; executable: boolean }>(RPC_GRANTS_SQL, [names]);
    const notExecutable = new Set(grants.rows.filter((r) => !r.executable).map((r) => r.name));
    const warnings = calls.filter((c) => notExecutable.has(c.name));

    for (const w of warnings) {
      console.log(
        `::warning file=${w.file},line=${w.line}::authenticated has no EXECUTE on public.${w.name}. ` +
          `If this call uses a user's client it fails with 42501; GRANT EXECUTE ... TO authenticated in the migration, ` +
          `or call it with a service-role client.`
      );
    }
    for (const e of errors) {
      console.log(`::error::${e}. GRANT EXECUTE on it in the migration that (re)created it.`);
    }
    console.log(
      `Function grants: ${errors.length} error(s), ${warnings.length} warning(s); ` +
        `checked ${calls.length} user-client .rpc() calls to ${names.length} functions.`
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
