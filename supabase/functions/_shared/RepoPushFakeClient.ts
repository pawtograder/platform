/**
 * In-memory stand-in for the admin Supabase client, covering only the calls RepoPush.ts makes.
 * `eq` filters are applied to the rows, so a test can tell a provider-scoped lookup from one that
 * ignores the provider. Used by RepoPush.test.ts and forgejo-repo-webhook/webhook.test.ts.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "./SupabaseTypes.d.ts";

type Row = Record<string, unknown>;

export type FakeQuery = { table: string; filters: [string, unknown][] };

export function fakeSupabase(
  tables: Record<string, Row[]>,
  opts: { insertError?: { code: string; message: string } } = {}
) {
  const queries: FakeQuery[] = [];
  const inserts: { table: string; row: Row }[] = [];
  const client = {
    from(table: string) {
      const query: FakeQuery = { table, filters: [] };
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq(column: string, value: unknown) {
          query.filters.push([column, value]);
          return chain;
        },
        maybeSingle() {
          queries.push(query);
          const rows = (tables[table] ?? []).filter((row) => query.filters.every(([c, v]) => row[c] === v));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
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
