/**
 * In-memory stand-in for the admin Supabase client, covering only the calls RepoPush.ts and forgejo-repo-webhook make.
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Row)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function matches(row: Row, [column, value]: [string, unknown]): boolean {
  const ilike = (value as IlikeFilter | null)?.ilike;
  if (typeof ilike === "string") return ilikeMatches(ilike, String(row[column]));
  const path = column.split("->>");
  if (path.length === 2) {
    const field = (row[path[0]] as Row | null | undefined)?.[path[1]];
    return field !== undefined && field !== null && String(field) === value;
  }
  const cell = row[column];
  if (cell && typeof cell === "object" && typeof value === "string") {
    try {
      return canonicalJson(cell) === canonicalJson(JSON.parse(value));
    } catch {
      return false;
    }
  }
  return cell === value;
}

export function fakeSupabase(
  tables: Record<string, Row[]>,
  opts: {
    insertError?: { code: string; message: string };
    /** A unique index per table: rows with the same non-null key collide with 23505. */
    uniqueKeys?: Record<string, (row: Row) => string | null>;
  } = {}
) {
  const queries: FakeQuery[] = [];
  const inserts: { table: string; row: Row }[] = [];
  const updates: { table: string; values: Row; filters: [string, unknown][] }[] = [];
  const upserts: { table: string; row: Row; options: unknown }[] = [];
  const client = {
    from(table: string) {
      const query: FakeQuery = { table, filters: [] };
      let updateValues: Row | null = null;
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
        then(resolve: (result: { data: Row[] | null; error: null }) => unknown) {
          if (updateValues) {
            const values = updateValues;
            const matched = rows();
            for (const row of matched) Object.assign(row, values);
            updates.push({ table, values, filters: query.filters });
            return Promise.resolve({ data: matched, error: null }).then(resolve);
          }
          queries.push(query);
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
        update(values: Row) {
          updateValues = values;
          return chain;
        },
        upsert(row: Row, options?: unknown) {
          upserts.push({ table, row, options });
          return Promise.resolve({ error: null });
        },
        insert(row: Row) {
          if (opts.insertError) return Promise.resolve({ error: opts.insertError });
          const key = opts.uniqueKeys?.[table];
          const k = key?.(row);
          if (key && k !== null && k !== undefined && (tables[table] ?? []).some((r) => key(r) === k)) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
          }
          inserts.push({ table, row });
          (tables[table] ??= []).push({ id: inserts.length, ...row });
          return Promise.resolve({ error: null });
        }
      };
      return chain;
    }
  };
  return { client: client as unknown as SupabaseClient<Database>, queries, inserts, updates, upserts };
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
