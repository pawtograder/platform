/**
 * Forgejo account (#1092) and repo (#1093) creation. Forgejo is stubbed at fetch; the status codes,
 * response bodies and messages are the ones Forgejo 15.0.9 returns.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoWrapper.test.ts
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  downloadArchive,
  ensureAccountForUser,
  ensureOrg,
  ensureRepoFromTemplate,
  forgejoConfig,
  type ForgejoConfig,
  grantWrite,
  readFile,
  repoPath,
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

Deno.test("downloadArchive: fetches the commit's zip, and an error status fails", async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  await withForgejo([new Response(zip, { status: 200 })], async (calls) => {
    assertEquals(await downloadArchive(config, "cs4535/hw1-alex.kim", "b275490c"), zip);
    assertEquals(calls[0].url, "https://git.example.edu/api/v1/repos/cs4535/hw1-alex.kim/archive/b275490c.zip");
  });
  await withForgejo([new Response("Not Found", { status: 404 })], async () => {
    await assertRejects(() => downloadArchive(config, "cs4535/hw1-alex.kim", "b275490c"), Error, "404");
  });
});

Deno.test("downloadArchive: gives up on a request Forgejo never answers", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  try {
    await assertRejects(() => downloadArchive(config, "cs4535/hw1-alex.kim", "0000", 50), DOMException);
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
