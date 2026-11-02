/**
 * The `sync_repo_to_handout` handler picks its engine by queue (build plan D3): `processEnvelope`
 * with `meta.queue_name === "handout_sync"` runs `syncRepositoryToHandoutGit`, and any other queue
 * runs `syncRepositoryToHandout`, untouched.
 *
 * Drives the real `processEnvelope` with a fake Supabase client. Each engine is identified by the
 * first thing it does that the other never does: the git path reads the repository's assignment and
 * class for the grader check (§8.3), and the REST path asks GitHub for the handout diff. The fake
 * fails the git path's read, and `fetch` is replaced with a stub that answers 404, so neither path
 * gets further than that first step and nothing leaves the process. Whether the REST path gets as
 * far as a request depends on whether another test file in the same run has set a usable App key;
 * without one it fails while signing its JWT, before any request.
 *
 * Lives here rather than beside the handler because `npm run test:functions` runs `_shared/`.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-all _shared/gitSync/handlerRouting.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";

Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { processEnvelope } = await import("../../github-async-worker/index.ts");

type Query = { table: string; ops: Array<[string, unknown[]]> };

const GIT_PATH_READ = "assignment_id, class_id";

/**
 * A Supabase client that records every query. Each builder is thenable, so any chain of filters
 * resolves. Answers: the repository row the handler reads first, one row for every guarded update,
 * an error for the git path's grader-check read, and empty results for everything else.
 */
function fakeSupabase(toSha: string) {
  const queries: Query[] = [];
  const rpcs: string[] = [];
  const answer = (q: Query) => {
    const select = q.ops.find(([op]) => op === "select")?.[1][0];
    const isUpdate = q.ops.some(([op]) => op === "update");
    if (q.table === "repositories" && !isUpdate && select === GIT_PATH_READ) {
      return { data: null, error: { message: "stop: git path reached its grader-check read" } };
    }
    if (
      q.table === "repositories" &&
      !isUpdate &&
      typeof select === "string" &&
      select.startsWith("synced_handout_sha")
    ) {
      return {
        data: {
          synced_handout_sha: null,
          synced_repo_sha: null,
          desired_handout_sha: toSha,
          sync_data: {},
          assignments: { latest_template_sha: toSha }
        },
        error: null
      };
    }
    if (isUpdate) return { data: [{ id: 1 }], error: null };
    return { data: null, error: null };
  };
  const builder = (table: string): unknown => {
    const q: Query = { table, ops: [] };
    queries.push(q);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve(answer(q));
          }
          return (...args: unknown[]) => {
            q.ops.push([String(prop), args]);
            return proxy;
          };
        }
      }
    );
    return proxy;
  };
  const rpc = (name: string) => {
    rpcs.push(name);
    return Promise.resolve({ data: null, error: null });
  };
  const client = { from: builder, rpc, schema: () => ({ from: builder, rpc }) };
  return { client, queries, rpcs };
}

async function runWithQueue(queueName: string | undefined) {
  const toSha = "1".repeat(40);
  const { client, queries } = fakeSupabase(toSha);
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    // A 404 rather than a rejection: Octokit retries a network error with backoff, and does not
    // retry a 404, so the REST path stops on its first request.
    return Promise.resolve(
      new Response(JSON.stringify({ message: "Not Found (network disabled in this test)" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    );
  }) as typeof fetch;
  try {
    await processEnvelope(
      client as unknown as Parameters<typeof processEnvelope>[0],
      {
        method: "sync_repo_to_handout",
        args: {
          repository_id: 1,
          repository_full_name: "org/student-a",
          template_repo: "org/handout",
          from_sha: null,
          to_sha: toSha,
          assignment_title: "hw"
        },
        class_id: 9,
        retry_count: 0
      },
      { msg_id: 555, enqueued_at: new Date().toISOString(), read_ct: 1, queue_name: queueName },
      new Sentry.Scope()
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  const gitPathRead = queries.some(
    (q) => q.table === "repositories" && q.ops.some(([op, args]) => op === "select" && args[0] === GIT_PATH_READ)
  );
  // The in_progress marker is the handler's last write before it calls an engine, so seeing it
  // shows the job reached the engine switch.
  const reachedEngine = queries.some((q) =>
    q.ops.some(
      ([op, args]) =>
        op === "update" && (args[0] as { sync_data?: { status?: string } })?.sync_data?.status === "in_progress"
    )
  );
  return { gitPathRead, reachedEngine, fetched };
}

Deno.test({
  name: "processEnvelope runs the git engine for a handout_sync message",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { gitPathRead, reachedEngine, fetched } = await runWithQueue("handout_sync");
    assertEquals(fetched, [], "the git path stopped before any GitHub request");
    assert(reachedEngine, "the handler reached the engine switch");
    assert(gitPathRead, "the git path's grader-check read was issued");
  }
});

for (const queue of ["async_calls", undefined]) {
  Deno.test({
    name: `processEnvelope keeps the REST engine for ${queue ?? "a message with no queue name"}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const { gitPathRead, reachedEngine, fetched } = await runWithQueue(queue);
      // Only the REST path's first call, the App's installation list, and only to the stub.
      for (const url of fetched) assertEquals(url, "https://api.github.com/app/installations");
      assert(reachedEngine, "the handler reached the engine switch");
      assertEquals(gitPathRead, false, "the git path never ran");
    }
  });
}
