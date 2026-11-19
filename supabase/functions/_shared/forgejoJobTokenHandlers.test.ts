/**
 * A Forgejo job token reaches the grading handlers (#1110): autograder-create-submission and
 * autograder-submit-feedback accept it, then go on to the database. Each handler is called directly with a
 * signed Forgejo token. The test stops at the first database request, which it records and refuses.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net --allow-read _shared/forgejoJobTokenHandlers.test.ts
 */
import { assert, assertRejects } from "jsr:@std/assert@^1";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { JobTokenRejectedError, SecurityError } from "./HandlerUtils.ts";

const FORGEJO_URL = "https://git.example.edu";
const FORGEJO_JWKS_URL = `${FORGEJO_URL}/api/actions/.well-known/keys`;
const SUPABASE_URL = "http://supabase.test";
const toDatabase = (url: string) => new URL(url).origin === SUPABASE_URL;

// Set before the handlers load: GitHubWrapper builds a GitHub App at import time, and the handlers read
// these when they create their clients.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
Deno.env.set("FORGEJO_URL", FORGEJO_URL);
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
const createSubmission = await import("../autograder-create-submission/index.ts");
const submitFeedback = await import("../autograder-submit-feedback/index.ts");

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

// Claims from a real Forgejo 15.0.9 token for a run dispatched on a pawtograder-submit tag.
function forgejoToken(issuer = `${FORGEJO_URL}/api/actions`) {
  const now = getNumericDate(0);
  return create(
    { alg: "RS256", typ: "JWT", kid: "k1" },
    {
      iat: now,
      nbf: now,
      exp: now + 3600,
      iss: issuer,
      aud: `${FORGEJO_URL}/demo-class`,
      sub: "repo:demo-class/hw1-student1:ref:refs/tags/pawtograder-submit/fbb8271",
      actor: "student1",
      event_name: "workflow_dispatch",
      ref: "refs/tags/pawtograder-submit/fbb8271",
      ref_type: "tag",
      repository: "demo-class/hw1-student1",
      repository_owner: "demo-class",
      run_id: "4",
      run_attempt: "1",
      sha: "fbb8271",
      workflow_ref: "demo-class/hw1-student1/.github/workflows/grade.yml@refs/tags/pawtograder-submit/fbb8271"
    },
    pair.privateKey
  );
}

/** Serves Forgejo's key set, records every other request and fails it, so a handler stops at the database. */
async function calling(handler: () => Promise<unknown>) {
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url === FORGEJO_JWKS_URL) return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })));
    return Promise.reject(new Error(`stopped at ${url}`));
  }) as typeof fetch;
  let error: unknown;
  try {
    await handler();
  } catch (e) {
    error = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  return { error, fetched };
}

const request = async (issuer?: string) =>
  new Request("http://localhost/", {
    method: "POST",
    headers: { Authorization: await forgejoToken(issuer) },
    body: "{}"
  });

for (const [name, mod] of [
  ["autograder-create-submission", createSubmission],
  ["autograder-submit-feedback", submitFeedback]
] as const) {
  Deno.test(`${name}: a Forgejo job token is accepted, and the handler goes on to the database`, async () => {
    const { error, fetched } = await calling(async () =>
      mod.handleRequest(await request(), undefined as unknown as Parameters<typeof mod.handleRequest>[1])
    );
    assert(!(error instanceof JobTokenRejectedError), `token rejected: ${error}`);
    assert(fetched.includes(FORGEJO_JWKS_URL), "the handler didn't verify the token against Forgejo's keys");
    assert(fetched.some(toDatabase), `the handler never reached the database: ${fetched.join(", ")}`);
  });

  Deno.test(`${name}: a token from an untrusted issuer is still refused before the database`, async () => {
    const { error, fetched } = await calling(async () =>
      mod.handleRequest(
        await request("https://other.example.edu/api/actions"),
        undefined as unknown as Parameters<typeof mod.handleRequest>[1]
      )
    );
    await assertRejects(() => Promise.reject(error), JobTokenRejectedError);
    assert(!fetched.some(toDatabase), "an untrusted token reached the database");
  });
}

Deno.test(
  "autograder-submit-feedback: a Forgejo token for a regression run is refused before the regression lookup",
  async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      if (url === FORGEJO_JWKS_URL) return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })));
      // assertJobTokenMatchesRepository: a Forgejo repository row with the token's name exists.
      if (new URL(url).pathname === "/rest/v1/repositories") {
        return Promise.resolve(new Response(JSON.stringify([{ git_provider: "forgejo" }]), { status: 200 }));
      }
      return Promise.reject(new Error(`stopped at ${url}`));
    }) as typeof fetch;
    try {
      const req = new Request("http://localhost/?autograder_regression_test_id=7", {
        method: "POST",
        headers: { Authorization: await forgejoToken() },
        body: "{}"
      });
      const error = await assertRejects(
        () =>
          submitFeedback.handleRequest(req, undefined as unknown as Parameters<typeof submitFeedback.handleRequest>[1]),
        SecurityError
      );
      assert(error.details.startsWith("Regression test run not found"), error.details);
      assert(!fetched.some((url) => url.includes("autograder_regression_test")), "looked up the regression test");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
);
