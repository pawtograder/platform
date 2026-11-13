/**
 * In-memory stand-in for the admin Supabase client, covering only the calls RepoPush.ts makes.
 * `eq` and `ilike` filters are applied to the rows, so a test can tell a provider-scoped lookup from
 * one that ignores the provider, and an escaped ILIKE pattern from a wildcard. Used by RepoPush.test.ts and forgejo-repo-webhook/webhook.test.ts.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "./SupabaseTypes.d.ts";

type Row = Record<string, unknown>;

export type FakeQuery = { table: string; filters: [string, unknown][] };

/** An `ilike` filter, as recorded in `FakeQuery.filters`. */
export type IlikeFilter = { ilike: string };

/** Postgres ILIKE with its default escape character, `\`. */
function ilikeMatches(pattern: string, value: string): boolean {
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") source += literal(pattern[++i] ?? "");
    else if (c === "%") source += ".*";
    else if (c === "_") source += ".";
    else source += literal(c);
  }
  return new RegExp(`^${source}$`, "is").test(value);
}

function matches(row: Row, [column, value]: [string, unknown]): boolean {
  const ilike = (value as IlikeFilter | null)?.ilike;
  return typeof ilike === "string" ? ilikeMatches(ilike, String(row[column])) : row[column] === value;
}

export function fakeSupabase(
  tables: Record<string, Row[]>,
  opts: { insertError?: { code: string; message: string } } = {}
) {
  const queries: FakeQuery[] = [];
  const inserts: { table: string; row: Row }[] = [];
  const client = {
    from(table: string) {
      const query: FakeQuery = { table, filters: [] };
      const rows = () => (tables[table] ?? []).filter((row) => query.filters.every((filter) => matches(row, filter)));
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq(column: string, value: unknown) {
          query.filters.push([column, value]);
          return chain;
        },
        ilike(column: string, pattern: string) {
          query.filters.push([column, { ilike: pattern } satisfies IlikeFilter]);
          return chain;
        },
        maybeSingle() {
          queries.push(query);
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        },
        // Awaiting the chain without maybeSingle() resolves to every matching row.
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          queries.push(query);
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
        insert(row: Row) {
          if (opts.insertError) return Promise.resolve({ error: opts.insertError });
          inserts.push({ table, row });
          (tables[table] ??= []).push({ id: inserts.length, ...row });
          return Promise.resolve({ error: null });
        }
      };
      return chain;
    }
  };
  return { client: client as unknown as SupabaseClient<Database>, queries, inserts };
}

/** A `repositories` row with the fields the push handler reads. */
export function repositoryRow(overrides: Row = {}): Database["public"]["Tables"]["repositories"]["Row"] {
  return {
    id: 1,
    class_id: 10,
    assignment_id: 100,
    assignment_group_id: null,
    profile_id: "student-profile",
    repository: "cs101/hw1-alex",
    git_provider: "github",
    is_github_ready: true,
    ...overrides
  } as unknown as Database["public"]["Tables"]["repositories"]["Row"];
}
