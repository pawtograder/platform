/**
 * Forgejo account (#1092) and repo (#1093) creation. Forgejo is stubbed at fetch; the status codes,
 * response bodies and messages are the ones Forgejo 15.0.9 returns.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoWrapper.test.ts
 */
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  archivedRepoName,
  archiveRepo,
  coderTokenName,
  ArchiveTooLargeError,
  downloadArchive,
  ensureAccountForUser,
  ensureHandoutRepo,
  ensureOrg,
  ensureRepoFromTemplate,
  forgejoConfig,
  type ForgejoConfig,
  getCommit,
  grantWrite,
  IDLE_TOKEN_MS,
  mintRepoToken,
  readFile,
  REPLACED_TOKEN_GRACE_MS,
  repoPath,
  revokeAllCoderTokens,
  revokeIdleTokens,
  revokeReplacedTokens,
  revokeRepoToken,
  startGrading,
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

Deno.test("forgejoConfig: a push hook to the public functions URL only with FORGEJO_WEBHOOK_SECRET", () => {
  const env = (vars: Record<string, string>) => ({ get: (name: string) => vars[name] });
  const all = {
    FORGEJO_URL: "https://git.example.edu",
    FORGEJO_ADMIN_USERNAME: "admin",
    FORGEJO_ADMIN_PASSWORD: "pw",
    FORGEJO_AUTH_SOURCE_ID: "3",
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_PUBLIC_URL: "https://api.example.edu/"
  };
  assertEquals(forgejoConfig(env(all))?.pushHook, undefined);
  assertEquals(forgejoConfig(env({ ...all, FORGEJO_WEBHOOK_SECRET: "s3cret" }))?.pushHook, {
    url: "https://api.example.edu/functions/v1/forgejo-repo-webhook",
    secret: "s3cret"
  });
  assertEquals(
    forgejoConfig(env({ ...all, SUPABASE_PUBLIC_URL: "", FORGEJO_WEBHOOK_SECRET: "s3cret" }))?.pushHook?.url,
    "http://kong:8000/functions/v1/forgejo-repo-webhook"
  );
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

Deno.test("revokeRepoToken: keeps a token minted after the cutoff, so a re-mint after the claim survives", async () => {
  const before = tokenAt(42, NOW - 1);
  const atCutoff = tokenAt(42, NOW, "bbbb0000");
  const reMinted = tokenAt(42, NOW + 1, "cccc0000");
  const list = [before, atCutoff, reMinted, "pawtograder-coder-42-garbage"].map((name) => ({ name }));
  await withForgejo([ok(list), noContent(), noContent(), noContent()], async (calls) => {
    assertEquals(await revokeRepoToken(config, "alex.kim", 42, NOW), 3);
    assertEquals(
      calls.slice(1).map((c) => decodeURIComponent(c.url.split("/tokens/")[1])),
      [before, atCutoff, "pawtograder-coder-42-garbage"]
    );
  });
});

Deno.test(
  "revokeIdleTokens: revokes other repositories whose newest token is IDLE_TOKEN_MS old, never the kept one",
  async () => {
    const idleOld = tokenAt(420, NOW - IDLE_TOKEN_MS - 1);
    const idle = tokenAt(420, NOW - IDLE_TOKEN_MS, "bbbb0000");
    const usedOld = tokenAt(421, NOW - 2 * IDLE_TOKEN_MS);
    const used = tokenAt(421, NOW - IDLE_TOKEN_MS + 1);
    const kept = tokenAt(42, NOW - 3 * IDLE_TOKEN_MS);
    const list = [idleOld, idle, usedOld, used, kept, "pawtograder-coder-422-garbage", "laptop"].map((name) => ({
      name
    }));
    await withForgejo([ok(list), noContent(), notFound()], async (calls) => {
      const live = await revokeIdleTokens(config, "alex.kim", 42, NOW);
      assertEquals([...live].sort(), [42, 421]);
      assertEquals(
        calls.slice(1).map((c) => [c.method, decodeURIComponent(c.url.split("/tokens/")[1])]),
        [
          ["DELETE", idleOld],
          ["DELETE", idle]
        ]
      );
    });
  }
);

Deno.test("revokeAllCoderTokens: deletes only workspace tokens, across pages", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => ({ name: i % 2 ? `pawtograder-coder-${i}` : `laptop-${i}` }));
  const page2 = [{ name: "pawtograder-coder-900" }, { name: "my-own-token" }];
  // Page 1 is read again after the last page, to confirm nothing changed during the scan.
  await withForgejo([ok(page1), ok(page2), ok(page1), ...Array.from({ length: 26 }, noContent)], async (calls) => {
    assertEquals(await revokeAllCoderTokens(config, "alex.kim"), 26);
    assertEquals(
      calls.slice(0, 3).map((c) => new URL(c.url).searchParams.get("page")),
      ["1", "2", "1"]
    );
    const deleted = calls.slice(3).map((c) => decodeURIComponent(c.url.split("/tokens/")[1]));
    assertEquals(deleted.length, 26);
    assertEquals(
      deleted.every((n) => n.startsWith("pawtograder-coder-")),
      true
    );
    assertEquals(deleted.includes("pawtograder-coder-900"), true);
    assertEquals(
      calls.slice(3).every((c) => c.method === "DELETE"),
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

Deno.test("downloadArchive: fetches the commit's zip, and an error status fails", async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  await withForgejo([new Response(zip, { status: 200 })], async (calls) => {
    assertEquals(await downloadArchive(config, "cs4535/hw1-alex.kim", "b275490c", 1024), zip);
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/archive/b275490c.zip");
  });
  await withForgejo([new Response("Not Found", { status: 404 })], async () => {
    await assertRejects(() => downloadArchive(config, "cs4535/hw1-alex.kim", "b275490c", 1024), Error, "404");
  });
});

Deno.test("downloadArchive: refuses an archive past the limit without reading or keeping all of it", async () => {
  let pulled = 0;
  // 100 chunks of 10 bytes, produced only as they're read.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 100) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(10));
    }
  });
  await withForgejo([new Response(body, { status: 200 })], async () => {
    const error = await assertRejects(
      () => downloadArchive(config, "cs4535/hw1-alex.kim", "b275490c", 25),
      ArchiveTooLargeError
    );
    assertEquals(error.bytesRead, 30);
    assert(pulled < 100, "read the whole archive");
  });
});

Deno.test("downloadArchive: gives up on a request Forgejo never answers", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  try {
    await assertRejects(() => downloadArchive(config, "cs4535/hw1-alex.kim", "0000", 1024, 50), DOMException);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const status = (code: number, message = "") => new Response(JSON.stringify({ message }), { status: code });

/** The lookups that prove an existing org is the admin's alone: who the admin is, the org's teams, the owners. */
const ownedBy = (...logins: string[]) => [
  ok({ login: "pawtograder-admin" }),
  ok([
    { id: 5, permission: "owner" },
    { id: 6, permission: "write" }
  ]),
  ok(logins.map((login) => ({ login })))
];

Deno.test("ensureOrg: accepts an existing org whose only owner is the admin", async () => {
  await withForgejo([ok({ username: "cs4535" }), ...ownedBy("Pawtograder-Admin")], async (calls) => {
    await ensureOrg(config, "cs4535");
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET https://git.example.edu/api/v1/orgs/cs4535",
        "GET https://git.example.edu/api/v1/user",
        "GET https://git.example.edu/api/v1/orgs/cs4535/teams?limit=50",
        "GET https://git.example.edu/api/v1/teams/5/members?limit=50"
      ]
    );
  });
});

Deno.test("ensureOrg: refuses an org that anyone else owns, alone or with the admin", async () => {
  for (const owners of [["alex.kim"], ["pawtograder-admin", "alex.kim"]]) {
    await withForgejo([ok({ username: "cs4535" }), ...ownedBy(...owners)], async () => {
      await assertRejects(() => ensureOrg(config, "cs4535"), Error, "owner other than Pawtograder's admin");
    });
  }
});

Deno.test("ensureOrg: creates a missing org as private", async () => {
  await withForgejo([status(404), ok({}, 201)], async (calls) => {
    await ensureOrg(config, "cs4535");
    assertEquals(calls[1].body, { username: "cs4535", visibility: "private" });
  });
  await withForgejo([status(404), status(403, "forbidden")], async () => {
    await assertRejects(() => ensureOrg(config, "cs4535"), Error, "403");
  });
});

Deno.test("ensureOrg: after losing a race to create it, still checks who owns the org", async () => {
  await withForgejo(
    [
      status(404),
      unprocessable("user already exists [name: cs4535]"),
      ok({ username: "cs4535" }),
      ...ownedBy("pawtograder-admin")
    ],
    async () => {
      await ensureOrg(config, "cs4535");
    }
  );
});

const hooked: ForgejoConfig = {
  ...config,
  pushHook: { url: "https://api.example.edu/functions/v1/forgejo-repo-webhook", secret: "s3cret" }
};

Deno.test("ensureOrg: gives an existing org its push hook once", async () => {
  await withForgejo(
    [ok({ username: "cs4535" }), ...ownedBy("pawtograder-admin"), ok([]), ok({}, 201)],
    async (calls) => {
      await ensureOrg(hooked, "cs4535");
      assertEquals(
        calls.slice(-2).map((c) => `${c.method} ${c.url}`),
        [
          "GET https://git.example.edu/api/v1/orgs/cs4535/hooks?limit=50",
          "POST https://git.example.edu/api/v1/orgs/cs4535/hooks"
        ]
      );
      assertEquals(calls.at(-1)?.body, {
        type: "forgejo",
        active: true,
        events: ["push"],
        branch_filter: "*",
        config: { url: hooked.pushHook!.url, content_type: "json", secret: "s3cret" }
      });
    }
  );
  // Already there, maybe with an old secret or turned off: it's rewritten in place, not duplicated.
  await withForgejo(
    [
      ok({ username: "cs4535" }),
      ...ownedBy("pawtograder-admin"),
      ok([{ id: 9, active: false, config: { url: hooked.pushHook!.url } }]),
      ok({})
    ],
    async (calls) => {
      await ensureOrg(hooked, "cs4535");
      assertEquals(
        `${calls.at(-1)?.method} ${calls.at(-1)?.url}`,
        "PATCH https://git.example.edu/api/v1/orgs/cs4535/hooks/9"
      );
      assertEquals(calls.at(-1)?.body, {
        active: true,
        events: ["push"],
        branch_filter: "*",
        config: { url: hooked.pushHook!.url, content_type: "json", secret: "s3cret" }
      });
      assertEquals(calls.filter((c) => c.method === "POST").length, 0);
    }
  );
});

Deno.test("ensureOrg: gives a newly created org its push hook, and fails if it can't", async () => {
  await withForgejo([status(404), ok({}, 201), ok([]), ok({}, 201)], async (calls) => {
    await ensureOrg(hooked, "cs4535");
    assertEquals(calls.at(-1)?.url, "https://git.example.edu/api/v1/orgs/cs4535/hooks");
  });
  await withForgejo([status(404), ok({}, 201), ok([]), status(403, "forbidden")], async () => {
    await assertRejects(() => ensureOrg(hooked, "cs4535"), Error, "org hook create failed: 403");
  });
});

Deno.test("ensureOrg: refuses a name that is a user, which /orgs reports as missing", async () => {
  await withForgejo([status(404), unprocessable("user already exists [name: cs4535]"), status(404)], async () => {
    await assertRejects(() => ensureOrg(config, "cs4535"), Error, "taken by a user");
  });
});

Deno.test("repoPath: only a plain owner/name gets into a URL", () => {
  assertEquals(repoPath("cs4535/hw1-alex.kim"), "cs4535/hw1-alex.kim");
  for (const bad of ["cs4535", "a/b/c", "../users", "cs4535/..", "a?x/b", "a/b#c", "a/b%2F", "", "/b", "a/"]) {
    assertThrows(() => repoPath(bad), Error, "Not a Forgejo owner/name", bad);
  }
});

Deno.test(
  "ensureRepoFromTemplate: generates a private repo with the template's content, adopting one that exists",
  async () => {
    await withForgejo([ok({}, 201)], async (calls) => {
      await ensureRepoFromTemplate(config, "cs4535/hw1-handout", "cs4535", "hw1-alex.kim");
      assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-handout/generate");
      assertEquals(calls[0].body, { owner: "cs4535", name: "hw1-alex.kim", private: true, git_content: true });
    });
    await withForgejo([status(409, "The repository with the same name already exists.")], async () => {
      await ensureRepoFromTemplate(config, "cs4535/hw1-handout", "cs4535", "hw1-alex.kim");
    });
    await withForgejo([unprocessable("this is not a template repo")], async () => {
      await assertRejects(
        () => ensureRepoFromTemplate(config, "cs4535/hw1-handout", "cs4535", "hw1-alex.kim"),
        Error,
        "not a template"
      );
    });
  }
);

Deno.test("ensureRepoFromTemplate: a template that isn't owner/name never reaches Forgejo", async () => {
  await withForgejo([], async (calls) => {
    await assertRejects(
      () => ensureRepoFromTemplate(config, "../admin/users?x=", "cs4535", "hw1-alex.kim"),
      Error,
      "Not a Forgejo owner/name"
    );
    assertEquals(calls, []);
  });
});

Deno.test("grantWrite: adds the student as a writer and trusts only what Forgejo reports back", async () => {
  await withForgejo([new Response(null, { status: 204 }), ok({ permission: "write" })], async (calls) => {
    assertEquals(await grantWrite(config, "cs4535/hw1-alex.kim", "alex.kim"), true);
    assertEquals(calls[0].method, "PUT");
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/collaborators/alex.kim");
    assertEquals(calls[0].body, { permission: "write" });
    assertEquals(
      calls[1].url,
      "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/collaborators/alex.kim/permission"
    );
  });
  await withForgejo([new Response(null, { status: 204 }), ok({ permission: "read" })], async () => {
    assertEquals(await grantWrite(config, "cs4535/hw1-alex.kim", "alex.kim"), false);
  });
  await withForgejo([status(404)], async () => {
    await assertRejects(() => grantWrite(config, "cs4535/hw1-alex.kim", "alex.kim"), Error, "404");
  });
});

Deno.test("readFile: a repository that isn't owner/name never reaches Forgejo", async () => {
  await withForgejo([], async (calls) => {
    await assertRejects(
      () => readFile(config, "../admin", ".github/workflows/grade.yml"),
      Error,
      "Not a Forgejo owner/name"
    );
    assertEquals(calls, []);
  });
});

Deno.test("readFile: decodes the file's base64 content, and a missing file is null", async () => {
  const text = "name: Grade\non: push\n";
  // Forgejo, like GitHub, may wrap the base64.
  const content = btoa(text).replace(/(.{8})/g, "$1\n");
  await withForgejo([ok({ content })], async (calls) => {
    assertEquals(await readFile(config, "cs4535/hw1-handout", ".github/workflows/grade.yml"), text);
    assertEquals(
      calls[0].url,
      "https://git.example.edu/api/v1/repos/cs4535/hw1-handout/contents/.github/workflows/grade.yml"
    );
  });
  await withForgejo([status(404)], async () => {
    assertEquals(await readFile(config, "cs4535/hw1-handout", ".github/workflows/grade.yml"), null);
  });
  await withForgejo([status(500)], async () => {
    await assertRejects(() => readFile(config, "cs4535/hw1-handout", ".github/workflows/grade.yml"), Error, "500");
  });
});

Deno.test("readFile: asks for the file at a given ref", async () => {
  await withForgejo([status(404)], async (calls) => {
    await readFile(config, "cs4535/hw1-alex.kim", ".github/workflows/grade.yml", "27d062d9");
    assertEquals(
      calls[0].url,
      "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/contents/.github/workflows/grade.yml?ref=27d062d9"
    );
  });
});

const head = {
  sha: "5140bf4621ac400f7c2fedd86cfac63e189069c4",
  commit: { message: "Add .github/workflows/grade.yml" }
};
const gradeYml = { path: ".github/workflows/grade.yml", content: "name: Grade\n# \u00e9\n" };

Deno.test(
  "ensureHandoutRepo: creates a private template repo on main with the files, and returns main's head",
  async () => {
    const responses = [ok({ username: "cs4535" }), ...ownedBy("pawtograder-admin"), ok({}, 201), ok({}, 201), ok(head)];
    await withForgejo(responses, async (calls) => {
      assertEquals(await ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gradeYml]), head.sha);
      assertEquals(
        calls.slice(4).map((c) => `${c.method} ${c.url}`),
        [
          "POST https://git.example.edu/api/v1/orgs/cs4535/repos",
          "POST https://git.example.edu/api/v1/repos/cs4535/cs4535-handout-hw1/contents/.github/workflows/grade.yml",
          "GET https://git.example.edu/api/v1/repos/cs4535/cs4535-handout-hw1/git/commits/main"
        ]
      );
      assertEquals(calls[4].body, {
        name: "cs4535-handout-hw1",
        private: true,
        auto_init: true,
        default_branch: "main",
        template: true
      });
      const content = calls[5].body!.content as string;
      assertEquals(new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))), gradeYml.content);
      assertEquals(calls[5].body!.branch, "main");
    });
  }
);

Deno.test(
  "ensureHandoutRepo: adopts an existing repo as a private template and keeps a file already there",
  async () => {
    const responses = [
      ok({ username: "cs4535" }),
      ...ownedBy("pawtograder-admin"),
      new Response(JSON.stringify({ message: "The repository with the same name already exists." }), { status: 409 }),
      ok({ empty: false, default_branch: "main" }),
      unprocessable("repository file already exists [path: .github/workflows/grade.yml]"),
      ok(head)
    ];
    await withForgejo(responses, async (calls) => {
      assertEquals(await ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gradeYml]), head.sha);
      assertEquals(
        `${calls[5].method} ${calls[5].url}`,
        "PATCH https://git.example.edu/api/v1/repos/cs4535/cs4535-handout-hw1"
      );
      assertEquals(calls[5].body, { template: true, private: true });
    });
  }
);

Deno.test(
  "ensureHandoutRepo: an adopted empty repo gets a README on main; another default branch is refused",
  async () => {
    const exists = () =>
      new Response(JSON.stringify({ message: "The repository with the same name already exists." }), { status: 409 });
    const gone = { path: ".github/workflows/grade.yml", content: null };
    const empty = [
      ok({ username: "cs4535" }),
      ...ownedBy("pawtograder-admin"),
      exists(),
      ok({ empty: true, default_branch: "main" }),
      ok({}, 201),
      status(404),
      ok(head)
    ];
    await withForgejo(empty, async (calls) => {
      assertEquals(await ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gone]), head.sha);
      assertEquals(
        `${calls[6].method} ${calls[6].url}`,
        "POST https://git.example.edu/api/v1/repos/cs4535/cs4535-handout-hw1/contents/README.md"
      );
      assertEquals(calls[6].body!.branch, "main");
    });
    const trunk = [
      ok({ username: "cs4535" }),
      ...ownedBy("pawtograder-admin"),
      exists(),
      ok({ empty: false, default_branch: "trunk" })
    ];
    await withForgejo(trunk, async () => {
      await assertRejects(
        () => ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gone]),
        Error,
        "default branch isn't main"
      );
    });
  }
);

Deno.test("ensureHandoutRepo: removes a file with null content, and a file already gone changes nothing", async () => {
  const gone = { path: ".github/workflows/grade.yml", content: null };
  const responses = [
    ok({ username: "cs4535" }),
    ...ownedBy("pawtograder-admin"),
    ok({}, 201),
    ok({ sha: "1f0e2a" }),
    ok({}),
    ok(head)
  ];
  await withForgejo(responses, async (calls) => {
    assertEquals(await ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gone]), head.sha);
    const file = "https://git.example.edu/api/v1/repos/cs4535/cs4535-handout-hw1/contents/.github/workflows/grade.yml";
    assertEquals(
      calls.slice(5, 7).map((c) => `${c.method} ${c.url}`),
      [`GET ${file}?ref=main`, `DELETE ${file}`]
    );
    assertEquals(calls[6].body, { sha: "1f0e2a", message: "Remove .github/workflows/grade.yml", branch: "main" });
  });
  const again = [ok({ username: "cs4535" }), ...ownedBy("pawtograder-admin"), ok({}, 201), status(404), ok(head)];
  await withForgejo(again, async (calls) => {
    assertEquals(await ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gone]), head.sha);
    assert(!calls.some((c) => c.method === "DELETE"));
  });
});

Deno.test("ensureHandoutRepo: any other file error fails, and a bad name never reaches Forgejo", async () => {
  const responses = [ok({ username: "cs4535" }), ...ownedBy("pawtograder-admin"), ok({}, 201), status(403)];
  await withForgejo(responses, async () => {
    await assertRejects(
      () => ensureHandoutRepo(config, "cs4535/cs4535-handout-hw1", [gradeYml]),
      Error,
      "file create failed: 403"
    );
  });
  await withForgejo([], async () => {
    await assertRejects(() => ensureHandoutRepo(config, "cs4535/../admin", []), Error, "Not a Forgejo owner/name");
  });
});

Deno.test("getCommit: resolves a short sha to the full commit, and a missing one fails", async () => {
  const commit = { sha: "27d062d99f8551af7be5e9ff7812241574198a0b", commit: { message: "Initial commit\n" } };
  await withForgejo([ok(commit)], async (calls) => {
    assertEquals(await getCommit(config, "cs4535/hw1-alex.kim", "27d062d9"), commit);
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/git/commits/27d062d9");
  });
  await withForgejo([status(404)], async () => {
    await assertRejects(() => getCommit(config, "cs4535/hw1-alex.kim", "deadbeef"), Error, "commit lookup failed: 404");
  });
});

Deno.test("startGrading: tags the commit and dispatches grade.yml at the tag", async () => {
  const sha = "27d062d99f8551af7be5e9ff7812241574198a0b";
  await withForgejo([status(201), new Response(null, { status: 204 })], async (calls) => {
    await startGrading(config, "cs4535/hw1-alex.kim", sha);
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/tags");
    assertEquals(calls[0].body, {
      tag_name: `pawtograder-submit/${sha}`,
      target: sha,
      message: "pawtograder submission"
    });
    assertEquals(
      calls[1].url,
      "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/actions/workflows/grade.yml/dispatches"
    );
    assertEquals(calls[1].body, { ref: `pawtograder-submit/${sha}` });
  });
  await withForgejo([status(403)], async (calls) => {
    await assertRejects(() => startGrading(config, "cs4535/hw1-alex.kim", sha), Error, "submission tag failed: 403");
    assertEquals(calls.length, 1);
  });
  await withForgejo([status(201), status(404)], async () => {
    await assertRejects(() => startGrading(config, "cs4535/hw1-alex.kim", sha), Error, "workflow dispatch failed: 404");
  });
});

Deno.test("startGrading: reuses an existing tag at the commit, and replaces one at another commit", async () => {
  const sha = "27d062d99f8551af7be5e9ff7812241574198a0b";
  const tagUrl = `https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/tags/pawtograder-submit/${sha}`;
  // From an earlier run of the same commit.
  await withForgejo([status(409), ok({ commit: { sha } }), new Response(null, { status: 204 })], async (calls) => {
    await startGrading(config, "cs4535/hw1-alex.kim", sha);
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "POST https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/tags",
        `GET ${tagUrl}`,
        "POST https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/actions/workflows/grade.yml/dispatches"
      ]
    );
  });
  // A student pushed pawtograder-submit/<sha> at their own commit first.
  await withForgejo(
    [
      status(409),
      ok({ commit: { sha: "1111111111111111111111111111111111111111" } }),
      new Response(null, { status: 204 }),
      status(201),
      new Response(null, { status: 204 })
    ],
    async (calls) => {
      await startGrading(config, "cs4535/hw1-alex.kim", sha);
      assertEquals(
        calls.map((c) => c.method),
        ["POST", "GET", "DELETE", "POST", "POST"]
      );
      assertEquals(calls[2].url, tagUrl);
      assertEquals(calls[3].body, {
        tag_name: `pawtograder-submit/${sha}`,
        target: sha,
        message: "pawtograder submission"
      });
    }
  );
  // Pushed again right after the replacement: refuse rather than dispatch at the student's commit.
  const other = { commit: { sha: "1111111111111111111111111111111111111111" } };
  await withForgejo(
    [
      status(409),
      ok(other),
      new Response(null, { status: 204 }),
      status(409),
      ok(other),
      new Response(null, { status: 204 })
    ],
    async (calls) => {
      await assertRejects(
        () => startGrading(config, "cs4535/hw1-alex.kim", sha),
        Error,
        "The submission tag points at another commit"
      );
      assert(!calls.some((c) => c.url.endsWith("/dispatches")), "dispatched at the wrong commit");
    }
  );
});

/**
 * A Forgejo token list paged like the real one: newest first, with X-Total-Count. `beforePage` runs before a
 * page is answered, as a concurrent request would. `beforeCount` runs between a page's rows and its count, which
 * Forgejo's FindAndCount reads in two queries. `order` picks a page's rows, by default the list's own order.
 */
async function withTokenList(
  tokens: string[],
  beforePage: (page: number, tokens: string[]) => void,
  fn: (tokens: string[], pagesRead: number[]) => Promise<void>,
  beforeCount: (page: number, tokens: string[]) => void = () => {},
  order: (page: number, limit: number, tokens: string[]) => string[] = (page, limit, tokens) =>
    tokens.slice((page - 1) * limit, page * limit)
) {
  const realFetch = globalThis.fetch;
  const pagesRead: number[] = [];
  // Forgejo's ids only grow: the oldest token, last in the list, has the lowest, and a later mint the next one.
  const ids = new Map(tokens.map((name, i) => [name, tokens.length - i]));
  const idOf = (name: string) => {
    if (!ids.has(name)) ids.set(name, Math.max(0, ...ids.values()) + 1);
    return ids.get(name)!;
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const del = url.pathname.match(/\/tokens\/([^/]+)$/);
    if (method === "DELETE" && del) {
      const i = tokens.indexOf(decodeURIComponent(del[1]));
      if (i >= 0) tokens.splice(i, 1);
      return Promise.resolve(new Response(null, { status: i >= 0 ? 204 : 404 }));
    }
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    beforePage(page, tokens);
    pagesRead.push(page);
    const body = order(page, limit, tokens).map((name) => ({ id: idOf(name), name }));
    beforeCount(page, tokens);
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "X-Total-Count": String(tokens.length) } }));
  }) as typeof fetch;
  try {
    await fn(tokens, pagesRead);
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("token list: a deletion between page reads doesn't hide a token; the list is read again", async () => {
  const now = Date.now();
  // Newest first: 50 of repository 7's tokens, then repository 9's, the 51st.
  const others = Array.from({ length: 50 }, (_, i) => coderTokenName(7, now - i));
  const target = coderTokenName(9, now - 60_000);
  let raced = false;
  await withTokenList(
    [...others, target],
    (page, tokens) => {
      // Another request revokes repository 7's tokens after page 1 was read: page 2 would be empty.
      if (page === 2 && !raced) {
        raced = true;
        tokens.splice(0, 50);
      }
    },
    async (tokens, pagesRead) => {
      assertEquals(await revokeRepoToken(config, "alex.kim", 9), 1);
      assertEquals(tokens, [], "repository 9's token is revoked");
      assertEquals(pagesRead, [1, 2, 1]);
    }
  );
});

Deno.test("token list: a deletion between page 1's rows and its count doesn't hide a token", async () => {
  const now = Date.now();
  // The review's case: page 1 reads 50 of 51 tokens, then those 50 are revoked before its count is read, so
  // page 1 and page 2 both report a count of 1.
  const others = Array.from({ length: 50 }, (_, i) => coderTokenName(7, now - i));
  const target = coderTokenName(9, now - 60_000);
  let raced = false;
  await withTokenList(
    [...others, target],
    () => {},
    async (tokens, pagesRead) => {
      assertEquals(await revokeRepoToken(config, "alex.kim", 9), 1);
      assertEquals(tokens, [], "repository 9's token is revoked");
      assertEquals(pagesRead, [1, 2, 1, 1], "page 1 read again shows the change, and the list is read again");
    },
    (page, tokens) => {
      if (page === 1 && !raced) {
        raced = true;
        tokens.splice(0, 50);
      }
    }
  );
});

Deno.test("token list: a deletion that a mint hides from the count doesn't hide a token", async () => {
  const now = Date.now();
  // 101 tokens, the target 51st. Before page 2 one of page 1's tokens is revoked, so the target moves onto
  // page 1's end, already read. A mint lands before page 2's count, which is 101 again.
  const names = Array.from({ length: 101 }, (_, i) => coderTokenName(i === 50 ? 9 : 7, now - 60_000 - i));
  const target = names[50];
  let raced = false;
  await withTokenList(
    names,
    (page, tokens) => {
      if (page === 2 && !raced) tokens.splice(0, 1);
    },
    async (tokens, pagesRead) => {
      assertEquals(await revokeRepoToken(config, "alex.kim", 9), 1);
      assert(!tokens.includes(target), "repository 9's token is revoked");
      assertEquals(pagesRead.slice(0, 4), [1, 2, 3, 1], "the changed page 1 sends the scan round again");
    },
    (page, tokens) => {
      if (page === 2 && !raced) {
        raced = true;
        tokens.unshift(coderTokenName(7, now));
      }
    }
  );
});

Deno.test("token list: tokens tied on created_unix, ordered differently by two pages, don't hide one", async () => {
  const now = Date.now();
  // The 50th and 51st tokens were created in the same second. Page 1 puts the 50th last; page 2's query
  // orders the tie the other way, so it repeats the 50th and leaves out the 51st, the one to revoke. The
  // count and the re-read of page 1 both match.
  const names = Array.from({ length: 51 }, (_, i) => coderTokenName(i === 50 ? 9 : 7, now - 60_000 - i));
  const target = names[50];
  const limits: number[] = [];
  await withTokenList(
    names,
    () => {},
    async (tokens) => {
      assertEquals(await revokeRepoToken(config, "alex.kim", 9), 1);
      assert(!tokens.includes(target), "repository 9's token is revoked");
      assertEquals(limits.slice(0, 3), [50, 50, 50], "the first scan reads pages 1, 2 and 1 again");
      assertEquals(limits[3], 49, "the scan that saw 50 names of 51 is read again with other page boundaries");
    },
    () => {},
    (page, limit, tokens) => {
      limits.push(limit);
      const rows = tokens.slice((page - 1) * limit, page * limit);
      return page === 2 && limit === 50 ? [tokens[49]] : rows;
    }
  );
});

Deno.test("token list: a tie that splits every page boundary tried is an error, and nothing is revoked", async () => {
  const now = Date.now();
  const names = Array.from({ length: 120 }, (_, i) => coderTokenName(9, now - 60_000 - i));
  await withTokenList(
    names,
    () => {},
    async (tokens) => {
      await assertRejects(() => revokeRepoToken(config, "alex.kim", 9), Error, "kept changing");
      assertEquals(tokens.length, 120, "nothing deleted from a list that wasn't read whole");
    },
    () => {},
    // Every later page repeats the last row of the page before in place of its own first one.
    (page, limit, tokens) => {
      const rows = tokens.slice((page - 1) * limit, page * limit);
      return page === 1 ? rows : [tokens[(page - 1) * limit - 1], ...rows.slice(1)];
    }
  );
});

Deno.test("token list: a MAX_RESPONSE_ITEMS below the page size asked for still reads the whole list", async () => {
  const now = Date.now();
  // Forgejo caps limit at 20 here: page 1 comes back short, but X-Total-Count says 21.
  const names = Array.from({ length: 21 }, (_, i) => coderTokenName(i === 20 ? 9 : 7, now - 60_000 - i));
  const target = names[20];
  await withTokenList(
    names,
    () => {},
    async (tokens, pagesRead) => {
      assertEquals(await revokeRepoToken(config, "alex.kim", 9), 1);
      assert(!tokens.includes(target), "repository 9's token, the 21st, is revoked");
      assertEquals(pagesRead, [1, 2, 1]);
    },
    () => {},
    (page, _limit, tokens) => tokens.slice((page - 1) * 20, page * 20)
  );
});

// The review's interleaving: 101 tokens created in one second. After pages 1 and 2 are read, token 51 is revoked
// and a token is minted in the same second, which Forgejo's page-3 query places last. Token 101 moves onto page 2,
// read already, and page 3 holds the new token instead. The count, page 1 and the number of names all match.
const TIED = 101;

Deno.test("token list: a mint tied with the tokens at a page boundary, past page 1, doesn't hide a token", async () => {
  const now = Date.now();
  const names = Array.from({ length: TIED }, (_, i) => coderTokenName(7, now - 60_000 - i));
  const last = names[TIED - 1];
  const minted = coderTokenName(7, now);
  let raced = false;
  await withTokenList(
    names,
    (page, tokens) => {
      if (page === 3 && !raced) {
        raced = true;
        tokens.splice(50, 1);
        tokens.unshift(minted);
      }
    },
    async (tokens, pagesRead) => {
      assertEquals(await revokeAllCoderTokens(config, "alex.kim"), TIED);
      assert(!tokens.includes(last), "token 101 is revoked");
      assertEquals(tokens, []);
      assertEquals(pagesRead.slice(0, 4), [1, 2, 3, 1], "the new token's id sends the scan round again");
    },
    () => {},
    // The first scan's queries (50 a page) order the tie with the new token last; the retry's put it first.
    (page, limit, tokens) => {
      const view = limit === 50 && tokens[0] === minted ? [...tokens.slice(1), minted] : tokens;
      return view.slice((page - 1) * limit, page * limit);
    }
  );
});

Deno.test("token list: a mint that every query places past page 1 is an error, and nothing is revoked", async () => {
  const now = Date.now();
  const names = Array.from({ length: TIED }, (_, i) => coderTokenName(7, now - 60_000 - i));
  let raced = false;
  await withTokenList(
    names,
    (page, tokens) => {
      if (page === 3 && !raced) {
        raced = true;
        tokens.splice(50, 1);
        tokens.push(coderTokenName(7, now));
      }
    },
    async (tokens) => {
      await assertRejects(() => revokeAllCoderTokens(config, "alex.kim"), Error, "kept changing");
      assertEquals(tokens.length, TIED, "nothing deleted from a list that couldn't be shown whole");
    }
  );
});

Deno.test("token list: a list that keeps changing is an error, so nothing is taken as revoked", async () => {
  const now = Date.now();
  const names = Array.from({ length: 60 }, (_, i) => coderTokenName(9, now - 60_000 - i));
  await withTokenList(
    names,
    (page, tokens) => {
      if (page === 2) tokens.pop();
    },
    async (tokens) => {
      await assertRejects(() => revokeRepoToken(config, "alex.kim", 9), Error, "kept changing");
      assertEquals(tokens.length, 57, "nothing deleted from a list that wasn't read whole");
      await assertRejects(() => revokeIdleTokens(config, "alex.kim", 1, now + IDLE_TOKEN_MS), Error, "kept changing");
    }
  );
});

const page = (body: unknown[], total = body.length) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "X-Total-Count": String(total) } });
const archivedAt = new Date("2026-11-21T20:00:00.123Z");

Deno.test("archiveRepo: removes every collaborator, then renames and archives the repo", async () => {
  await withForgejo([page([{ login: "Alex" }, { login: "sam" }]), noContent(), noContent(), ok({})], async (calls) => {
    assertEquals(
      await archiveRepo(config, "cs4535/hw1-group-a", archivedRepoName("cs4535/hw1-group-a", archivedAt)),
      "cs4535/archived-2026-11-21T20-00-00-123Z-hw1-group-a"
    );
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET https://git.example.edu/api/v1/repos/cs4535/hw1-group-a/collaborators?page=1&limit=50",
        "DELETE https://git.example.edu/api/v1/repos/cs4535/hw1-group-a/collaborators/Alex",
        "DELETE https://git.example.edu/api/v1/repos/cs4535/hw1-group-a/collaborators/sam",
        "PATCH https://git.example.edu/api/v1/repos/cs4535/hw1-group-a"
      ]
    );
    assertEquals(calls[3].body, { name: "archived-2026-11-21T20-00-00-123Z-hw1-group-a", archived: true });
  });
});

Deno.test("archiveRepo: reads past a page Forgejo cut short", async () => {
  // MAX_RESPONSE_ITEMS set to 1: two collaborators arrive one at a time.
  await withForgejo(
    [page([{ login: "a" }], 2), page([{ login: "b" }], 2), noContent(), noContent(), ok({})],
    async (calls) => {
      await archiveRepo(config, "cs4535/hw1-a", archivedRepoName("cs4535/hw1-a", archivedAt));
      assertEquals(calls.filter((c) => c.method === "DELETE").length, 2);
    }
  );
});

const missing = () => new Response(JSON.stringify({ message: "repository does not exist" }), { status: 404 });

Deno.test("archiveRepo: a repo that's gone from both names is done, with no new name", async () => {
  await withForgejo([missing(), missing()], async (calls) => {
    assertEquals(await archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"), null);
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET https://git.example.edu/api/v1/repos/cs4535/hw1-a/collaborators?page=1&limit=50",
        "GET https://git.example.edu/api/v1/repos/cs4535/archived-x-hw1-a"
      ]
    );
  });
});

// The case the destination exists for: a pass renamed the repo and died before writing down where it went.
Deno.test("archiveRepo: a repo an earlier attempt already renamed is reported at its destination", async () => {
  await withForgejo([missing(), ok({ name: "archived-x-hw1-a", archived: true })], async (calls) => {
    assertEquals(await archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"), "cs4535/archived-x-hw1-a");
    assertEquals(calls.length, 2);
  });
});

// Forgejo renames before it sets the archive flag, so the earlier attempt may have stopped in between.
Deno.test("archiveRepo: a repo renamed but never locked is archived at its destination", async () => {
  await withForgejo([missing(), ok({ name: "archived-x-hw1-a", archived: false }), ok({})], async (calls) => {
    assertEquals(await archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"), "cs4535/archived-x-hw1-a");
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET https://git.example.edu/api/v1/repos/cs4535/hw1-a/collaborators?page=1&limit=50",
        "GET https://git.example.edu/api/v1/repos/cs4535/archived-x-hw1-a",
        "PATCH https://git.example.edu/api/v1/repos/cs4535/archived-x-hw1-a"
      ]
    );
    assertEquals(calls[2].body, { archived: true });
  });
});

Deno.test("archiveRepo: a destination Forgejo won't lock is an error, not a finished archive", async () => {
  await withForgejo(
    [missing(), ok({ name: "archived-x-hw1-a", archived: false }), new Response("boom", { status: 500 })],
    async () => {
      await assertRejects(
        () => archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"),
        Error,
        "repo archive failed: 500"
      );
    }
  );
});

Deno.test("archiveRepo: a repo that disappears before the rename is looked for at its destination", async () => {
  await withForgejo([page([]), missing(), ok({ name: "archived-x-hw1-a", archived: true })], async (calls) => {
    assertEquals(await archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"), "cs4535/archived-x-hw1-a");
    assertEquals(calls[2].url, "https://git.example.edu/api/v1/repos/cs4535/archived-x-hw1-a");
  });
});

Deno.test("archiveRepo: a destination read that fails is an error, not a vanished repo", async () => {
  await withForgejo([missing(), new Response("boom", { status: 500 })], async () => {
    await assertRejects(
      () => archiveRepo(config, "cs4535/hw1-a", "cs4535/archived-x-hw1-a"),
      Error,
      "repo read failed: 500"
    );
  });
});

Deno.test("archiveRepo: a collaborator Forgejo won't remove stops before the rename", async () => {
  await withForgejo([page([{ login: "a" }]), new Response("boom", { status: 500 })], async (calls) => {
    await assertRejects(
      () => archiveRepo(config, "cs4535/hw1-a", archivedRepoName("cs4535/hw1-a", archivedAt)),
      Error,
      "collaborator remove failed: 500"
    );
    assertEquals(calls.length, 2);
  });
});

Deno.test("archivedRepoName: the new name stays within Forgejo's 100 characters", async () => {
  const name = "x".repeat(90);
  const destination = archivedRepoName(`cs4535/${name}`, archivedAt);
  await withForgejo([page([]), ok({})], async (calls) => {
    const archived = await archiveRepo(config, `cs4535/${name}`, destination);
    assertEquals((calls[1].body!.name as string).length, 100);
    assertEquals(archived, `cs4535/${calls[1].body!.name}`);
    assertEquals(archived, destination);
  });
});

Deno.test("archivedRepoName: long names that differ only past the cut get different destinations", () => {
  const shared = "x".repeat(90);
  const a = archivedRepoName(`cs4535/${shared}-alex`, archivedAt);
  const b = archivedRepoName(`cs4535/${shared}-sam`, archivedAt);
  assert(a !== b, a);
  assertEquals(a.length, "cs4535/".length + 100);
  assertEquals(archivedRepoName(`cs4535/${shared}-alex`, archivedAt), a, "the same name always maps to the same place");
  // A name that fits is left as GitHub's archiveRepoAndLock would write it.
  assertEquals(archivedRepoName("cs4535/hw1-a", archivedAt), "cs4535/archived-2026-11-21T20-00-00-123Z-hw1-a");
});

Deno.test("archivedRepoName: a name that isn't owner/name is refused where the name is chosen", () => {
  assertThrows(() => archivedRepoName("cs4535/../admin", archivedAt), Error, "Not a Forgejo owner/name");
});

Deno.test("archiveRepo: a name that isn't owner/name never reaches Forgejo", async () => {
  await withForgejo([], async () => {
    await assertRejects(
      () => archiveRepo(config, "cs4535/../admin", "cs4535/archived-x-admin"),
      Error,
      "Not a Forgejo owner/name"
    );
  });
});

// A destination is read back from the database, so it can only ever rename the repo where it already is.
Deno.test("archiveRepo: a destination in another owner never reaches Forgejo", async () => {
  await withForgejo([], async () => {
    await assertRejects(
      () => archiveRepo(config, "cs4535/hw1-a", "cs3500/archived-x-hw1-a"),
      Error,
      "archive destination is in another owner"
    );
  });
});
