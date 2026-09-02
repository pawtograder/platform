/**
 * @jest-environment node
 *
 * Unit coverage for id_token validation + claim projection in lib/lti/jwt.ts
 * (previously zero coverage). The signature check (jose) and the platform/nonce DB
 * are faked, so the test pins the LTI security sequence and the projected shape:
 *  - email_verified is captured onto the launch context (gates account adoption in
 *    session.ts — see lti-session.test.ts);
 *  - core claims (context / nrps / ags / custom / roles) project correctly;
 *  - the nonce is consumed (single-use) during verification, and a consumed nonce
 *    is rejected as a replay.
 */
import { jwtVerify } from "jose";
import { LTI_CLAIM, LTI_MESSAGE_TYPE } from "@/lib/lti/types";

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => ({})),
  jwtVerify: jest.fn()
}));
jest.mock("@/lib/lti/db", () => ({ ltiAdminClient: jest.fn() }));

import { verifyLaunchToken, LtiValidationError } from "@/lib/lti/jwt";

const jwtVerifyMock = jwtVerify as jest.Mock;

const ISS = "https://canvas.test";
const AUD = "client-abc";

/** Build a syntactically-valid JWT string whose payload carries iss/aud (read by
 *  the unverified peek for platform lookup). jose is mocked, so the signature is
 *  irrelevant and the verified payload is supplied separately via jwtVerifyMock. */
function makeToken(claims: Record<string, unknown>): string {
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}.sig`;
}

/** A complete, valid set of verified claims; tests override individual fields. */
function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    aud: AUD,
    sub: "user-sub-1",
    nonce: "nonce-1",
    [LTI_CLAIM.version]: "1.3.0",
    [LTI_CLAIM.messageType]: LTI_MESSAGE_TYPE.resourceLinkRequest,
    [LTI_CLAIM.deploymentId]: "dep-1",
    email: "person@school.edu",
    name: "Person Example",
    [LTI_CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    ...over
  };
}

/** Fake admin db: lti_platforms lookup + lti_consume_nonce rpc (records calls). */
function makeDb(opts: { enabled?: boolean; nonceFresh?: boolean } = {}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const from = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (resolve: any, reject: any) =>
      Promise.resolve({
        data: [
          {
            id: 10,
            issuer: ISS,
            client_id: AUD,
            jwks_url: "https://canvas.test/jwks",
            enabled: opts.enabled ?? true
          }
        ],
        error: null
      }).then(resolve, reject);
    return b;
  };
  const rpc = async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return { data: opts.nonceFresh ?? true, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from, rpc } as any, rpcCalls };
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe("verifyLaunchToken — email_verified projection", () => {
  test.each([
    [true, true],
    [false, false],
    [undefined, undefined]
  ])("email_verified=%p projects to ctx.emailVerified=%p", async (claim, expected) => {
    const claims = baseClaims(claim === undefined ? {} : { email_verified: claim });
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb();
    const ctx = await verifyLaunchToken(makeToken(claims), { db });
    expect(ctx.emailVerified).toBe(expected);
  });
});

describe("verifyLaunchToken — claim projection", () => {
  test("projects context / nrps / ags / custom / roles", async () => {
    const claims = baseClaims({
      [LTI_CLAIM.context]: { id: "ctx-1", label: "CS101", title: "Intro" },
      [LTI_CLAIM.nrps]: { context_memberships_url: "https://canvas.test/nrps" },
      [LTI_CLAIM.ags]: { lineitems: "https://canvas.test/li", scope: ["score"] },
      [LTI_CLAIM.custom]: { assignment_id: "42" },
      [LTI_CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"]
    });
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb();
    const ctx = await verifyLaunchToken(makeToken(claims), { db });
    expect(ctx.platformId).toBe(10);
    expect(ctx.sub).toBe("user-sub-1");
    expect(ctx.context).toEqual({ id: "ctx-1", label: "CS101", title: "Intro" });
    expect(ctx.nrpsUrl).toBe("https://canvas.test/nrps");
    expect(ctx.ags?.lineItemsUrl).toBe("https://canvas.test/li");
    expect(ctx.custom?.assignment_id).toBe("42");
    expect(ctx.appRole).toBe("instructor");
  });
});

describe("verifyLaunchToken — nonce single-use", () => {
  test("consumes the nonce during verification", async () => {
    const claims = baseClaims();
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db, rpcCalls } = makeDb({ nonceFresh: true });
    await verifyLaunchToken(makeToken(claims), { db });
    expect(rpcCalls.find((c) => c.fn === "lti_consume_nonce")?.args).toEqual({ p_nonce: "nonce-1" });
  });

  test("rejects a replayed (already-consumed) nonce", async () => {
    const claims = baseClaims();
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb({ nonceFresh: false });
    await expect(verifyLaunchToken(makeToken(claims), { db })).rejects.toBeInstanceOf(LtiValidationError);
  });

  test("rejects when the token nonce does not match the login-state nonce", async () => {
    const claims = baseClaims({ nonce: "token-nonce" });
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb();
    await expect(verifyLaunchToken(makeToken(claims), { db, expectedNonce: "state-nonce" })).rejects.toBeInstanceOf(
      LtiValidationError
    );
  });
});

describe("verifyLaunchToken — required claims & platform gating", () => {
  test("rejects a disabled platform", async () => {
    const claims = baseClaims();
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb({ enabled: false });
    await expect(verifyLaunchToken(makeToken(claims), { db })).rejects.toBeInstanceOf(LtiValidationError);
  });

  test("rejects a non-resource-link message_type", async () => {
    const claims = baseClaims({ [LTI_CLAIM.messageType]: LTI_MESSAGE_TYPE.deepLinkingRequest });
    jwtVerifyMock.mockResolvedValue({ payload: claims });
    const { db } = makeDb();
    await expect(verifyLaunchToken(makeToken(claims), { db })).rejects.toBeInstanceOf(LtiValidationError);
  });
});
