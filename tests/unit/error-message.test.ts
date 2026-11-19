import { getErrorMessage } from "@/lib/errorMessage";
import { createDataProvider } from "@/lib/refineDataProvider";
import { getUserFacingErrorMessage } from "@/lib/studentFacingErrorMessages";

jest.mock("@sentry/nextjs", () => ({ withScope: jest.fn(), captureException: jest.fn() }));

/** The mapper's 42501 wording for a grader. */
const GRADER_DENIED = "You don't have permission to do that. If you need access, ask an instructor for this course.";

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

  it("gives the same text as getUserFacingErrorMessage, so one screen shows one kind of error", () => {
    const values: unknown[] = [
      new Error("boom"),
      { ...RLS_VIOLATION, statusCode: 42501 },
      { code: "23505", message: "duplicate key value violates unique constraint" },
      "plain string",
      { message: 42 },
      null,
      undefined
    ];
    for (const value of values) {
      for (const context of [undefined, { role: "grader" as const }, { role: "instructor" as const }]) {
        expect(getErrorMessage(value, context)).toBe(getUserFacingErrorMessage(value, context));
      }
    }
  });

  it("maps a PostgREST permission error, which refine rejects as a plain object, for the given role", () => {
    expect(getErrorMessage({ ...RLS_VIOLATION, statusCode: 42501 }, { role: "grader" })).toBe(GRADER_DENIED);
  });

  it("never shows [object Object], null or undefined", () => {
    for (const value of [{ message: 42 }, null, undefined]) {
      expect(getErrorMessage(value)).toBe("Something went wrong. Please try again.");
    }
    expect(getErrorMessage("plain string")).toBe("plain string");
  });
});

describe("PostgREST errors from the app's data provider", () => {
  it("update: the toast text is the mapped permission message, not [object Object]", async () => {
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
    expect(getErrorMessage(error, { role: "grader" })).toBe(GRADER_DENIED);
  });

  it("create: the toast text is the mapped permission message", async () => {
    const provider = createDataProvider(clientResolving({ data: null, error: RLS_VIOLATION }));

    const error = await provider.create({ resource: "help_queue_assignments", variables: {} }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getErrorMessage(error, { role: "grader" })).toBe(GRADER_DENIED);
  });

  it("deleteOne: the toast text is the mapped permission message", async () => {
    const provider = createDataProvider(clientResolving({ data: null, error: RLS_VIOLATION }));

    const error = await provider.deleteOne({ resource: "help_queue_assignments", id: 1 }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getErrorMessage(error, { role: "grader" })).toBe(GRADER_DENIED);
  });
});
