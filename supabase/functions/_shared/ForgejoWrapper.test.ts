/**
 * Forgejo account creation for #1092. Forgejo is stubbed at fetch; the response bodies and 422
 * messages are the ones Forgejo 15.0.9 returns.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoWrapper.test.ts
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  coderTokenName,
  ensureAccountForUser,
  forgejoConfig,
  type ForgejoConfig,
  mintRepoToken,
  REPLACED_TOKEN_GRACE_MS,
  revokeAllCoderTokens,
  revokeReplacedTokens,
  revokeRepoToken,
  usernameFromEmail
} from "./ForgejoWrapper.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };
const user = { userId: "7d1c7c9e-0000-4000-8000-000000000001", email: "Alex.Kim@northeastern.edu", name: "Alex Kim" };

type Call = { method: string; url: string; body?: Record<string, unknown> };

/** Answers each request with the next response in order and records what was sent. */
async function withForgejo(responses: Response[], fn: (calls: Call[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${init?.method} ${input}`);
    return Promise.resolve(next);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const unprocessable = (message: string) => new Response(JSON.stringify({ message }), { status: 422 });
const created = (login: string) => ok({ id: 41, login, login_name: user.userId, source_id: 3 }, 201);

Deno.test("forgejoConfig: needs all four settings and a positive integer source id", () => {
  const env = (vars: Record<string, string>) => ({ get: (name: string) => vars[name] });
  const all = {
    FORGEJO_URL: "https://git.example.edu//",
    FORGEJO_ADMIN_USERNAME: "admin",
    FORGEJO_ADMIN_PASSWORD: "pw",
    FORGEJO_AUTH_SOURCE_ID: "3"
  };
  assertEquals(forgejoConfig(env(all)), {
    url: "https://git.example.edu",
    authorization: "Basic " + btoa("admin:pw"),
    authSourceId: 3
  });
  for (const missing of Object.keys(all)) {
    assertEquals(forgejoConfig(env({ ...all, [missing]: "" })), null, missing);
  }
  for (const bad of ["0", "-1", "1.5", "pawtograder"]) {
    assertEquals(forgejoConfig(env({ ...all, FORGEJO_AUTH_SOURCE_ID: bad })), null, bad);
  }
});

Deno.test("usernameFromEmail: lowercased local part, Forgejo-safe characters, at most 30", () => {
  assertEquals(usernameFromEmail("Alex.Kim@northeastern.edu"), "alex.kim");
  assertEquals(usernameFromEmail("o'brien+cs4535@husky.neu.edu"), "o-brien-cs4535");
  assertEquals(usernameFromEmail("..weird__name..@x.edu"), "weird-name");
  assertEquals(usernameFromEmail("a".repeat(45) + "@x.edu"), "a".repeat(30));
  assertEquals(usernameFromEmail("@x.edu"), "pawtograder-user");
});

Deno.test("ensureAccountForUser: adopts the account already bound to the user, without creating one", async () => {
  await withForgejo([ok([{ id: 9, login: "alex.kim", login_name: user.userId, source_id: 3 }])], async (calls) => {
    const account = await ensureAccountForUser(config, user);
    assertEquals(account.id, 9);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
    assertEquals(new URL(calls[0].url).searchParams.get("login_name"), user.userId);
    assertEquals(new URL(calls[0].url).searchParams.get("source_id"), "3");
  });
});

Deno.test("ensureAccountForUser: ignores a search hit bound to another source or login", async () => {
  const strangers = [
    { id: 1, login: "a", login_name: user.userId, source_id: 99 },
    { id: 2, login: "b", login_name: "someone-else", source_id: 3 }
  ];
  await withForgejo([ok(strangers), created("alex.kim")], async (calls) => {
    assertEquals((await ensureAccountForUser(config, user)).id, 41);
    assertEquals(calls[1].method, "POST");
  });
});

Deno.test("ensureAccountForUser: creates a user bound to the pawtograder login source by user id", async () => {
  await withForgejo([ok([]), created("alex.kim")], async (calls) => {
    const account = await ensureAccountForUser(config, user);
    assertEquals(account.login, "alex.kim");
    assertEquals(calls[1].url, "https://git.example.edu/api/v1/admin/users");
    const body = calls[1].body!;
    assertEquals(body.username, "alex.kim");
    assertEquals(body.login_name, user.userId);
    assertEquals(body.source_id, 3);
    assertEquals(body.email, user.email);
    assertEquals(body.full_name, "Alex Kim");
    assertEquals(body.send_notify, false);
    assertEquals(typeof body.password, "string");
  });
});

Deno.test("ensureAccountForUser: a taken or reserved username moves to the next suffix", async () => {
  await withForgejo(
    [
      ok([]),
      unprocessable("user already exists [name: alex.kim]"),
      unprocessable("name is reserved [name: alex.kim-2]"),
      created("alex.kim-3")
    ],
    async (calls) => {
      assertEquals((await ensureAccountForUser(config, user)).login, "alex.kim-3");
      assertEquals(
        calls.slice(1).map((c) => c.body!.username),
        ["alex.kim", "alex.kim-2", "alex.kim-3"]
      );
    }
  );
});

Deno.test("ensureAccountForUser: an email already in use fails instead of trying more names", async () => {
  await withForgejo(
    [ok([]), unprocessable("e-mail already in use [email: Alex.Kim@northeastern.edu]")],
    async (calls) => {
      const err = await assertRejects(() => ensureAccountForUser(config, user), Error, "e-mail already in use");
      // The error goes to Sentry, so Forgejo's bracketed email must not be in it.
      assertEquals(err.message.includes("Alex.Kim"), false);
      assertEquals(calls.length, 2);
    }
  );
});

Deno.test("Forgejo errors keep the status and a known reason, never the response text", async () => {
  for (const body of [
    JSON.stringify({ message: "e-mail already in use: Alex.Kim@northeastern.edu" }),
    "<html>500 Internal Server Error for alex.kim@northeastern.edu</html>"
  ]) {
    await withForgejo([ok([]), new Response(body, { status: 500 })], async () => {
      const err = await assertRejects(() => ensureAccountForUser(config, user));
      assertEquals(err instanceof Error && /alex\.kim/i.test(err.message), false, String(err));
      assertEquals(err instanceof Error && err.message.includes("500"), true, String(err));
    });
  }
  await withForgejo([new Response("<html>bad gateway alex.kim</html>", { status: 502 })], async () => {
    await assertRejects(
      () => ensureAccountForUser(config, user),
      Error,
      "user search failed: 502 unrecognized response"
    );
  });
});

Deno.test("ensureAccountForUser: a failed search is an error, not a reason to create", async () => {
  await withForgejo([new Response("bad gateway", { status: 502 })], async (calls) => {
    await assertRejects(() => ensureAccountForUser(config, user), Error, "user search failed: 502");
    assertEquals(calls.length, 1);
  });
});

// Status codes and bodies are what Forgejo 15.0.9 returned in the Phase 0 spike.
const noContent = () => new Response(null, { status: 204 });
const notFound = () => new Response(JSON.stringify({ message: "access token does not exist" }), { status: 404 });
const minted = (sha1: string) =>
  ok(
    { id: 7, name: "pawtograder-coder-42", sha1, token_last_eight: sha1.slice(-8), scopes: ["write:repository"] },
    201
  );

const NOW = Date.parse("2026-11-16T12:00:00Z");
const tokenAt = (repositoryId: number, at: number, suffix = "abcd1234") =>
  `pawtograder-coder-${repositoryId}-${at}-${suffix}`;

Deno.test("coderTokenName: the repository, the mint time, and a random suffix", () => {
  const a = coderTokenName(42, NOW);
  const b = coderTokenName(42, NOW);
  assert(/^pawtograder-coder-42-\d+-[0-9a-f]{8}$/.test(a), a);
  assert(a.startsWith(`pawtograder-coder-42-${NOW}-`), a);
  assert(a !== b, "two mints in the same millisecond get different names");
});

Deno.test("mintRepoToken: mints a token scoped to the repository for the student, deleting nothing", async () => {
  await withForgejo([minted("f".repeat(40))], async (calls) => {
    const result = await mintRepoToken(config, "alex.kim", "cs3500-f26/hw1-alex", 42, NOW);
    assertEquals(result.token, "f".repeat(40));
    assert(result.name.startsWith(`pawtograder-coder-42-${NOW}-`), result.name);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/users/alex.kim/tokens");
    assertEquals(calls[0].body, {
      name: result.name,
      scopes: ["write:repository"],
      repositories: [{ owner: "cs3500-f26", name: "hw1-alex" }]
    });
  });
});

Deno.test("mintRepoToken: a repository that isn't owner/name fails before calling Forgejo", async () => {
  for (const repository of ["repo", "org/repo/extra", "/repo", "org/"]) {
    await withForgejo([], async (calls) => {
      await assertRejects(() => mintRepoToken(config, "alex.kim", repository, 42), Error, "not owner/name");
      assertEquals(calls.length, 0);
    });
  }
});

Deno.test("mintRepoToken: a refused mint keeps a known reason and nothing else", async () => {
  await withForgejo(
    [new Response(JSON.stringify({ message: "access token name has been used already" }), { status: 400 })],
    async () => {
      await assertRejects(
        () => mintRepoToken(config, "alex.kim", "org/repo", 42),
        Error,
        "token mint failed: 400 access token name has been used already"
      );
    }
  );
  await withForgejo([ok({ id: 7, name: "pawtograder-coder-42" }, 201)], async () => {
    await assertRejects(() => mintRepoToken(config, "alex.kim", "org/repo", 42), Error, "the response has no token");
  });
});

Deno.test("mintRepoToken: the token never appears in an error", async () => {
  await withForgejo([new Response("sha1=deadbeefcafe", { status: 201 })], async () => {
    const err = await assertRejects(() => mintRepoToken(config, "alex.kim", "org/repo", 42));
    assertEquals(String(err).includes("deadbeefcafe"), false, String(err));
  });
});

Deno.test(
  "revokeReplacedTokens: deletes this repository's tokens past the grace window, except the one kept",
  async () => {
    const keep = tokenAt(42, NOW);
    const old = tokenAt(42, NOW - REPLACED_TOKEN_GRACE_MS);
    const recent = tokenAt(42, NOW - REPLACED_TOKEN_GRACE_MS + 1);
    const otherRepo = tokenAt(420, NOW - 2 * REPLACED_TOKEN_GRACE_MS);
    const list = [keep, old, recent, otherRepo, "pawtograder-coder-42-garbage", "laptop"].map((name) => ({ name }));
    await withForgejo([ok(list), noContent()], async (calls) => {
      assertEquals(await revokeReplacedTokens(config, "alex.kim", 42, keep, NOW), 1);
      assertEquals(calls[1].method, "DELETE");
      assertEquals(decodeURIComponent(calls[1].url.split("/tokens/")[1]), old);
      assertEquals(calls.length, 2);
    });
  }
);

Deno.test("revokeRepoToken: deletes every token of the repository and no other; 404 counts as revoked", async () => {
  const list = [tokenAt(42, 1), tokenAt(42, NOW), tokenAt(420, 1), "laptop"].map((name) => ({ name }));
  await withForgejo([ok(list), noContent(), notFound()], async (calls) => {
    assertEquals(await revokeRepoToken(config, "alex.kim", 42), 2);
    assertEquals(
      calls.slice(1).map((c) => decodeURIComponent(c.url.split("/tokens/")[1])),
      [tokenAt(42, 1), tokenAt(42, NOW)]
    );
  });
  await withForgejo(
    [ok([{ name: tokenAt(42, 1) }]), new Response("<html>bad gateway alex.kim</html>", { status: 502 })],
    async () => {
      await assertRejects(
        () => revokeRepoToken(config, "alex.kim", 42),
        Error,
        "token revoke failed: 502 unrecognized response"
      );
    }
  );
  await withForgejo([new Response(JSON.stringify({ message: "user does not exist" }), { status: 404 })], async () => {
    assertEquals(await revokeRepoToken(config, "gone", 42), 0);
  });
});

Deno.test("revokeAllCoderTokens: deletes only workspace tokens, across pages", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => ({ name: i % 2 ? `pawtograder-coder-${i}` : `laptop-${i}` }));
  const page2 = [{ name: "pawtograder-coder-900" }, { name: "my-own-token" }];
  await withForgejo([ok(page1), ok(page2), ...Array.from({ length: 26 }, noContent)], async (calls) => {
    assertEquals(await revokeAllCoderTokens(config, "alex.kim"), 26);
    assertEquals(new URL(calls[0].url).searchParams.get("page"), "1");
    assertEquals(new URL(calls[1].url).searchParams.get("page"), "2");
    const deleted = calls.slice(2).map((c) => decodeURIComponent(c.url.split("/tokens/")[1]));
    assertEquals(deleted.length, 26);
    assertEquals(
      deleted.every((n) => n.startsWith("pawtograder-coder-")),
      true
    );
    assertEquals(deleted.includes("pawtograder-coder-900"), true);
    assertEquals(
      calls.slice(2).every((c) => c.method === "DELETE"),
      true
    );
  });
});

Deno.test("revokeAllCoderTokens: a user that is gone has nothing to revoke", async () => {
  await withForgejo([new Response(JSON.stringify({ message: "user does not exist" }), { status: 404 })], async () => {
    assertEquals(await revokeAllCoderTokens(config, "gone"), 0);
  });
});

Deno.test("revokeAllCoderTokens: a failed list is an error, and nothing is deleted", async () => {
  await withForgejo([new Response("bad gateway", { status: 502 })], async (calls) => {
    await assertRejects(() => revokeAllCoderTokens(config, "alex.kim"), Error, "token list failed: 502");
    assertEquals(calls.length, 1);
  });
});
