/**
 * Staff file reads, listings and writes on Forgejo (#1385). Forgejo is stubbed at fetch.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/ForgejoRepoFiles.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { type ForgejoConfig, ForgejoStatusError, getRepoFile, listRepoFiles, writeRepoFile } from "./ForgejoWrapper.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };

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
const notFound = () => new Response(JSON.stringify({ message: "GetContentsOrList" }), { status: 404 });

Deno.test("getRepoFile: returns the decoded file and its blob sha", async () => {
  const text = "grader: java\n";
  await withForgejo([ok({ type: "file", content: btoa(text), sha: "b10b" })], async (calls) => {
    assertEquals(await getRepoFile(config, "cs4535/hw1-handout", ".github/workflows/grade.yml"), {
      content: text,
      sha: "b10b"
    });
    assertEquals(
      calls[0].url,
      "https://git.example.edu/api/v1/repos/cs4535/hw1-handout/contents/.github/workflows/grade.yml"
    );
  });
});

Deno.test("getRepoFile: a missing file is a 404 status error, and a directory isn't a file", async () => {
  await withForgejo([notFound(), ok([{ type: "file" }])], async () => {
    const missing = await assertRejects(() => getRepoFile(config, "cs4535/hw1", "pawtograder.yml"), ForgejoStatusError);
    assertEquals(missing.status, 404);
    await assertRejects(() => getRepoFile(config, "cs4535/hw1", "src"), Error, "File is not a file");
  });
});

Deno.test("getRepoFile: a path with .. never reaches Forgejo", async () => {
  await withForgejo([], async () => {
    await assertRejects(() => getRepoFile(config, "cs4535/hw1", "../../admin"), Error, "Not a file path");
    await assertRejects(() => getRepoFile(config, "cs4535/hw1", "a//b"), Error, "Not a file path");
  });
});

Deno.test("listRepoFiles: lists every blob on the default branch's commit, across tree pages", async () => {
  await withForgejo(
    [
      ok({ empty: false, default_branch: "main" }),
      ok({ commit: { id: "abc123" } }),
      ok({
        tree: [
          { path: "src", type: "tree", sha: "t1" },
          { path: "src/Main.java", type: "blob", size: 10, sha: "s1" }
        ],
        truncated: true
      }),
      ok({ tree: [{ path: "pawtograder.yml", type: "blob", size: 5, sha: "s2" }], truncated: false })
    ],
    async (calls) => {
      assertEquals(await listRepoFiles(config, "cs4535/hw1"), [
        { name: "Main.java", path: "src/Main.java", size: 10, sha: "s1" },
        { name: "pawtograder.yml", path: "pawtograder.yml", size: 5, sha: "s2" }
      ]);
      assertEquals(
        calls.map((c) => c.url.replace("https://git.example.edu/api/v1", "")),
        [
          "/repos/cs4535/hw1",
          "/repos/cs4535/hw1/branches/main",
          "/repos/cs4535/hw1/git/trees/abc123?recursive=true&per_page=1000&page=1",
          "/repos/cs4535/hw1/git/trees/abc123?recursive=true&per_page=1000&page=2"
        ]
      );
    }
  );
});

Deno.test("listRepoFiles: an empty repo lists nothing", async () => {
  await withForgejo([ok({ empty: true, default_branch: "main" })], async () => {
    assertEquals(await listRepoFiles(config, "cs4535/hw1"), []);
  });
});

Deno.test("writeRepoFile: a sha updates with PUT, no sha creates with POST", async () => {
  await withForgejo(
    [ok({ commit: { sha: "c1" }, content: { sha: "b1" } }), ok({ commit: { sha: "c2" }, content: { sha: "b2" } }, 201)],
    async (calls) => {
      assertEquals(await writeRepoFile(config, "cs4535/hw1", "pawtograder.yml", "é", "Edit", "old"), {
        commit_sha: "c1",
        content_sha: "b1"
      });
      assertEquals(await writeRepoFile(config, "cs4535/hw1", "pawtograder.yml", "x", "Add"), {
        commit_sha: "c2",
        content_sha: "b2"
      });
      assertEquals(
        calls.map((c) => [c.method, c.body]),
        [
          ["PUT", { content: btoa("\u00c3\u00a9"), message: "Edit", sha: "old" }],
          ["POST", { content: btoa("x"), message: "Add" }]
        ]
      );
    }
  );
});

Deno.test("writeRepoFile: a stale sha keeps Forgejo's status for the caller", async () => {
  await withForgejo([unprocessable("sha does not match")], async () => {
    const error = await assertRejects(
      () => writeRepoFile(config, "cs4535/hw1", "pawtograder.yml", "x", "Edit", "stale"),
      ForgejoStatusError
    );
    assertEquals(error.status, 422);
  });
});
