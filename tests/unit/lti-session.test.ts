/**
 * @jest-environment node
 *
 * Unit coverage for the LTI launch → Supabase session bridge in lib/lti/session.ts.
 * This module had ZERO coverage, yet it holds the most security-sensitive decision
 * in the integration: which Pawtograder account a launch is signed into. A max-effort
 * review found it would adopt ANY existing account matching the platform-asserted
 * `email` (account takeover). These tests pin the hardened resolution order:
 *
 *   1. an existing (platform_id, sub) identity binding wins outright (returning user);
 *   2. otherwise a pre-existing account is adopted by email ONLY when the launch
 *      doesn't mark the email unverified AND the target account's email is confirmed;
 *   3. otherwise a fresh account is provisioned;
 *   4. the returned userId is the auth user the magic link actually signs in as.
 *
 * The Supabase admin auth surface and the cookie-bound client are faked so the test
 * asserts pure decision logic with no network/DB.
 */
import { establishSupabaseSession, resolveLaunchRedirect, LtiSessionError } from "@/lib/lti/session";
import type { LtiLaunchContext } from "@/lib/lti/types";

type Opts = {
  binding?: { user_id: string | null } | null; // lti_users (platform_id, sub) row
  usersByEmail?: Array<{ user_id: string; email: string | null }>;
};

/** Fake service-role admin client: lti_users binding lookup, users-by-email lookup,
 *  and the auth.admin surface (getUserById / createUser / generateLink). Records the
 *  lti_users UPDATE so a test can assert which userId the binding is stamped with. */
function makeAdminClient(opts: Opts) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const getUserById = jest.fn(async (_id: string) => ({
    data: { user: { id: _id, email_confirmed_at: null as string | null } },
    error: null
  }));
  const createUser = jest.fn(async () => ({ data: { user: { id: "created-user" } }, error: null }));
  const generateLink = jest.fn(async () => ({
    data: { user: { id: "link-user" }, properties: { hashed_token: "hashed-otp" } },
    error: null
  }));

  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = { _update: undefined };
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.in = chain;
    b.update = (payload: unknown) => {
      b._update = payload;
      return b;
    };
    const read = () => {
      if (table === "lti_users") return { data: opts.binding ?? null, error: null };
      if (table === "users") return { data: opts.usersByEmail ?? [], error: null };
      return { data: null, error: null };
    };
    b.maybeSingle = async () => read();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (resolve: any, reject: any) => {
      if (b._update !== undefined) {
        updates.push({ table, payload: b._update });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve(read()).then(resolve, reject);
    };
    return b;
  };

  const adminClient = {
    from,
    auth: { admin: { getUserById, createUser, generateLink } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { adminClient, updates, getUserById, createUser, generateLink };
}

function makeServerClient(verifyResult: { error: unknown } = { error: null }) {
  const verifyOtp = jest.fn(async () => verifyResult);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { serverClient: { auth: { verifyOtp } } as any, verifyOtp };
}

function launchCtx(over: Partial<LtiLaunchContext> = {}): LtiLaunchContext {
  return {
    platformId: 10,
    issuer: "https://canvas.test",
    clientId: "client-1",
    deploymentId: "dep-1",
    sub: "sub-1",
    email: "Student@School.EDU",
    roles: [],
    appRole: "student",
    rawClaims: {},
    ...over
  } as LtiLaunchContext;
}

describe("establishSupabaseSession — account resolution", () => {
  test("a returning user resolves via the (platform_id, sub) binding; the email-adoption path is never touched", async () => {
    const { adminClient, getUserById } = makeAdminClient({ binding: { user_id: "bound-user" } });
    const { serverClient } = makeServerClient();
    const { userId } = await establishSupabaseSession(launchCtx(), serverClient, adminClient);
    // generateLink resolves the actual session user; for a returning user it is the bound user.
    expect(userId).toBe("link-user");
    // The email-confirmation gate must NOT run when the binding already resolves the user.
    expect(getUserById).not.toHaveBeenCalled();
  });

  test("first launch: adopts a pre-existing account ONLY when its email is confirmed", async () => {
    const { adminClient, getUserById } = makeAdminClient({
      binding: null,
      usersByEmail: [{ user_id: "cand-user", email: "student@school.edu" }]
    });
    getUserById.mockResolvedValueOnce({
      data: { user: { id: "cand-user", email_confirmed_at: "2026-01-01T00:00:00Z" } },
      error: null
    });
    const { serverClient } = makeServerClient();
    await expect(establishSupabaseSession(launchCtx(), serverClient, adminClient)).resolves.toBeDefined();
    expect(getUserById).toHaveBeenCalledWith("cand-user");
  });

  test("first launch: refuses to adopt a pre-existing account whose email is NOT confirmed (squat guard)", async () => {
    const { adminClient, getUserById } = makeAdminClient({
      binding: null,
      usersByEmail: [{ user_id: "cand-user", email: "student@school.edu" }]
    });
    // default getUserById returns email_confirmed_at: null
    const { serverClient } = makeServerClient();
    await expect(establishSupabaseSession(launchCtx(), serverClient, adminClient)).rejects.toBeInstanceOf(
      LtiSessionError
    );
    expect(getUserById).toHaveBeenCalledWith("cand-user");
  });

  test("first launch: refuses adoption when the platform marks the email unverified, before any lookup", async () => {
    const { adminClient, getUserById } = makeAdminClient({
      binding: null,
      usersByEmail: [{ user_id: "cand-user", email: "student@school.edu" }]
    });
    const { serverClient } = makeServerClient();
    await expect(
      establishSupabaseSession(launchCtx({ emailVerified: false }), serverClient, adminClient)
    ).rejects.toBeInstanceOf(LtiSessionError);
    // emailVerified === false short-circuits before the confirmed-email check.
    expect(getUserById).not.toHaveBeenCalled();
  });

  test("first launch with no matching account provisions a fresh auth user", async () => {
    const { adminClient, createUser, getUserById } = makeAdminClient({ binding: null, usersByEmail: [] });
    const { serverClient } = makeServerClient();
    await establishSupabaseSession(launchCtx(), serverClient, adminClient);
    expect(createUser).toHaveBeenCalledTimes(1);
    // No pre-existing account to adopt → the confirmed-email gate is irrelevant.
    expect(getUserById).not.toHaveBeenCalled();
  });

  test("returned userId is the auth user the magic link signs in as, even when an earlier id diverges", async () => {
    // Binding points at a stale id; generateLink's user (the actual session) is different.
    const { adminClient, generateLink } = makeAdminClient({ binding: { user_id: "stale-id" } });
    generateLink.mockResolvedValueOnce({
      data: { user: { id: "real-session-id" }, properties: { hashed_token: "h" } },
      error: null
    });
    const { serverClient } = makeServerClient();
    const { userId } = await establishSupabaseSession(launchCtx(), serverClient, adminClient);
    expect(userId).toBe("real-session-id");
  });

  test("stamps the identity binding with the resolved session userId", async () => {
    const { adminClient, updates } = makeAdminClient({ binding: { user_id: "bound-user" } });
    const { serverClient } = makeServerClient();
    await establishSupabaseSession(launchCtx(), serverClient, adminClient);
    const ltiUserUpdate = updates.find((u) => u.table === "lti_users");
    expect(ltiUserUpdate?.payload).toEqual({ user_id: "link-user" });
  });

  test("rejects a launch that shares no email", async () => {
    const { adminClient } = makeAdminClient({ binding: null });
    const { serverClient } = makeServerClient();
    await expect(
      establishSupabaseSession(launchCtx({ email: undefined }), serverClient, adminClient)
    ).rejects.toBeInstanceOf(LtiSessionError);
  });
});

describe("resolveLaunchRedirect", () => {
  test("enrolled + a validated deep-link assignment id → the assignment page", () => {
    expect(resolveLaunchRedirect(42, true, 7)).toBe("/course/42/assignments/7");
  });

  test("enrolled with no deep-link id → the course home", () => {
    expect(resolveLaunchRedirect(42, true, null)).toBe("/course/42");
    expect(resolveLaunchRedirect(42, true)).toBe("/course/42");
  });

  test("not enrolled (or no class) → the home page with the unlinked hint", () => {
    expect(resolveLaunchRedirect(42, false, 7)).toBe("/?lti_unlinked=1");
    expect(resolveLaunchRedirect(null, true)).toBe("/?lti_unlinked=1");
    expect(resolveLaunchRedirect(undefined, true)).toBe("/?lti_unlinked=1");
  });
});
