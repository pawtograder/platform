/**
 * Forgejo account (#1092) and repo (#1093) creation. Forgejo is stubbed at fetch; the status codes,
 * response bodies and messages are the ones Forgejo 15.0.9 returns.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoWrapper.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  ensureAccountForUser,
  ensureOrg,
  ensureRepoFromTemplate,
  forgejoConfig,
  type ForgejoConfig,
  grantWrite,
  readFile,
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

const status = (code: number, message = "") => new Response(JSON.stringify({ message }), { status: code });

Deno.test("ensureOrg: leaves an existing org alone", async () => {
  await withForgejo([ok({ username: "cs4535" })], async (calls) => {
    await ensureOrg(config, "cs4535");
    assertEquals(
      calls.map((c) => `${c.method} ${c.url}`),
      ["GET https://git.example.edu/api/v1/orgs/cs4535"]
    );
  });
});

Deno.test("ensureOrg: creates a missing org as private, and accepts losing a race to create it", async () => {
  await withForgejo([status(404), ok({}, 201)], async (calls) => {
    await ensureOrg(config, "cs4535");
    assertEquals(calls[1].body, { username: "cs4535", visibility: "private" });
  });
  await withForgejo([status(404), unprocessable("user already exists [name: cs4535]")], async () => {
    await ensureOrg(config, "cs4535");
  });
  await withForgejo([status(404), status(403, "forbidden")], async () => {
    await assertRejects(() => ensureOrg(config, "cs4535"), Error, "403");
  });
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
