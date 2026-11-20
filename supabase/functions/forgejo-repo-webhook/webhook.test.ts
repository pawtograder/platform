/**
 * Unit tests for forgejo-repo-webhook: signature verification, payload conversion, and the
 * provider-scoped push handling.
 *
 * Run from supabase/functions:  deno test --no-check --allow-read --allow-env --allow-net forgejo-repo-webhook/
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { RepoPush } from "../_shared/RepoPush.ts";
import { fakeSupabase, repositoryRow } from "../_shared/RepoPushFakeClient.ts";
import {
  type ForgejoPushPayload,
  fromForgejoPush,
  handleForgejoPush,
  handleForgejoWebhook,
  verifyForgejoSignature
} from "./webhook.ts";

const SECRET = "test-webhook-secret";
const FORGEJO_URL = "http://127.0.0.1:3100";
const HEAD = "d9eb975102fb245857b4b4f7165062854958d9bf";
const PARENT = "0d037515c284fb0f7c5fea3fd3412d15f7ee997a";

/**
 * A push from Forgejo 15.0.9, trimmed. Forgejo lists the newest commit first. It keeps fields the
 * handler doesn't read, so it is built untyped and checked against ForgejoPushPayload on return.
 */
function forgejoPayload(): ForgejoPushPayload {
  const author = { name: "Alex Kim", email: "alex@forgejo.e2e.test", username: "alex" };
  const head = {
    id: HEAD,
    message: "Finish part 1 #submit\n",
    url: `${FORGEJO_URL}/cs101/hw1-alex/commit/${HEAD}`,
    author,
    committer: author,
    timestamp: "2026-11-09T11:53:33-05:00",
    added: [],
    removed: [],
    modified: ["NOTES.md"]
  };
  const payload = {
    ref: "refs/heads/main",
    before: "ac9fbc2cdcf250451cc21e089b4d3dacbe4f4e10",
    after: HEAD,
    compare_url: `${FORGEJO_URL}/cs101/hw1-alex/compare/ac9fbc2cdcf250451cc21e089b4d3dacbe4f4e10...${HEAD}`,
    commits: [
      head,
      { ...head, id: PARENT, message: "Start part 1\n", added: ["NOTES.md"], removed: null, modified: [] }
    ],
    total_commits: 2,
    head_commit: head,
    repository: {
      id: 1,
      name: "hw1-alex",
      full_name: "cs101/hw1-alex",
      html_url: `${FORGEJO_URL}/cs101/hw1-alex`,
      default_branch: "main",
      private: true
    },
    pusher: { id: 2, login: "alex", username: "alex", full_name: "" },
    sender: { id: 2, login: "alex", username: "alex", full_name: "" }
  };
  return payload;
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("verifyForgejoSignature accepts the HMAC-SHA256 of the body under the secret", async () => {
  const body = JSON.stringify(forgejoPayload());
  const signature = await sign(SECRET, body);
  assert(await verifyForgejoSignature(SECRET, bytes(body), signature));
  assert(await verifyForgejoSignature(SECRET, bytes(body), signature.toUpperCase()));
});

Deno.test("verifyForgejoSignature rejects a wrong secret, a missing header and a tampered body", async () => {
  const body = JSON.stringify(forgejoPayload());
  const signature = await sign(SECRET, body);
  assert(!(await verifyForgejoSignature(SECRET, bytes(body), await sign("other-secret", body))));
  assert(!(await verifyForgejoSignature(SECRET, bytes(body), null)));
  assert(!(await verifyForgejoSignature(SECRET, bytes(body), "")));
  assert(!(await verifyForgejoSignature(SECRET, bytes(body.replace("part 1", "part 2")), signature)));
  // An unset secret never verifies, whatever the signature.
  assert(!(await verifyForgejoSignature("", bytes(body), signature)));
});

Deno.test("verifyForgejoSignature rejects malformed and wrong-length hex", async () => {
  const body = JSON.stringify(forgejoPayload());
  const signature = await sign(SECRET, body);
  for (const bad of [
    signature.slice(0, 63),
    signature + "0",
    signature.slice(0, 62),
    `sha256=${signature}`,
    signature.slice(0, 63) + "g",
    "not-hex",
    signature.slice(0, 40)
  ]) {
    assert(!(await verifyForgejoSignature(SECRET, bytes(body), bad)), bad);
  }
});

Deno.test("fromForgejoPush lists commits oldest first, without git's trailing newline", () => {
  assertEquals(fromForgejoPush(forgejoPayload()), {
    provider: "forgejo",
    repository: "cs101/hw1-alex",
    ref: "refs/heads/main",
    after: HEAD,
    defaultBranch: "main",
    headCommit: {
      id: HEAD,
      message: "Finish part 1 #submit",
      timestamp: "2026-11-09T11:53:33-05:00",
      author: { name: "Alex Kim" },
      removed: []
    },
    commits: [
      {
        id: PARENT,
        message: "Start part 1",
        timestamp: "2026-11-09T11:53:33-05:00",
        author: { name: "Alex Kim" },
        removed: []
      },
      {
        id: HEAD,
        message: "Finish part 1 #submit",
        timestamp: "2026-11-09T11:53:33-05:00",
        author: { name: "Alex Kim" },
        removed: []
      }
    ],
    totalCommits: 2,
    pusherName: "alex"
  });
});

Deno.test("fromForgejoPush handles a push with no commits, such as a branch deletion", () => {
  const payload = { ...forgejoPayload(), commits: null, head_commit: null, pusher: null };
  const push = fromForgejoPush(payload);
  assertEquals(push.commits, []);
  assertEquals(push.headCommit, null);
  assertEquals(push.pusherName, "alex");
});

/** Calls handleForgejoWebhook with a spy push handler. */
async function deliver(init: { body?: string; headers?: Record<string, string>; method?: string }, config = {}) {
  const pushes: RepoPush[] = [];
  const response = await handleForgejoWebhook(
    new Request("http://localhost/functions/v1/forgejo-repo-webhook", {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.method === "GET" ? undefined : (init.body ?? "")
    }),
    {
      secret: SECRET,
      forgejoUrl: FORGEJO_URL,
      handlePush: (push) => {
        pushes.push(push);
        return Promise.resolve();
      },
      ...config
    }
  );
  return { status: response.status, body: await response.json(), pushes };
}

async function signedHeaders(body: string, event = "push", secret = SECRET) {
  const signature = await sign(secret, body);
  return { "X-Forgejo-Event": event, "X-Forgejo-Signature": signature, "X-Gitea-Signature": signature };
}

Deno.test("handleForgejoWebhook passes a signed push to the push handler", async () => {
  const body = JSON.stringify(forgejoPayload());
  const result = await deliver({ body, headers: await signedHeaders(body) });
  assertEquals(result.status, 200);
  assertEquals(result.pushes, [fromForgejoPush(forgejoPayload())]);
});

Deno.test("handleForgejoWebhook accepts X-Gitea-Signature alone", async () => {
  const body = JSON.stringify(forgejoPayload());
  const result = await deliver({
    body,
    headers: { "X-Gitea-Event": "push", "X-Gitea-Signature": await sign(SECRET, body) }
  });
  assertEquals(result.status, 200);
  assertEquals(result.pushes.length, 1);
});

Deno.test("handleForgejoWebhook answers 401 and handles nothing when the signature is bad", async () => {
  const body = JSON.stringify(forgejoPayload());
  const cases: Record<string, { body: string; headers: Record<string, string> }> = {
    "wrong secret": { body, headers: await signedHeaders(body, "push", "other-secret") },
    "missing header": { body, headers: { "X-Forgejo-Event": "push" } },
    "malformed hex": { body, headers: { "X-Forgejo-Event": "push", "X-Forgejo-Signature": "zz" } },
    "tampered body": { body: body.replace("part 1", "part 2"), headers: await signedHeaders(body) },
    // A bad signature is rejected before the body is parsed, even when it isn't JSON.
    "unsigned garbage": { body: "not json", headers: { "X-Forgejo-Event": "push" } }
  };
  for (const [label, init] of Object.entries(cases)) {
    const result = await deliver(init);
    assertEquals([label, result.status, result.pushes.length], [label, 401, 0]);
  }
});

Deno.test("handleForgejoWebhook acknowledges other events without handling them", async () => {
  const body = JSON.stringify({ action: "opened", number: 1 });
  for (const event of ["issues", "create", "pull_request"]) {
    const result = await deliver({ body, headers: await signedHeaders(body, event) });
    assertEquals([event, result.status, result.pushes.length], [event, 200, 0]);
  }
});

Deno.test("handleForgejoWebhook rejects what it can't handle without calling the push handler", async () => {
  const notJson = "payload=%7B%7D";
  assertEquals((await deliver({ body: notJson, headers: await signedHeaders(notJson) })).status, 400);
  const notPush = JSON.stringify({ ref: "refs/heads/main" });
  assertEquals((await deliver({ body: notPush, headers: await signedHeaders(notPush) })).status, 400);

  const elsewhere = forgejoPayload();
  elsewhere.repository.html_url = "https://git.example.com/cs101/hw1-alex";
  const otherInstance = JSON.stringify(elsewhere);
  const result = await deliver({ body: otherInstance, headers: await signedHeaders(otherInstance) });
  assertEquals([result.status, result.pushes.length], [403, 0]);
  // The base URL is matched as a path prefix, not a string prefix.
  elsewhere.repository.html_url = `${FORGEJO_URL}0/cs101/hw1-alex`;
  const lookalike = JSON.stringify(elsewhere);
  assertEquals((await deliver({ body: lookalike, headers: await signedHeaders(lookalike) })).status, 403);

  assertEquals((await deliver({ method: "GET" })).status, 405);
});

Deno.test("handleForgejoWebhook fails closed when the secret or FORGEJO_URL is unset", async () => {
  const body = JSON.stringify(forgejoPayload());
  for (const config of [{ secret: undefined }, { secret: "" }, { forgejoUrl: undefined }]) {
    const result = await deliver({ body, headers: await signedHeaders(body) }, config);
    assertEquals([result.status, result.pushes.length], [500, 0]);
  }
});

Deno.test("handleForgejoWebhook answers 500 when handling the push fails, so Forgejo shows it", async () => {
  const body = JSON.stringify(forgejoPayload());
  const result = await deliver(
    { body, headers: await signedHeaders(body) },
    { handlePush: () => Promise.reject(new Error("database down")) }
  );
  assertEquals(result.status, 500);
});

function tables(gitProvider = "forgejo") {
  return {
    repositories: [repositoryRow({ id: 7, repository: "cs101/hw1-alex", git_provider: gitProvider })],
    assignments: [{ id: 100, git_provider: gitProvider, submission_mode: "push", repo_mode: "individual" }],
    repository_check_runs: [] as Record<string, unknown>[]
  };
}

Deno.test("handleForgejoPush records each pushed commit, oldest first, in the commit history", async () => {
  const { client, inserts, queries } = fakeSupabase(tables());
  await handleForgejoPush(client, fromForgejoPush(forgejoPayload()), new Sentry.Scope());
  assertEquals(queries[0].filters, [
    ["git_provider", "forgejo"],
    ["repository", { ilike: "cs101/hw1-alex" }]
  ]);
  assertEquals(
    inserts.map(({ table, row }) => [
      table,
      row.repository_id,
      row.sha,
      row.commit_message,
      row.check_run_id,
      (row.status as { created_by: string }).created_by
    ]),
    [
      ["repository_check_runs", 7, PARENT, "Start part 1", null, "forgejo push by alex"],
      ["repository_check_runs", 7, HEAD, "Finish part 1 #submit", null, "forgejo push by alex"]
    ]
  );
});

Deno.test("handleForgejoPush writes nothing for a repository that exists only on GitHub", async () => {
  const { client, inserts } = fakeSupabase(tables("github"));
  await handleForgejoPush(client, fromForgejoPush(forgejoPayload()), new Sentry.Scope());
  assertEquals(inserts, []);
});

Deno.test("handleForgejoPush writes nothing for a push to another branch or a pr-mode assignment", async () => {
  const other = fakeSupabase(tables());
  await handleForgejoPush(
    other.client,
    { ...fromForgejoPush(forgejoPayload()), ref: "refs/heads/scratch" },
    new Sentry.Scope()
  );
  assertEquals(other.inserts, []);

  const t = tables();
  t.assignments[0].submission_mode = "pr";
  const prMode = fakeSupabase(t);
  await handleForgejoPush(prMode.client, fromForgejoPush(forgejoPayload()), new Sentry.Scope());
  assertEquals(prMode.inserts, []);
});

/** Runs `fn` with `console[method]` captured, and returns what it printed. */
async function captureConsole(method: "warn" | "error", fn: () => Promise<void>): Promise<string[]> {
  const original = console[method];
  const lines: string[] = [];
  console[method] = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return lines;
}

const recordedShas = (inserts: { row: Record<string, unknown> }[]) => inserts.map(({ row }) => row.sha);

Deno.test("handleForgejoPush records the head commit when the payload lists no commits", async () => {
  // What Forgejo sends with webhook.PAYLOAD_COMMIT_LIMIT = 0: no commits, but head_commit and the total.
  const { client, inserts } = fakeSupabase(tables());
  const push = fromForgejoPush({ ...forgejoPayload(), commits: [] });
  await captureConsole("warn", () => handleForgejoPush(client, push, new Sentry.Scope()));
  assertEquals(recordedShas(inserts), [HEAD]);
  assertEquals((inserts[0].row as { commit_message: string }).commit_message, "Finish part 1 #submit");
});

Deno.test("handleForgejoPush records a truncated payload's commits and warns with both counts", async () => {
  // A 16-commit push under Forgejo's default limit of 15 lists only the newest; here it lists one.
  const payload = forgejoPayload();
  payload.commits = payload.commits!.slice(0, 1);
  payload.total_commits = 16;
  const { client, inserts } = fakeSupabase(tables());
  const warnings = await captureConsole("warn", () =>
    handleForgejoPush(client, fromForgejoPush(payload), new Sentry.Scope())
  );
  assertEquals(recordedShas(inserts), [HEAD]);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("cs101/hw1-alex"), warnings[0]);
  assert(warnings[0].includes("has 16 commits") && warnings[0].includes("lists 1"), warnings[0]);

  // A complete payload doesn't warn.
  const complete = fakeSupabase(tables());
  const none = await captureConsole("warn", () =>
    handleForgejoPush(complete.client, fromForgejoPush(forgejoPayload()), new Sentry.Scope())
  );
  assertEquals(none, []);
});

/** A push to `fullName`, which Forgejo reports with the repository's current casing. */
function pushTo(fullName: string): RepoPush {
  const payload = forgejoPayload();
  payload.repository.full_name = fullName;
  return fromForgejoPush(payload);
}

Deno.test("handleForgejoPush matches the owner and repository name ignoring case", async () => {
  const { client, inserts } = fakeSupabase(tables());
  await handleForgejoPush(client, pushTo("CS101/HW1-Alex"), new Sentry.Scope());
  assertEquals(
    inserts.map(({ row }) => row.repository_id),
    [7, 7]
  );
});

Deno.test("handleForgejoPush treats _ in a name literally, not as a wildcard", async () => {
  // Unescaped, `hw1_alex` would match the stored `hw1-alex`.
  const dash = fakeSupabase(tables());
  await handleForgejoPush(dash.client, pushTo("cs101/hw1_alex"), new Sentry.Scope());
  assertEquals(dash.inserts, []);

  const t = tables();
  t.repositories[0] = repositoryRow({ id: 7, repository: "cs101/hw1_alex", git_provider: "forgejo" });
  const underscore = fakeSupabase(t);
  await handleForgejoPush(underscore.client, pushTo("CS101/HW1_Alex"), new Sentry.Scope());
  assertEquals(underscore.inserts.length, 2);
});

Deno.test("handleForgejoPush refuses a name that matches more than one Forgejo row ignoring case", async () => {
  const t = tables();
  t.repositories.push(repositoryRow({ id: 8, repository: "cs101/HW1-alex", git_provider: "forgejo" }));
  const { client, inserts } = fakeSupabase(t);
  const errors = await captureConsole("error", () =>
    handleForgejoPush(client, fromForgejoPush(forgejoPayload()), new Sentry.Scope())
  );
  assertEquals(inserts, []);
  assert(
    errors.some((line) => line.includes("cs101/hw1-alex matches more than one Forgejo repository")),
    errors.join("\n")
  );
});
