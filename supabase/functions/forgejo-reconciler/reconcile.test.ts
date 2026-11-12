/**
 * The reconcile passes for accounts (#1092) and repos (#1093), against a fake Supabase client and
 * stubbed Forgejo steps.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net forgejo-reconciler/
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoUser } from "../_shared/ForgejoWrapper.ts";
import {
  MAX_ACCOUNTS_PER_PASS,
  MAX_REPOS_PER_PASS,
  reconcileForgejoAccounts,
  reconcileForgejoRepos,
  reconcileForgejoWorkflowHashes,
  type RepoOps,
  STALE_CLAIM_MINUTES
} from "./reconcile.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };

type Needed = { user_id: string; email: string | null; name: string };

function fakeSupabase(
  needed: Needed[],
  opts: { claimable?: Set<string>; neededError?: unknown; claimErrorFor?: string } = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const saved: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "forgejo_accounts_needed") {
        return Promise.resolve(
          opts.neededError ? { data: null, error: opts.neededError } : { data: needed, error: null }
        );
      }
      if (args.p_user_id === opts.claimErrorFor) {
        return Promise.resolve({ data: null, error: new Error("insert violates foreign key constraint") });
      }
      const claimable = opts.claimable ?? new Set(needed.map((n) => n.user_id));
      return Promise.resolve({ data: claimable.has(args.p_user_id as string), error: null });
    },
    from(table: string) {
      assertEquals(table, "git_accounts");
      return {
        update(values: Record<string, unknown>) {
          const entry = { values, filters: [] as [string, unknown][] };
          saved.push(entry);
          const chain = {
            eq(column: string, value: unknown) {
              entry.filters.push([column, value]);
              return chain;
            },
            then: (done: (r: { error: null }) => void) => done({ error: null })
          };
          return chain;
        }
      };
    }
  };
  return { client: client as unknown as Parameters<typeof reconcileForgejoAccounts>[0], rpcCalls, saved };
}

const account = (id: number, login: string): ForgejoUser => ({ id, login, login_name: "", source_id: 3 });

Deno.test("reconcile: asks for this instance's backlog with the stale window and pass size", async () => {
  const { client, rpcCalls } = fakeSupabase([]);
  await reconcileForgejoAccounts(client, config, () => Promise.reject(new Error("no users")));
  assertEquals(rpcCalls[0], {
    name: "forgejo_accounts_needed",
    args: { p_instance_url: config.url, p_stale_minutes: STALE_CLAIM_MINUTES, p_limit: MAX_ACCOUNTS_PER_PASS }
  });
});

Deno.test("reconcile: records each claimed user's Forgejo id and login on their own row", async () => {
  const { client, saved } = fakeSupabase([
    { user_id: "u1", email: "a@x.edu", name: "A" },
    { user_id: "u2", email: "b@x.edu", name: "B" }
  ]);
  const ensured: string[] = [];
  const result = await reconcileForgejoAccounts(client, config, (_cfg, u) => {
    ensured.push(u.userId);
    return Promise.resolve(account(u.userId === "u1" ? 11 : 12, u.email.split("@")[0]));
  });
  assertEquals(result, { provisioned: 2, failures: [] });
  assertEquals(ensured, ["u1", "u2"]);
  assertEquals(saved[0], {
    values: { remote_user_id: 11, login: "a" },
    filters: [
      ["user_id", "u1"],
      ["provider", "forgejo"],
      ["instance_url", config.url]
    ]
  });
});

Deno.test("reconcile: a user another pass already claimed is left alone", async () => {
  const { client, saved } = fakeSupabase([{ user_id: "u1", email: "a@x.edu", name: "A" }], { claimable: new Set() });
  let ensured = 0;
  const result = await reconcileForgejoAccounts(client, config, () => {
    ensured++;
    return Promise.resolve(account(1, "a"));
  });
  assertEquals(result, { provisioned: 0, failures: [] });
  assertEquals(ensured, 0);
  assertEquals(saved.length, 0);
});

Deno.test("reconcile: one user's failure is recorded and the pass carries on", async () => {
  const { client, saved } = fakeSupabase([
    { user_id: "u1", email: "a@x.edu", name: "A" },
    { user_id: "u2", email: null, name: "No Email" },
    { user_id: "u3", email: "c@x.edu", name: "C" }
  ]);
  const result = await reconcileForgejoAccounts(client, config, (_cfg, u) =>
    u.userId === "u1" ? Promise.reject(new Error("e-mail already in use")) : Promise.resolve(account(13, "c"))
  );
  assertEquals(result.provisioned, 1);
  assertEquals(
    result.failures.map((f) => [f.userId, (f.error as Error).message]),
    [
      ["u1", "e-mail already in use"],
      ["u2", "user has no email, which Forgejo requires"]
    ]
  );
  assertEquals(saved.length, 1);
});

Deno.test("reconcile: a failed claim is recorded for that user and the pass carries on", async () => {
  const { client, saved } = fakeSupabase(
    [
      { user_id: "u1", email: "a@x.edu", name: "A" },
      { user_id: "u2", email: "b@x.edu", name: "B" }
    ],
    { claimErrorFor: "u1" }
  );
  const result = await reconcileForgejoAccounts(client, config, () => Promise.resolve(account(12, "b")));
  assertEquals(result.provisioned, 1);
  assertEquals(
    result.failures.map((f) => f.userId),
    ["u1"]
  );
  assertEquals(saved.length, 1);
});

Deno.test("reconcile: a failed backlog query fails the pass", async () => {
  const { client } = fakeSupabase([], { neededError: new Error("PostgREST 502") });
  await assertRejects(() => reconcileForgejoAccounts(client, config), Error, "PostgREST 502");
});

type NeededRepo = {
  assignment_id: number;
  class_id: number;
  profile_id: string;
  login: string;
  owner: string;
  name: string;
  template_repo: string;
};

const neededRepo = (login: string, owner = "cs4535"): NeededRepo => ({
  assignment_id: 9,
  class_id: 3,
  profile_id: `profile-${login}`,
  login,
  owner,
  name: `hw1-${login}`,
  template_repo: `${owner}/hw1-handout`
});

function fakeRepoSupabase(
  needed: NeededRepo[],
  existing: Record<
    string,
    { id: number; assignment_id: number; profile_id: string | null; assignment_group_id: null }
  > = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const writes: { kind: "insert" | "update"; row: Record<string, unknown>; id?: unknown }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: needed, error: null });
    },
    from(table: string) {
      assertEquals(table, "repositories");
      const filters: Record<string, unknown> = {};
      const lookup = {
        select: () => lookup,
        eq: (column: string, value: unknown) => ((filters[column] = value), lookup),
        maybeSingle: () => {
          assertEquals(filters.git_provider, "forgejo");
          return Promise.resolve({ data: existing[filters.repository as string] ?? null, error: null });
        }
      };
      return {
        select: () => lookup,
        insert(row: Record<string, unknown>) {
          writes.push({ kind: "insert", row });
          return Promise.resolve({ error: null });
        },
        update(row: Record<string, unknown>) {
          return {
            eq(_column: string, id: unknown) {
              writes.push({ kind: "update", row, id });
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    }
  };
  return { client: client as unknown as Parameters<typeof reconcileForgejoRepos>[0], rpcCalls, writes };
}

function stubOps(overrides: Partial<RepoOps> = {}) {
  const calls: string[] = [];
  const ops: RepoOps = {
    ensureOrg: (_cfg, org) => {
      calls.push(`org ${org}`);
      return Promise.resolve();
    },
    ensureRepoFromTemplate: (_cfg, template, owner, name) => {
      calls.push(`repo ${owner}/${name} from ${template}`);
      return Promise.resolve();
    },
    grantWrite: (_cfg, repository, login) => {
      calls.push(`write ${login} on ${repository}`);
      return Promise.resolve(true);
    },
    ...overrides
  };
  return { ops, calls };
}

Deno.test("repos: asks for this instance's backlog with the pass size", async () => {
  const { client, rpcCalls } = fakeRepoSupabase([]);
  await reconcileForgejoRepos(client, config, stubOps().ops);
  assertEquals(rpcCalls, [
    { name: "forgejo_repos_needed", args: { p_instance_url: config.url, p_limit: MAX_REPOS_PER_PASS } }
  ]);
});

Deno.test("repos: creates each repo, grants write, then records it as a ready Forgejo repo", async () => {
  const { client, writes } = fakeRepoSupabase([neededRepo("a"), neededRepo("b")]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoRepos(client, config, ops);
  assertEquals(result, { created: 2, failures: [] });
  // The org is checked once per pass, not once per repo.
  assertEquals(calls, [
    "org cs4535",
    "repo cs4535/hw1-a from cs4535/hw1-handout",
    "write a on cs4535/hw1-a",
    "repo cs4535/hw1-b from cs4535/hw1-handout",
    "write b on cs4535/hw1-b"
  ]);
  assertEquals(writes[0], {
    kind: "insert",
    row: {
      assignment_id: 9,
      class_id: 3,
      profile_id: "profile-a",
      assignment_group_id: null,
      repository: "cs4535/hw1-a",
      git_provider: "forgejo",
      is_github_ready: true
    }
  });
});

Deno.test("repos: a repo the student can't write to is not recorded, and the pass carries on", async () => {
  const { client, writes } = fakeRepoSupabase([neededRepo("a"), neededRepo("b"), neededRepo("c", "other")]);
  const { ops } = stubOps({
    grantWrite: (_cfg, _repository, login) => Promise.resolve(login !== "a"),
    ensureOrg: (_cfg, org) =>
      org === "other" ? Promise.reject(new Error("Forgejo org create failed: 403")) : Promise.resolve()
  });
  const result = await reconcileForgejoRepos(client, config, ops);
  assertEquals(result.created, 1);
  assertEquals(
    result.failures.map((f) => [f.profileId, (f.error as Error).message]),
    [
      ["profile-a", "Forgejo doesn't report write access for the student"],
      ["profile-c", "Forgejo org create failed: 403"]
    ]
  );
  assertEquals(
    writes.map((u) => u.row.repository),
    ["cs4535/hw1-b"]
  );
});

function fakeHashSupabase(rows: { id: number; template_repo: string }[]) {
  const assignments = rows.map((r) => ({ ...r, classes: { slug: "cs4535", forgejo_org: null } }));
  const filters: [string, unknown][] = [];
  const updates: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const listQuery = {
    select: () => listQuery,
    eq: (column: string, value: unknown) => (filters.push([`eq ${column}`, value]), listQuery),
    not: (column: string, op: string, value: unknown) => (filters.push([`not ${column} ${op}`, value]), listQuery),
    is: (column: string, value: unknown) => (filters.push([`is ${column}`, value]), listQuery),
    limit: () => Promise.resolve({ data: assignments, error: null })
  };
  const client = {
    from(table: string) {
      if (table === "assignments") return listQuery;
      assertEquals(table, "autograder");
      return {
        update(values: Record<string, unknown>) {
          const entry = { values, filters: [] as [string, unknown][] };
          updates.push(entry);
          const chain = {
            eq: (column: string, value: unknown) => (entry.filters.push([`eq ${column}`, value]), chain),
            is: (column: string, value: unknown) => (entry.filters.push([`is ${column}`, value]), chain),
            then: (done: (r: { error: null }) => void) => done({ error: null })
          };
          return chain;
        }
      };
    }
  };
  return {
    client: client as unknown as Parameters<typeof reconcileForgejoWorkflowHashes>[0],
    filters,
    updates
  };
}

Deno.test("hashes: an unset workflow hash becomes the SHA-256 of the handout's grade.yml", async () => {
  const { client, filters, updates } = fakeHashSupabase([{ id: 9, template_repo: "cs4535/hw1-handout" }]);
  const result = await reconcileForgejoWorkflowHashes(client, config, (_cfg, repository, path) => {
    assertEquals([repository, path], ["cs4535/hw1-handout", ".github/workflows/grade.yml"]);
    return Promise.resolve("abc");
  });
  assertEquals(result, { set: 1, failures: [] });
  // Only Forgejo assignments with a handout and no hash yet.
  assertEquals(filters, [
    ["eq git_provider", "forgejo"],
    ["eq has_autograder", true],
    ["not template_repo is", null],
    ["is autograder.workflow_sha", null]
  ]);
  // sha256("abc"), and only if still unset when written.
  assertEquals(updates, [
    {
      values: { workflow_sha: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      filters: [
        ["eq id", 9],
        ["is workflow_sha", null]
      ]
    }
  ]);
});

Deno.test("hashes: a handout outside the class's org is refused without reading it", async () => {
  const { client, updates } = fakeHashSupabase([{ id: 4, template_repo: "othercourse/hw1-handout" }]);
  const result = await reconcileForgejoWorkflowHashes(client, config, () => {
    throw new Error("read should not be called");
  });
  assertEquals(
    result.failures.map((f) => (f.error as Error).message),
    ["The template repo isn't in the class's Forgejo org"]
  );
  assertEquals(updates, []);
});

Deno.test(
  "hashes: an autograded handout without grade.yml is reported, and one failure doesn't stop the rest",
  async () => {
    const { client, updates } = fakeHashSupabase([
      { id: 1, template_repo: "cs4535/no-grading" },
      { id: 2, template_repo: "cs4535/broken" },
      { id: 3, template_repo: "cs4535/hw3-handout" }
    ]);
    const result = await reconcileForgejoWorkflowHashes(client, config, (_cfg, repository) =>
      repository === "cs4535/no-grading"
        ? Promise.resolve(null)
        : repository === "cs4535/broken"
          ? Promise.reject(new Error("Forgejo file read failed: 500 unrecognized response"))
          : Promise.resolve("abc")
    );
    assertEquals(result.set, 1);
    assertEquals(
      result.failures.map((f) => [f.assignmentId, (f.error as Error).message]),
      [
        [1, "The handout has no .github/workflows/grade.yml"],
        [2, "Forgejo file read failed: 500 unrecognized response"]
      ]
    );
    assertEquals(
      updates.map((u) => u.filters[0]),
      [["eq id", 3]]
    );
  }
);

Deno.test("repos: a template outside the class's org is refused before any Forgejo call", async () => {
  const { client, writes } = fakeRepoSupabase([
    { ...neededRepo("a"), template_repo: "othercourse/hw1-handout" },
    { ...neededRepo("b"), template_repo: "../admin/users" }
  ]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoRepos(client, config, ops);
  assertEquals(result.created, 0);
  assertEquals(
    result.failures.map((f) => (f.error as Error).message),
    ["The template repo isn't in the class's Forgejo org", "The template repo isn't in the class's Forgejo org"]
  );
  assertEquals(calls, []);
  assertEquals(writes, []);
});

Deno.test("repos: a row that already exists for this student is updated, not inserted again", async () => {
  const { client, writes } = fakeRepoSupabase([neededRepo("a")], {
    "cs4535/hw1-a": { id: 77, assignment_id: 9, profile_id: "profile-a", assignment_group_id: null }
  });
  const result = await reconcileForgejoRepos(client, config, stubOps().ops);
  assertEquals(result, { created: 1, failures: [] });
  assertEquals(writes, [{ kind: "update", row: { is_github_ready: true }, id: 77 }]);
});

Deno.test("repos: a name another course's student already owns is refused before any Forgejo call", async () => {
  const { client, writes } = fakeRepoSupabase([neededRepo("a")], {
    // Another class sharing the same forgejo_org, with the same assignment slug and login.
    "cs4535/hw1-a": { id: 77, assignment_id: 41, profile_id: "someone-else", assignment_group_id: null }
  });
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoRepos(client, config, ops);
  assertEquals(result.created, 0);
  assertEquals(
    result.failures.map((f) => (f.error as Error).message),
    ["The Forgejo repo name already belongs to another assignment, student or group"]
  );
  assertEquals(calls, []);
  assertEquals(writes, []);
});
