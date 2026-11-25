/**
 * Handout commit history for Forgejo: pushes to a handout reach assignment_handout_commits, and so does the
 * handout's head commit at creation. Forgejo is stubbed at fetch.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/forgejoHandoutCommits.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { ForgejoPushPayload } from "../forgejo-repo-webhook/webhook.ts";
import type { ForgejoConfig } from "./ForgejoWrapper.ts";
import { recordForgejoHandoutPush, recordHandoutCommits, recordInitialHandoutCommit } from "./forgejoHandoutCommits.ts";
import type { Database } from "./SupabaseTypes.d.ts";

// webhook.ts imports GitHubWrapper (through PushDirectSubmission), which builds a GitHub App at import time
// and needs a non-empty private key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { fromForgejoPush, handleForgejoPush } = await import("../forgejo-repo-webhook/webhook.ts");

type Row = Record<string, unknown>;
type Upsert = { table: string; rows: Row[]; options: unknown };

/** `eq` and `ilike` (unescaped, no wildcards) are applied to the rows; upserts are recorded. */
function fakeSupabase(tables: Record<string, Row[]>, upsertError: { code: string; message: string } | null = null) {
  const upserts: Upsert[] = [];
  const client = {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      const chain = {
        select: () => chain,
        limit: () => chain,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return chain;
        },
        ilike(column: string, pattern: string) {
          const literal = pattern.replace(/\\(.)/g, "$1").toLowerCase();
          filters.push((row) => String(row[column]).toLowerCase() === literal);
          return chain;
        },
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
        upsert(rows: Row[], options: unknown) {
          if (upsertError) return Promise.resolve({ error: upsertError });
          upserts.push({ table, rows, options });
          return Promise.resolve({ error: null });
        }
      };
      return chain;
    }
  };
  return { client: client as unknown as SupabaseClient<Database>, upserts };
}

const HANDOUT = "cs4535-demo/cs4535-cw-demo-handout-hw2";
const HEAD = "c6bfda7e5a1f0c2b3d4e5f60718293a4b5c6d7e8";
const PARENT = "0d037515c284fb0f7c5fea3fd3412d15f7ee997a";

function tables() {
  return {
    repositories: [] as Row[],
    assignments: [
      { id: 100, class_id: 10, git_provider: "forgejo", template_repo: HANDOUT },
      { id: 101, class_id: 11, git_provider: "forgejo", template_repo: HANDOUT },
      // Same owner/name on GitHub: a Forgejo push must never reach it.
      { id: 200, class_id: 10, git_provider: "github", template_repo: HANDOUT }
    ]
  };
}

/** A push from Forgejo 15.0.9 to the handout, trimmed. Forgejo lists the newest commit first. */
function handoutPayload(fullName = HANDOUT): ForgejoPushPayload {
  const author = { name: "Jon Bell" };
  const head = { id: HEAD, message: "Fix the starter tests\n", timestamp: "2026-11-21T10:00:00-05:00", author };
  return {
    ref: "refs/heads/main",
    after: HEAD,
    commits: [head, { ...head, id: PARENT, message: "Add part 2\n", removed: null }],
    total_commits: 2,
    head_commit: head,
    repository: {
      full_name: fullName,
      html_url: `https://git.example.edu/${fullName}`,
      default_branch: "main"
    },
    pusher: { login: "jon" }
  };
}

const rowsOf = (upserts: Upsert[]) =>
  upserts.flatMap(({ table, rows }) =>
    rows.map((r) => [table, r.assignment_id, r.class_id, r.sha, r.message, r.author])
  );

Deno.test("handleForgejoPush records a handout push in each Forgejo assignment's handout history", async () => {
  const { client, upserts } = fakeSupabase(tables());
  // Forgejo names are case-insensitive, and a push carries the current casing.
  await handleForgejoPush(client, fromForgejoPush(handoutPayload(HANDOUT.toUpperCase())), new Sentry.Scope());
  assertEquals(rowsOf(upserts), [
    ["assignment_handout_commits", 100, 10, PARENT, "Add part 2", "Jon Bell"],
    ["assignment_handout_commits", 100, 10, HEAD, "Fix the starter tests", "Jon Bell"],
    ["assignment_handout_commits", 101, 11, PARENT, "Add part 2", "Jon Bell"],
    ["assignment_handout_commits", 101, 11, HEAD, "Fix the starter tests", "Jon Bell"]
  ]);
  assertEquals(upserts[0].options, { onConflict: "assignment_id,sha" });
});

Deno.test("recordForgejoHandoutPush records the head commit when the payload lists no commits", async () => {
  const { client, upserts } = fakeSupabase(tables());
  const push = fromForgejoPush({ ...handoutPayload(), commits: [] });
  assertEquals(await recordForgejoHandoutPush(client, push, new Sentry.Scope()), true);
  assertEquals(
    rowsOf(upserts).map((r) => r[3]),
    [HEAD, HEAD]
  );
});

Deno.test("recordForgejoHandoutPush skips another branch, and reports an unknown repository", async () => {
  const branch = fakeSupabase(tables());
  const scratch = { ...fromForgejoPush(handoutPayload()), ref: "refs/heads/scratch" };
  assertEquals(await recordForgejoHandoutPush(branch.client, scratch, new Sentry.Scope()), true);
  assertEquals(branch.upserts, []);

  const unknown = fakeSupabase(tables());
  const other = fromForgejoPush(handoutPayload("cs4535-demo/something-else"));
  assertEquals(await recordForgejoHandoutPush(unknown.client, other, new Sentry.Scope()), false);
  assertEquals(unknown.upserts, []);

  // Only a GitHub assignment uses the name: not a Forgejo handout.
  const t = tables();
  t.assignments = t.assignments.filter((a) => a.git_provider === "github");
  const github = fakeSupabase(t);
  assertEquals(
    await recordForgejoHandoutPush(github.client, fromForgejoPush(handoutPayload()), new Sentry.Scope()),
    false
  );
});

Deno.test("recordHandoutCommits skips a constraint violation and throws anything else", async () => {
  const commits = [{ sha: HEAD, message: "m", author: "a" }];
  const assignments = [{ id: 100, class_id: 10 }];
  const quiet = console.error;
  console.error = () => {};
  try {
    const violation = fakeSupabase(tables(), { code: "23503", message: "foreign key" });
    await recordHandoutCommits(violation.client, assignments, commits, new Sentry.Scope());

    const down = fakeSupabase(tables(), { code: "57P01", message: "terminating connection" });
    await assertRejects(() => recordHandoutCommits(down.client, assignments, commits, new Sentry.Scope()));
  } finally {
    console.error = quiet;
  }
});

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };

async function withForgejo(responses: Response[], fn: (urls: string[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${input}`);
    return Promise.resolve(next);
  }) as typeof fetch;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("recordInitialHandoutCommit records the handout's head commit from Forgejo", async () => {
  const commit = {
    sha: HEAD,
    commit: { message: "Add .github/workflows/grade.yml\n", author: { name: "pawtograder" } }
  };
  await withForgejo([new Response(JSON.stringify(commit))], async (urls) => {
    const { client, upserts } = fakeSupabase(tables());
    await recordInitialHandoutCommit(client, config, { id: 100, class_id: 10 }, HANDOUT, HEAD, new Sentry.Scope());
    assertEquals(urls, [`https://git.example.edu/api/v1/repos/${HANDOUT}/git/commits/${HEAD}`]);
    assertEquals(rowsOf(upserts), [
      ["assignment_handout_commits", 100, 10, HEAD, "Add .github/workflows/grade.yml", "pawtograder"]
    ]);
  });
});

Deno.test("recordInitialHandoutCommit doesn't fail creation when Forgejo can't find the commit", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    await withForgejo([new Response(JSON.stringify({ message: "not found" }), { status: 404 })], async () => {
      const { client, upserts } = fakeSupabase(tables());
      await recordInitialHandoutCommit(client, config, { id: 100, class_id: 10 }, HANDOUT, HEAD, new Sentry.Scope());
      assertEquals(upserts, []);
    });
  } finally {
    console.error = quiet;
  }
});
