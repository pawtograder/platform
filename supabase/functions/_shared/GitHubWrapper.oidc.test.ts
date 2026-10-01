/**
 * Unit tests for validateOIDCToken's issuer allowlist: which job tokens can create submissions.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/GitHubWrapper.oidc.test.ts
 * (--no-check: GitHubWrapper transitively imports octokit, whose bundled types trip deno's checker.)
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

// GitHubWrapper builds a GitHub App at import time, which needs a non-empty private key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { validateOIDCToken } = await import("./GitHubWrapper.ts");

const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const FORGEJO_URL = "https://git.example.edu";
const FORGEJO_JWKS_URL = `${FORGEJO_URL}/api/actions/.well-known/keys`;

async function signingKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey: pair.privateKey, jwk };
}

function sign(key: { kid: string; privateKey: CryptoKey }, claims: Record<string, unknown>) {
  const now = getNumericDate(0);
  return create(
    { alg: "RS256", typ: "JWT", kid: key.kid },
    { iat: now, nbf: now, exp: now + 3600, ...claims },
    key.privateKey
  );
}

// Claim shapes taken from real tokens: Forgejo 15.0.9 for a run dispatched on a pawtograder-submit tag.
const forgejoClaims = {
  iss: `${FORGEJO_URL}/api/actions`,
  aud: `${FORGEJO_URL}/demo-class`,
  sub: "repo:demo-class/hw1-student1:ref:refs/tags/pawtograder-submit/fbb8271",
  actor: "pawtograder",
  event_name: "workflow_dispatch",
  ref: "refs/tags/pawtograder-submit/fbb8271",
  ref_type: "tag",
  repository: "demo-class/hw1-student1",
  repository_owner: "demo-class",
  run_id: "4",
  run_attempt: "1",
  sha: "fbb8271",
  workflow_ref: "demo-class/hw1-student1/.github/workflows/grade.yml@refs/tags/pawtograder-submit/fbb8271"
};
const githubClaims = {
  ...forgejoClaims,
  iss: "https://token.actions.githubusercontent.com",
  aud: "https://github.com/demo-class",
  actor: "pawtograder[bot]"
};

/** Serves the given key sets by URL for the duration of `fn`, and records every URL fetched. */
async function withJwks(byUrl: Record<string, { jwk: JsonWebKey }[]>, fn: (fetched: string[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    const keys = byUrl[url];
    if (!keys) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) })));
  }) as typeof fetch;
  try {
    await fn(fetched);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** SecurityError keeps a fixed message and puts the reason in `details`. */
async function assertUntrustedIssuer(fn: () => Promise<unknown>) {
  const err = await assertRejects(fn);
  assertEquals((err as { details?: string }).details?.startsWith("Untrusted OIDC token issuer"), true);
}

async function withForgejoUrl(value: string | undefined, fn: () => Promise<void>) {
  const previous = Deno.env.get("FORGEJO_URL");
  if (value === undefined) Deno.env.delete("FORGEJO_URL");
  else Deno.env.set("FORGEJO_URL", value);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("FORGEJO_URL");
    else Deno.env.set("FORGEJO_URL", previous);
  }
}

Deno.test("validateOIDCToken: GitHub token verifies against GitHub's keys -> provider github", async () => {
  const key = await signingKey("gh-1");
  await withForgejoUrl(undefined, () =>
    withJwks({ [GITHUB_JWKS_URL]: [key] }, async (fetched) => {
      const claims = await validateOIDCToken(await sign(key, githubClaims));
      assertEquals(claims.provider, "github");
      assertEquals(claims.repository, "demo-class/hw1-student1");
      assertEquals(fetched, [GITHUB_JWKS_URL]);
    })
  );
});

Deno.test("validateOIDCToken: GitHub enterprise issuer under the GitHub host still uses GitHub's keys", async () => {
  const key = await signingKey("gh-ent");
  await withJwks({ [GITHUB_JWKS_URL]: [key] }, async (fetched) => {
    const claims = await validateOIDCToken(
      await sign(key, { ...githubClaims, iss: "https://token.actions.githubusercontent.com/some-enterprise" })
    );
    assertEquals(claims.provider, "github");
    assertEquals(fetched, [GITHUB_JWKS_URL]);
  });
});

Deno.test("validateOIDCToken: Forgejo token verifies when FORGEJO_URL is set -> provider forgejo", async () => {
  const key = await signingKey("fj-1");
  // A trailing slash, as an operator might write it, must not change the issuer we expect.
  await withForgejoUrl(`${FORGEJO_URL}/`, () =>
    withJwks({ [FORGEJO_JWKS_URL]: [key] }, async (fetched) => {
      const claims = await validateOIDCToken(await sign(key, forgejoClaims));
      assertEquals(claims.provider, "forgejo");
      assertEquals(claims.actor, "pawtograder");
      assertEquals(claims.workflow_ref, forgejoClaims.workflow_ref);
      assertEquals(fetched, [FORGEJO_JWKS_URL]);
    })
  );
});

Deno.test("validateOIDCToken: Forgejo token is rejected when FORGEJO_URL is unset, before any fetch", async () => {
  const key = await signingKey("fj-1");
  await withForgejoUrl(undefined, () =>
    withJwks({ [FORGEJO_JWKS_URL]: [key] }, async (fetched) => {
      await assertUntrustedIssuer(() => sign(key, forgejoClaims).then(validateOIDCToken));
      assertEquals(fetched, []);
    })
  );
});

Deno.test("validateOIDCToken: an issuer that isn't configured is rejected, before any fetch", async () => {
  const key = await signingKey("evil-1");
  await withForgejoUrl(FORGEJO_URL, () =>
    withJwks({}, async (fetched) => {
      for (const iss of [
        "https://git.attacker.example/api/actions",
        "https://token.actions.githubusercontent.com.attacker.example",
        `${FORGEJO_URL}/api/actions/extra`,
        undefined
      ]) {
        await assertUntrustedIssuer(() => sign(key, { ...forgejoClaims, iss }).then(validateOIDCToken));
      }
      assertEquals(fetched, []);
    })
  );
});

Deno.test("validateOIDCToken: Forgejo issuer with a kid that isn't in Forgejo's key set -> rejected", async () => {
  const published = await signingKey("fj-1");
  const attacker = await signingKey("attacker-kid");
  await withForgejoUrl(FORGEJO_URL, () =>
    withJwks({ [FORGEJO_JWKS_URL]: [published] }, async () => {
      await assertRejects(() => sign(attacker, forgejoClaims).then(validateOIDCToken), Error, "No public key found");
    })
  );
});

Deno.test("validateOIDCToken: Forgejo issuer signed by a different key under a published kid -> rejected", async () => {
  const published = await signingKey("fj-1");
  const attacker = await signingKey("fj-1");
  await withForgejoUrl(FORGEJO_URL, () =>
    withJwks({ [FORGEJO_JWKS_URL]: [published] }, async () => {
      await assertRejects(() => sign(attacker, forgejoClaims).then(validateOIDCToken));
    })
  );
});

Deno.test("validateOIDCToken: a token claiming GitHub's issuer but signed by Forgejo's key -> rejected", async () => {
  const forgejoKey = await signingKey("fj-1");
  const githubKey = await signingKey("gh-1");
  await withForgejoUrl(FORGEJO_URL, () =>
    withJwks({ [GITHUB_JWKS_URL]: [githubKey], [FORGEJO_JWKS_URL]: [forgejoKey] }, async () => {
      await assertRejects(() => sign(forgejoKey, githubClaims).then(validateOIDCToken), Error, "No public key found");
    })
  );
});
