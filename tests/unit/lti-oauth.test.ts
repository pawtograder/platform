/**
 * @jest-environment node
 *
 * Unit coverage for the service-token caching in lib/lti/oauth.ts. The grade-push
 * pool fires up to 8 concurrent score publishes; on a cold cache they all call
 * getServiceAccessToken at once. Without single-flight that stampedes the
 * platform's token endpoint with N simultaneous client_credentials mints (some
 * platforms 429); and without a short platform cache every call re-SELECTs
 * lti_platforms. These tests pin both behaviors.
 */
// Stub the signing key and JWT signer so no real crypto/network is needed.
jest.mock("@/lib/lti/keys", () => ({
  getCurrentSigningKey: jest.fn(async () => ({ alg: "RS256", kid: "k1", key: {} }))
}));
jest.mock("jose", () => {
  class FakeSignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setSubject() {
      return this;
    }
    setAudience() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    setJti() {
      return this;
    }
    async sign() {
      return "assertion.jwt";
    }
  }
  return { SignJWT: FakeSignJWT };
});

import { getServiceAccessToken, _clearTokenCache } from "@/lib/lti/oauth";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake db that counts lti_platforms SELECTs. */
function makePlatformDb() {
  const counts = { platformSelects: 0 };
  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.single = async () => {
      if (table === "lti_platforms") counts.platformSelects += 1;
      return {
        data: {
          id: 10,
          client_id: "client-abc",
          auth_login_url: "https://canvas.test/auth",
          token_url: "https://canvas.test/token"
        },
        error: null
      };
    };
    return builder;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, counts };
}

let fetchCount = 0;
beforeEach(() => {
  _clearTokenCache();
  fetchCount = 0;
  global.fetch = (async () => {
    fetchCount += 1;
    await delay(20); // hold the request open so concurrent callers overlap
    return {
      ok: true,
      json: async () => ({ access_token: "tok-1", expires_in: 3600 })
    };
  }) as unknown as typeof fetch;
});

describe("getServiceAccessToken — single-flight", () => {
  test("concurrent cold-cache callers mint exactly one token", async () => {
    const { db } = makePlatformDb();
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () =>
        getServiceAccessToken(10, ["https://purl.imsglobal.org/spec/lti-ags/scope/score"], db)
      )
    );
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    // The whole point: the token endpoint is hit once, not 8 times.
    expect(fetchCount).toBe(1);
  });
});

describe("getServiceAccessToken — platform cache", () => {
  test("a warm second call issues no extra lti_platforms SELECT and no extra token fetch", async () => {
    const { db, counts } = makePlatformDb();
    await getServiceAccessToken(10, ["scope-x"], db);
    expect(counts.platformSelects).toBe(1);
    expect(fetchCount).toBe(1);

    await getServiceAccessToken(10, ["scope-x"], db);
    // platform row served from the short cache; token served from the token cache.
    expect(counts.platformSelects).toBe(1);
    expect(fetchCount).toBe(1);
  });
});
