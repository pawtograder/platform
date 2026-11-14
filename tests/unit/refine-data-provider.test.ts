import type { DataProvider } from "@refinedev/core";
import {
  isRefusedWriteError,
  retryUnlessMissingRow,
  withBlockedDeleteErrors,
  withMissingRowErrors
} from "@/lib/refineDataProvider";

/**
 * Minimal stand-in for the `@refinedev/supabase` provider: only the response
 * shapes of `getOne` and `update` matter here.
 */
function baseProviderReturning(response: unknown, updateResponse: unknown = { data: { id: "x" } }): DataProvider {
  return {
    getOne: jest.fn().mockResolvedValue(response),
    getList: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue(updateResponse),
    deleteOne: jest.fn(),
    getApiUrl: () => ""
  } as unknown as DataProvider;
}

describe("withMissingRowErrors", () => {
  it("rejects with a 404 when the row is not visible to the session", async () => {
    // What @refinedev/supabase actually returns for `200 []`: a defined
    // response whose `data` is undefined. That is what makes `result?.data.name`
    // throw in consumers.
    const provider = withMissingRowErrors(baseProviderReturning({ data: undefined }));

    await expect(provider.getOne({ resource: "profiles", id: "profile-a" })).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it("rejects when the row comes back null", async () => {
    const provider = withMissingRowErrors(baseProviderReturning({ data: null }));

    await expect(provider.getOne({ resource: "profiles", id: "profile-a" })).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it("names the resource and id so the failure is diagnosable", async () => {
    const provider = withMissingRowErrors(baseProviderReturning({ data: undefined }));

    await expect(provider.getOne({ resource: "profiles", id: "profile-a" })).rejects.toThrow(/profiles.*profile-a/);
  });

  it("passes a found row straight through", async () => {
    const row = { id: "profile-a", name: "Ada" };
    const provider = withMissingRowErrors(baseProviderReturning({ data: row }));

    await expect(provider.getOne({ resource: "profiles", id: "profile-a" })).resolves.toEqual({ data: row });
  });

  it("leaves list, create and delete untouched", async () => {
    const base = baseProviderReturning({ data: undefined });
    const provider = withMissingRowErrors(base);

    expect(provider.getList).toBe(base.getList);
    expect(provider.create).toBe(base.create);
    expect(provider.deleteOne).toBe(base.deleteOne);
  });

  describe("update", () => {
    const params = { resource: "assignments", id: 42, variables: { title: "New title" } };

    it("rejects with a 403 when RLS refuses the write (200 [] -> data undefined)", async () => {
      // A grader saving Edit Assignment: upstream returns { data: undefined }, no error.
      const provider = withMissingRowErrors(baseProviderReturning({ data: { id: 1 } }, { data: undefined }));

      await expect(provider.update(params)).rejects.toMatchObject({ statusCode: 403 });
    });

    it("rejects when the updated row comes back null", async () => {
      const provider = withMissingRowErrors(baseProviderReturning({ data: { id: 1 } }, { data: null }));

      await expect(provider.update(params)).rejects.toMatchObject({ statusCode: 403 });
    });

    it("tells the user nothing was saved, naming the resource and id", async () => {
      const provider = withMissingRowErrors(baseProviderReturning({ data: { id: 1 } }, { data: undefined }));

      await expect(provider.update(params)).rejects.toThrow(
        /permission to update this assignments record \(id 42\).*Nothing was changed/
      );
    });

    it("passes a real update straight through", async () => {
      const row = { id: 42, title: "New title" };
      const provider = withMissingRowErrors(baseProviderReturning({ data: row }, { data: row }));

      await expect(provider.update(params)).resolves.toEqual({ data: row });
    });

    it("lets PostgREST errors from upstream through unchanged", async () => {
      const base = baseProviderReturning({ data: { id: 1 } });
      const upstreamError = { message: "duplicate key", statusCode: 23505 };
      (base.update as jest.Mock).mockRejectedValue(upstreamError);

      await expect(withMissingRowErrors(base).update(params)).rejects.toBe(upstreamError);
    });
  });
});

/** Awaits a promise that must reject and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

type QueryResult = { data: unknown[] | null; error: { message: string; code: string } | null };

/** One query the fake client saw: delete or follow-up select, with its filter and columns. */
type RecordedQuery = {
  kind: "delete" | "select";
  resource: string;
  schema?: string;
  filter?: Record<string, unknown>;
  columns?: string;
  limit?: number;
};

/**
 * Fake Supabase client. The delete answers with `deleteResult`; the follow-up
 * select (only made when the delete returns no rows) answers with
 * `selectResult`. Every query is recorded in `queries`, in order.
 */
function fakeDeleteClient(deleteResult: QueryResult, selectResult: QueryResult = { data: [], error: null }) {
  const queries: RecordedQuery[] = [];
  let currentSchema: string | undefined;

  const filterable = <T>(query: RecordedQuery, next: () => T) => ({
    match: jest.fn((filter: Record<string, unknown>) => {
      query.filter = filter;
      return next();
    }),
    eq: jest.fn((column: string, value: unknown) => {
      query.filter = { [column]: value };
      return next();
    })
  });

  const client: Parameters<typeof withBlockedDeleteErrors>[1] = {
    from: jest.fn((resource: string) => {
      const schema = currentSchema;
      return {
        delete: () => {
          const query: RecordedQuery = { kind: "delete", resource, schema };
          queries.push(query);
          return filterable(query, () => ({
            select: jest.fn((columns: string) => {
              query.columns = columns;
              return Promise.resolve(deleteResult);
            })
          }));
        },
        select: (columns: string) => {
          const query: RecordedQuery = { kind: "select", resource, schema, columns };
          queries.push(query);
          return filterable(query, () => ({
            limit: jest.fn((count: number) => {
              query.limit = count;
              return Promise.resolve(selectResult);
            })
          }));
        }
      };
    }),
    schema: jest.fn((schema: string) => {
      currentSchema = schema;
      return client;
    })
  };
  return { client, queries };
}

describe("withBlockedDeleteErrors", () => {
  const base = baseProviderReturning({ data: undefined });

  it("resolves with the deleted row when the delete really happened, without a follow-up select", async () => {
    const { client, queries } = fakeDeleteClient({ data: [{ id: 7 }], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    await expect(provider.deleteOne({ resource: "review_assignments", id: 7 })).resolves.toEqual({ data: { id: 7 } });
    // Asks for the deleted id back. That is what makes refusal detectable.
    expect(queries).toEqual([{ kind: "delete", resource: "review_assignments", filter: { id: 7 }, columns: "id" }]);
  });

  describe("when the delete returns no rows", () => {
    it("rejects with a 403 when the row is still visible (RLS refused the delete)", async () => {
      // #1127: a grader can see a review assignment they're assigned to, but only managers may delete it.
      const { client } = fakeDeleteClient({ data: [], error: null }, { data: [{ id: 7 }], error: null });
      const provider = withBlockedDeleteErrors(base, client);

      const error = await rejectionOf(provider.deleteOne({ resource: "review_assignments", id: 7 }));
      expect(error).toMatchObject({ statusCode: 403 });
      expect((error as Error).message).toMatch(/permission to delete this review_assignments record \(id 7\)/);
      expect(isRefusedWriteError(error)).toBe(true);
    });

    it("checks visibility with a filtered select on the same row", async () => {
      const { client, queries } = fakeDeleteClient({ data: [], error: null }, { data: [{ id: 7 }], error: null });
      const provider = withBlockedDeleteErrors(base, client);

      await expect(provider.deleteOne({ resource: "review_assignments", id: 7 })).rejects.toThrow();
      expect(queries).toEqual([
        { kind: "delete", resource: "review_assignments", filter: { id: 7 }, columns: "id" },
        { kind: "select", resource: "review_assignments", filter: { id: 7 }, columns: "id", limit: 1 }
      ]);
    });

    it("resolves when the row is no longer visible (already deleted: second tab, double click, realtime race)", async () => {
      const { client } = fakeDeleteClient({ data: [], error: null }, { data: [], error: null });
      const provider = withBlockedDeleteErrors(base, client);

      await expect(provider.deleteOne({ resource: "notifications", id: 7 })).resolves.toEqual({ data: { id: 7 } });
    });

    it("treats a null follow-up result as gone", async () => {
      const { client } = fakeDeleteClient({ data: null, error: null }, { data: null, error: null });
      const provider = withBlockedDeleteErrors(base, client);

      await expect(provider.deleteOne({ resource: "tags", id: "t1" })).resolves.toEqual({ data: { id: "t1" } });
    });

    it("honours idColumnName and schema in the follow-up select and the resolved data", async () => {
      const { client, queries } = fakeDeleteClient({ data: [], error: null }, { data: [], error: null });
      const provider = withBlockedDeleteErrors(base, client);

      await expect(
        provider.deleteOne({ resource: "tags", id: "u1", meta: { idColumnName: "uuid", schema: "public" } })
      ).resolves.toEqual({ data: { uuid: "u1" } });
      expect(queries[1]).toEqual({
        kind: "select",
        resource: "tags",
        schema: "public",
        filter: { uuid: "u1" },
        columns: "uuid",
        limit: 1
      });
    });

    it("rethrows a PostgREST error from the follow-up select", async () => {
      const { client } = fakeDeleteClient(
        { data: [], error: null },
        { data: null, error: { message: "permission denied for table tags", code: "42501" } }
      );
      const provider = withBlockedDeleteErrors(base, client);

      const error = await rejectionOf(provider.deleteOne({ resource: "tags", id: "t1" }));
      expect(error).toMatchObject({ message: "permission denied for table tags", statusCode: 42501 });
      expect(isRefusedWriteError(error)).toBe(false);
    });
  });

  it("honours idColumnName and schema from meta", async () => {
    const { client, queries } = fakeDeleteClient({ data: [{ uuid: "u1" }], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    await provider.deleteOne({ resource: "tags", id: "u1", meta: { idColumnName: "uuid", schema: "public" } });
    expect(queries).toEqual([
      { kind: "delete", resource: "tags", schema: "public", filter: { uuid: "u1" }, columns: "uuid" }
    ]);
  });

  it("rethrows PostgREST errors with a numeric statusCode, like upstream, without a follow-up select", async () => {
    const { client, queries } = fakeDeleteClient({ data: null, error: { message: "fk violation", code: "23503" } });
    const provider = withBlockedDeleteErrors(base, client);

    await expect(provider.deleteOne({ resource: "assignments", id: 1 })).rejects.toMatchObject({
      message: "fk violation",
      statusCode: 23503
    });
    expect(queries).toHaveLength(1);
  });

  it("does not touch the other provider methods", () => {
    const { client } = fakeDeleteClient({ data: [], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    expect(provider.update).toBe(base.update);
    expect(provider.getOne).toBe(base.getOne);
  });
});

describe("isRefusedWriteError", () => {
  it("is true for a refused update", async () => {
    const provider = withMissingRowErrors(baseProviderReturning({ data: { id: 1 } }, { data: undefined }));

    const error = await rejectionOf(provider.update({ resource: "assignments", id: 42, variables: {} }));
    expect(isRefusedWriteError(error)).toBe(true);
  });

  it("is false for the 404 from getOne, PostgREST errors, plain errors and non-errors", () => {
    expect(isRefusedWriteError(Object.assign(new Error("no such row"), { statusCode: 404 }))).toBe(false);
    expect(isRefusedWriteError(Object.assign(new Error("rls"), { code: "42501", statusCode: 42501 }))).toBe(false);
    // A plain 403 from elsewhere is not one of ours.
    expect(isRefusedWriteError(Object.assign(new Error("forbidden"), { statusCode: 403 }))).toBe(false);
    expect(isRefusedWriteError(new Error("boom"))).toBe(false);
    expect(isRefusedWriteError({ refusedWrite: true })).toBe(false);
    expect(isRefusedWriteError(undefined)).toBe(false);
  });
});

describe("retryUnlessMissingRow", () => {
  it("does not retry a missing row — the answer will not change, and the wait is user-visible", () => {
    // Without this, React Query's default retries hold `useOne` in its loading
    // state through several seconds of backoff before the not-found UI appears.
    expect(retryUnlessMissingRow(0, Object.assign(new Error("no such row"), { statusCode: 404 }))).toBe(false);
  });

  it("keeps the default three retries for anything that might succeed later", () => {
    const flaky = Object.assign(new Error("network"), { statusCode: 500 });

    expect(retryUnlessMissingRow(0, flaky)).toBe(true);
    expect(retryUnlessMissingRow(2, flaky)).toBe(true);
    expect(retryUnlessMissingRow(3, flaky)).toBe(false);
  });

  it("retries errors that carry no status", () => {
    expect(retryUnlessMissingRow(0, new Error("boom"))).toBe(true);
    expect(retryUnlessMissingRow(0, undefined)).toBe(true);
  });
});
