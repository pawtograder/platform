/**
 * Lightweight mock Supabase client that supports the fluent
 * `.from(table).select(columns).eq(col, val).in(col, vals)` query pattern.
 *
 * Provide canned table data via a Map and the mock will filter it in memory.
 */

type Row = Record<string, unknown>;

interface QueryResult {
  data: Row[] | null;
  error: null;
}

class MockQueryBuilder implements PromiseLike<QueryResult> {
  private rows: Row[];
  private selectColumns: string | null = null;

  constructor(rows: Row[]) {
    // Shallow-copy so filters don't mutate the source data.
    this.rows = [...rows];
  }

  select(columns?: string): this {
    this.selectColumns = columns ?? null;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.rows = this.rows.filter((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    const set = new Set(values);
    this.rows = this.rows.filter((row) => set.has(row[column]));
    return this;
  }

  neq(column: string, value: unknown): this {
    this.rows = this.rows.filter((row) => row[column] !== value);
    return this;
  }

  order(_column: string, _options?: { ascending?: boolean }): this {
    return this;
  }

  limit(count: number): this {
    this.rows = this.rows.slice(0, count);
    return this;
  }

  single(): PromiseLike<{ data: Row | null; error: null }> {
    const row = this.rows[0] ?? null;
    return Promise.resolve({ data: row, error: null });
  }

  /** Resolve the filtered rows, optionally projecting selected columns. */
  private resolve(): QueryResult {
    let result = this.rows;
    if (this.selectColumns && this.selectColumns !== "*") {
      const cols = this.selectColumns.split(",").map((c) => c.trim());
      result = result.map((row) => {
        const projected: Row = {};
        for (const col of cols) {
          if (col in row) projected[col] = row[col];
        }
        return projected;
      });
    }
    return { data: result, error: null };
  }

  /** Support `await client.from(...).select(...)` */
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

export class MockSupabaseClient {
  private tableData: Map<string, Row[]>;

  constructor(tableData: Map<string, Row[]>) {
    this.tableData = tableData;
  }

  from(table: string): MockQueryBuilder {
    const rows = this.tableData.get(table) ?? [];
    return new MockQueryBuilder(rows);
  }

  /** Stub for rpc calls -- returns empty data by default. Override in tests as needed. */
  rpc(_fn: string, _params?: Record<string, unknown>): PromiseLike<QueryResult> {
    return Promise.resolve({ data: [], error: null });
  }
}

/** Factory function for creating a mock Supabase client with canned data. */
export function createMockSupabaseClient(tableData: Map<string, Row[]>): MockSupabaseClient {
  return new MockSupabaseClient(tableData);
}
