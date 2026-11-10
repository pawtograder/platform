/**
 * Forgejo account creation for #1092. Forgejo is stubbed at fetch; the response bodies and 422
 * messages are the ones Forgejo 15.0.9 returns.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoWrapper.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  downloadArchive,
  ensureAccountForUser,
  forgejoConfig,
  type ForgejoConfig,
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
      await assertRejects(() => ensureAccountForUser(config, user), Error, "e-mail already in use");
      assertEquals(calls.length, 2);
    }
  );
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
