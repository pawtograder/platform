import type { DataProvider } from "@refinedev/core";
import { retryUnlessMissingRow, withBlockedDeleteErrors, withMissingRowErrors } from "@/lib/refineDataProvider";

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

/** Fake Supabase client recording the delete query and answering with `result`. */
function fakeDeleteClient(result: { data: unknown[] | null; error: { message: string; code: string } | null }) {
  const calls: { resource?: string; schema?: string; filter?: unknown; select?: string } = {};
  const query = {
    select: jest.fn((columns: string) => {
      calls.select = columns;
      return Promise.resolve(result);
    })
  };
  const builder = {
    match: jest.fn((filter: Record<string, unknown>) => {
      calls.filter = filter;
      return query;
    }),
    eq: jest.fn((column: string, value: unknown) => {
      calls.filter = { [column]: value };
      return query;
    })
  };
  const client = {
    from: jest.fn((resource: string) => {
      calls.resource = resource;
      return { delete: () => builder };
    }),
    schema: jest.fn((schema: string) => {
      calls.schema = schema;
      return client;
    })
  };
  return { client, calls };
}

describe("withBlockedDeleteErrors", () => {
  const base = baseProviderReturning({ data: undefined });

  it("rejects with a 403 when RLS refuses the delete (0 rows returned)", async () => {
    const { client } = fakeDeleteClient({ data: [], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    await expect(provider.deleteOne({ resource: "review_assignments", id: 7 })).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(provider.deleteOne({ resource: "review_assignments", id: 7 })).rejects.toThrow(
      /permission to delete this review_assignments record \(id 7\)/
    );
  });

  it("resolves with the deleted row when the delete really happened", async () => {
    const { client, calls } = fakeDeleteClient({ data: [{ id: 7 }], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    await expect(provider.deleteOne({ resource: "review_assignments", id: 7 })).resolves.toEqual({ data: { id: 7 } });
    // Asks for the deleted id back — that is what makes refusal detectable.
    expect(calls).toMatchObject({ resource: "review_assignments", filter: { id: 7 }, select: "id" });
  });

  it("honours idColumnName and schema from meta", async () => {
    const { client, calls } = fakeDeleteClient({ data: [{ uuid: "u1" }], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    await provider.deleteOne({ resource: "tags", id: "u1", meta: { idColumnName: "uuid", schema: "public" } });
    expect(calls).toMatchObject({ schema: "public", filter: { uuid: "u1" }, select: "uuid" });
  });

  it("rethrows PostgREST errors with a numeric statusCode, like upstream", async () => {
    const { client } = fakeDeleteClient({ data: null, error: { message: "fk violation", code: "23503" } });
    const provider = withBlockedDeleteErrors(base, client);

    await expect(provider.deleteOne({ resource: "assignments", id: 1 })).rejects.toMatchObject({
      message: "fk violation",
      statusCode: 23503
    });
  });

  it("does not touch the other provider methods", () => {
    const { client } = fakeDeleteClient({ data: [], error: null });
    const provider = withBlockedDeleteErrors(base, client);

    expect(provider.update).toBe(base.update);
    expect(provider.getOne).toBe(base.getOne);
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
