import { getErrorMessage } from "@/lib/errorMessage";
import { createDataProvider } from "@/lib/refineDataProvider";

/** What PostgREST sends back when RLS rejects a write that it can see, e.g. an insert. */
const RLS_VIOLATION = {
  message: 'new row violates row-level security policy for table "help_queue_assignments"',
  code: "42501",
  details: null,
  hint: null
};

/**
 * A Supabase client whose every query resolves with `result`. The real
 * `@refinedev/supabase` provider calls `.match()`/`.eq()`/`.select()` on the
 * builder without using their return values, then awaits the builder itself.
 */
function clientResolving(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["update", "insert", "delete", "select", "match", "eq", "in", "limit"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { from: () => builder } as unknown as Parameters<typeof createDataProvider>[0];
}

describe("getErrorMessage", () => {
  it("returns the message of an Error", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message of a plain object, which is how refine rejects PostgREST errors", () => {
    expect(getErrorMessage({ ...RLS_VIOLATION, statusCode: 42501 })).toBe(RLS_VIOLATION.message);
  });

  it("falls back to String() for values without a string message", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage({ message: 42 })).toBe("[object Object]");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});

describe("PostgREST errors from the app's data provider", () => {
  it("update: the toast text is the database message, not [object Object]", async () => {
    const provider = createDataProvider(clientResolving({ data: null, error: RLS_VIOLATION }));

    const error = await provider
      .update({ resource: "help_queue_assignments", id: 1, variables: { is_active: false } })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    // The thing the old `instanceof Error ? ... : String(error)` pattern got wrong.
    expect(error).not.toBeInstanceOf(Error);
    expect(String(error)).toBe("[object Object]");
    expect(getErrorMessage(error)).toBe(RLS_VIOLATION.message);
  });

  it("create: the toast text is the database message", async () => {
    const provider = createDataProvider(clientResolving({ data: null, error: RLS_VIOLATION }));

    const error = await provider.create({ resource: "help_queue_assignments", variables: {} }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getErrorMessage(error)).toBe(RLS_VIOLATION.message);
  });

  it("deleteOne: the toast text is the database message", async () => {
    const provider = createDataProvider(clientResolving({ data: null, error: RLS_VIOLATION }));

    const error = await provider.deleteOne({ resource: "help_queue_assignments", id: 1 }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getErrorMessage(error)).toBe(RLS_VIOLATION.message);
  });
});
