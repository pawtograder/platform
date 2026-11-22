import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { deleteRepo, type ForgejoConfig, listRecentCommitShas } from "../_shared/ForgejoWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  assertForgejoRepositoriesHaveOnlyTemplateCommits,
  deleteForgejoRepositoriesSynchronously
} from "./forgejoCleanup.ts";
import type { GitHubRepoTarget } from "./repositoryCleanup.ts";

function forgejoAnswering(status: number, body: string, calls: string[] = []): ForgejoConfig {
  return {
    url: "https://git.example.edu",
    authorization: "Basic eA==",
    authSourceId: 1,
    fetch: (url, init) => {
      calls.push(`${init?.method} ${String(url).replace("https://git.example.edu/api/v1", "")}`);
      return Promise.resolve(new Response(status === 204 ? null : body, { status }));
    }
  };
}

Deno.test("listRecentCommitShas: newest first, null for a missing repo, empty for an empty one", async () => {
  const calls: string[] = [];
  assertEquals(await listRecentCommitShas(forgejoAnswering(200, '[{"sha":"b"},{"sha":"a"}]', calls), "org/r"), [
    "b",
    "a"
  ]);
  assertEquals(calls, ["GET /repos/org/r/commits?limit=100&stat=false&verification=false&files=false"]);
  assertEquals(await listRecentCommitShas(forgejoAnswering(404, "{}"), "org/r"), null);
  assertEquals(
    await listRecentCommitShas(forgejoAnswering(409, '{"message":"Git Repository is empty."}'), "org/r"),
    []
  );
  await assertRejects(() => listRecentCommitShas(forgejoAnswering(500, "{}"), "org/r"));
});

Deno.test("deleteRepo: true when deleted, false when already gone, and other failures throw", async () => {
  const calls: string[] = [];
  assertEquals(await deleteRepo(forgejoAnswering(204, "", calls), "org/r"), true);
  assertEquals(calls, ["DELETE /repos/org/r"]);
  assertEquals(await deleteRepo(forgejoAnswering(404, "{}"), "org/r"), false);
  for (const status of [403, 500]) {
    await assertRejects(() => deleteRepo(forgejoAnswering(status, "{}"), "org/r"));
  }
  // A malformed name never reaches Forgejo.
  const none: string[] = [];
  await assertRejects(() => deleteRepo(forgejoAnswering(204, "", none), "org/../other"));
  assertEquals(none, []);
});

const config = forgejoAnswering(500, "{}");
function commits(map: Record<string, string[] | null | Error>) {
  return (_config: ForgejoConfig, repository: string) => {
    const value = map[repository];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value === undefined ? null : value);
  };
}

Deno.test("Forgejo safety check: only the generated commit, or history from the handout, passes", async () => {
  const list = commits({
    "org/handout": ["h2", "h1"],
    "org/fresh": ["g1"],
    "org/empty": [],
    "org/synced": ["s3", "s2", "synced"],
    "org/same-root": ["x", "h1"]
  });
  await assertForgejoRepositoriesHaveOnlyTemplateCommits(
    config,
    [
      { repository: "org/fresh", synced_handout_sha: null },
      { repository: "org/empty", synced_handout_sha: null },
      { repository: "org/gone", synced_handout_sha: null },
      { repository: "org/synced", synced_handout_sha: "synced" },
      { repository: "org/same-root", synced_handout_sha: null },
      { repository: null, synced_handout_sha: null }
    ],
    "org/handout",
    list
  );
});

Deno.test("Forgejo safety check: a student commit refuses the delete", async () => {
  const list = commits({ "org/handout": ["h1"], "org/worked": ["student", "g1"] });
  const error = await assertRejects(
    () =>
      assertForgejoRepositoriesHaveOnlyTemplateCommits(
        config,
        [{ repository: "org/worked", synced_handout_sha: null }],
        "org/handout",
        list
      ),
    UserVisibleError
  );
  assertEquals(error.message.includes("org/worked has been modified beyond the template"), true);
});

Deno.test("Forgejo safety check: a repo or handout it can't read refuses rather than passes", async () => {
  for (const failing of ["org/handout", "org/student"]) {
    const list = commits({ "org/handout": ["h1"], "org/student": ["g1"], [failing]: new Error("500") });
    await assertRejects(
      () =>
        assertForgejoRepositoriesHaveOnlyTemplateCommits(
          config,
          [{ repository: "org/student", synced_handout_sha: null }],
          "org/handout",
          list
        ),
      UserVisibleError,
      "couldn't"
    );
  }
});

Deno.test("Forgejo safety check: nothing to check without repos or a handout", async () => {
  const list = () => Promise.reject(new Error("must not be called"));
  await assertForgejoRepositoriesHaveOnlyTemplateCommits(config, [], "org/handout", list);
  await assertForgejoRepositoriesHaveOnlyTemplateCommits(
    config,
    [{ repository: "org/a", synced_handout_sha: null }],
    null,
    list
  );
});

type Pending = { id: number; repository: string };
function fakeSupabase(pending: Pending[], opts: { unclaimable?: number[]; saveError?: boolean } = {}) {
  const log: string[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "forgejo_repo_archives");
      return {
        select() {
          let name = "";
          const chain = {
            eq(_column: string, value: string) {
              name = value;
              return chain;
            },
            is() {
              return chain;
            },
            maybeSingle() {
              log.push(`find ${name}`);
              const row = pending.find((p) => p.repository === name);
              return Promise.resolve({ data: row ? { id: row.id } : null, error: null });
            }
          };
          return chain;
        },
        update(values: Record<string, unknown>) {
          return {
            eq(_column: string, id: number) {
              log.push(`done ${id} ${Object.keys(values).join(",")}`);
              return Promise.resolve({ error: opts.saveError ? new Error("save failed") : null });
            }
          };
        }
      };
    },
    rpc(name: string, args: { p_id: number; p_stale_minutes: number }) {
      assertEquals(name, "claim_forgejo_repo_archive");
      assertEquals(args.p_stale_minutes, 10);
      log.push(`claim ${args.p_id}`);
      return Promise.resolve({ data: !(opts.unclaimable ?? []).includes(args.p_id), error: null });
    }
  };
  return { client: client as unknown as SupabaseClient<Database>, log };
}

const target = (fullName: string, kind: GitHubRepoTarget["kind"] = "student"): GitHubRepoTarget => {
  const [org, repo] = fullName.split("/");
  return { kind, org, repo, fullName };
};

Deno.test("small batch: each queued repo is claimed, deleted, then marked done", async () => {
  const { client, log } = fakeSupabase([
    { id: 1, repository: "org/a" },
    { id: 2, repository: "org/handout" }
  ]);
  const deleted: string[] = [];
  const counts = await deleteForgejoRepositoriesSynchronously(
    client,
    config,
    [target("org/A"), target("org/handout", "template")],
    (_c, name) => {
      deleted.push(name);
      return Promise.resolve(name !== "org/handout");
    }
  );
  assertEquals(counts, { deleted: 1, queued: 0, skipped: 1 });
  assertEquals(deleted, ["org/a", "org/handout"]);
  assertEquals(log, [
    "find org/a",
    "claim 1",
    "done 1 archived_at",
    "find org/handout",
    "claim 2",
    "done 2 archived_at"
  ]);
});

Deno.test("small batch: a repo the reconciler holds or already archived is left to it", async () => {
  const { client, log } = fakeSupabase([{ id: 1, repository: "org/a" }], { unclaimable: [1] });
  const remove = () => Promise.reject(new Error("must not delete"));
  const counts = await deleteForgejoRepositoriesSynchronously(
    client,
    config,
    [target("org/a"), target("org/b")],
    remove
  );
  assertEquals(counts, { deleted: 0, queued: 2, skipped: 0 });
  assertEquals(log, ["find org/a", "claim 1", "find org/b"]);
});

Deno.test("small batch: a failed delete stays queued and never throws", async () => {
  const { client, log } = fakeSupabase([{ id: 1, repository: "org/a" }]);
  const counts = await deleteForgejoRepositoriesSynchronously(client, config, [target("org/a")], () =>
    Promise.reject(new Error("Forgejo 500"))
  );
  assertEquals(counts, { deleted: 0, queued: 1, skipped: 0 });
  assertEquals(log, ["find org/a", "claim 1"]);
  const unconfigured = await deleteForgejoRepositoriesSynchronously(client, null, [target("org/a")]);
  assertEquals(unconfigured, { deleted: 0, queued: 1, skipped: 0 });
});

Deno.test("small batch: failing to mark a deleted repo done still counts it deleted", async () => {
  const { client } = fakeSupabase([{ id: 1, repository: "org/a" }], { saveError: true });
  const counts = await deleteForgejoRepositoriesSynchronously(client, config, [target("org/a")], () =>
    Promise.resolve(true)
  );
  assertEquals(counts, { deleted: 1, queued: 0, skipped: 0 });
});
