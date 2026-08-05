import type { DataProvider } from "@refinedev/core";
import { withMissingRowErrors } from "@/lib/refineDataProvider";

/**
 * Minimal stand-in for the `@refinedev/supabase` provider: only `getOne` is
 * wrapped, and only its response shape matters here.
 */
function baseProviderReturning(response: unknown): DataProvider {
  return {
    getOne: jest.fn().mockResolvedValue(response),
    getList: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
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

  it("leaves the other provider methods untouched", async () => {
    const base = baseProviderReturning({ data: undefined });
    const provider = withMissingRowErrors(base);

    expect(provider.getList).toBe(base.getList);
    expect(provider.update).toBe(base.update);
  });
});
