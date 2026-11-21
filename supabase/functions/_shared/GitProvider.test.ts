/**
 * startGradingOn routes a rerun to the repository's host. Forgejo is stubbed at fetch.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/GitProvider.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";

// GitProvider imports GitHubWrapper, which builds a GitHub App at import time and needs a non-empty private key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { startGradingOn } = await import("./GitProvider.ts");

const forgejoEnv = {
  FORGEJO_URL: "https://git.example.edu",
  FORGEJO_ADMIN_USERNAME: "admin",
  FORGEJO_ADMIN_PASSWORD: "pw",
  FORGEJO_AUTH_SOURCE_ID: "3"
};

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("startGradingOn: a Forgejo repository tags the commit and dispatches grade.yml on Forgejo", async () => {
  const sha = "27d062d99f8551af7be5e9ff7812241574198a0b";
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const responses = [new Response(null, { status: 201 }), new Response(null, { status: 204 })];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(responses.shift()!);
  }) as typeof fetch;
  try {
    await withEnv(forgejoEnv, () => startGradingOn("forgejo", "cs4535/hw1-alex.kim", sha));
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(urls, [
    "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/tags",
    "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/actions/workflows/grade.yml/dispatches"
  ]);
});

Deno.test("startGradingOn: a Forgejo repository on a deployment without Forgejo settings is an error", async () => {
  await withEnv({ ...forgejoEnv, FORGEJO_URL: "" }, async () => {
    await assertRejects(() => startGradingOn("forgejo", "cs4535/hw1-alex.kim", "abc"), Error, "isn't configured");
  });
});
