/**
 * @jest-environment node
 *
 * Unit coverage for the LTI authorization helpers in lib/lti/auth.ts, which gate
 * the privileged roster-sync / grade-push endpoints. Two paths matter:
 *  - isCronAuthorized: the shared-secret check for the cron/trigger drain path.
 *    A regression here either 401s legitimate auto-sync or opens the endpoint up.
 *  - isInstructorOfClass: must delegate to the canonical authz RPCs
 *    (authorizeforclassinstructor / authorize_for_admin) the rest of the app uses,
 *    NOT a hand-rolled user_roles query that can silently drift from them.
 */
import { isCronAuthorized, isInstructorOfClass, isSiteAdmin } from "@/lib/lti/auth";

function fakeRequest(headerValue: string | null): Request {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { headers: { get: (k: string) => (k === "x-lti-cron-secret" ? headerValue : null) } } as any;
}

describe("isCronAuthorized", () => {
  const ORIGINAL = process.env.LTI_CRON_SHARED_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LTI_CRON_SHARED_SECRET;
    else process.env.LTI_CRON_SHARED_SECRET = ORIGINAL;
  });

  test("false when no server secret is configured (fail closed)", () => {
    delete process.env.LTI_CRON_SHARED_SECRET;
    expect(isCronAuthorized(fakeRequest("anything"))).toBe(false);
  });

  test("false when the request carries no secret header", () => {
    process.env.LTI_CRON_SHARED_SECRET = "s3cr3t-value";
    expect(isCronAuthorized(fakeRequest(null))).toBe(false);
  });

  test("false on a wrong-length secret (constant-time path must not throw)", () => {
    process.env.LTI_CRON_SHARED_SECRET = "s3cr3t-value";
    expect(isCronAuthorized(fakeRequest("short"))).toBe(false);
  });

  test("false on a same-length but mismatched secret", () => {
    process.env.LTI_CRON_SHARED_SECRET = "abcdefghij";
    expect(isCronAuthorized(fakeRequest("ABCDEFGHIJ"))).toBe(false);
  });

  test("true on an exact match", () => {
    process.env.LTI_CRON_SHARED_SECRET = "s3cr3t-value";
    expect(isCronAuthorized(fakeRequest("s3cr3t-value"))).toBe(true);
  });
});

describe("isInstructorOfClass — delegates to the canonical authz RPCs", () => {
  /** Fake cookie-bound client whose rpc() returns per-function booleans and records calls. */
  function makeClient(answers: { authorizeforclassinstructor?: boolean; authorize_for_admin?: boolean }) {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const rpc = jest.fn(async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: (answers as Record<string, boolean | undefined>)[fn] ?? false, error: null };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { client: { rpc } as any, calls };
  }

  test("true when the class-instructor gate passes", async () => {
    const { client, calls } = makeClient({ authorizeforclassinstructor: true });
    expect(await isInstructorOfClass(client, 100)).toBe(true);
    // It must call the canonical RPCs, not a raw user_roles query.
    expect(calls.map((c) => c.fn).sort()).toEqual(["authorize_for_admin", "authorizeforclassinstructor"]);
    expect(calls.find((c) => c.fn === "authorizeforclassinstructor")?.args).toEqual({ class__id: 100 });
  });

  test("true when the site-admin gate passes (folds admin in)", async () => {
    const { client } = makeClient({ authorize_for_admin: true });
    expect(await isInstructorOfClass(client, 100)).toBe(true);
  });

  test("false when neither gate passes", async () => {
    const { client } = makeClient({});
    expect(await isInstructorOfClass(client, 100)).toBe(false);
  });
});

describe("isSiteAdmin", () => {
  /** Fake client: getUser() + a user_roles query resolving to `rows`. */
  function makeClient(user: { id: string } | null, rows: unknown[]) {
    const auth = { getUser: jest.fn(async () => ({ data: { user } })) };
    const from = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      const chain = () => b;
      b.select = chain;
      b.eq = chain;
      b.or = chain;
      b.limit = chain;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      b.then = (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      return b;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { auth, from } as any;
  }

  test("false when there is no signed-in user", async () => {
    expect(await isSiteAdmin(makeClient(null, []))).toBe(false);
  });

  test("true when an admin role row exists", async () => {
    expect(await isSiteAdmin(makeClient({ id: "u1" }, [{ id: 1 }]))).toBe(true);
  });

  test("false when no admin role row exists", async () => {
    expect(await isSiteAdmin(makeClient({ id: "u1" }, []))).toBe(false);
  });
});
