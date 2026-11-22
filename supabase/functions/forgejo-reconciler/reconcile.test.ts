/**
 * The reconcile passes for accounts (#1092), repos (#1093) and group leavers (#1374), against a fake
 * Supabase client and stubbed Forgejo steps.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net forgejo-reconciler/
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoUser } from "../_shared/ForgejoWrapper.ts";
import {
  MAX_ACCOUNTS_PER_PASS,
  MAX_REPOS_PER_PASS,
  MAX_REVOCATIONS_PER_PASS,
  MAX_STAFF_TEAMS_PER_PASS,
  RECONCILE_STEPS,
  reconcileForgejo,
  reconcileForgejoAccounts,
  reconcileForgejoGroupRepos,
  reconcileForgejoRepos,
  reconcileForgejoStaffTeams,
  reconcileForgejoWorkflowHashes,
  type GroupRepoOps,
  type RepoOps,
  revokeDroppedTokens,
  type StaffTeamOps,
  revokeGroupLeavers,
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

type Due = { id: number; user_id: string; repository_id: number; login: string | null };

const claimGeneration = (id: number) => 9000 + id;

function fakeTokenSupabase(
  due: Due[],
  opts: { claimable?: Set<number>; dueError?: unknown; claimErrorFor?: number } = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: [string, ...unknown[]][][] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "forgejo_repo_tokens_to_revoke") {
        return Promise.resolve(opts.dueError ? { data: null, error: opts.dueError } : { data: due, error: null });
      }
      assertEquals(name, "claim_forgejo_repo_token_revocation");
      if (args.p_id === opts.claimErrorFor) {
        return Promise.resolve({ data: null, error: new Error("PostgREST 503") });
      }
      const claimable = opts.claimable ?? new Set(due.map((d) => d.id));
      const id = args.p_id as number;
      return Promise.resolve({ data: claimable.has(id) ? claimGeneration(id) : null, error: null });
    },
    from(table: string) {
      assertEquals(table, "forgejo_repo_tokens");
      return {
        delete() {
          const filters: [string, ...unknown[]][] = [];
          deleted.push(filters);
          const chain = {
            eq(column: string, value: unknown) {
              filters.push(["eq", column, value]);
              return chain;
            },
            not(column: string, op: string, value: unknown) {
              filters.push(["not", column, op, value]);
              return chain;
            },
            then: (done: (r: { error: null }) => void) => done({ error: null })
          };
          return chain;
        }
      };
    }
  };
  return { client: client as unknown as Parameters<typeof revokeDroppedTokens>[0], rpcCalls, deleted };
}

Deno.test("revoke: asks for this instance's dropped tokens with the stale window and pass size", async () => {
  const { client, rpcCalls } = fakeTokenSupabase([]);
  assertEquals(await revokeDroppedTokens(client, config, () => Promise.resolve(0)), { revoked: 0, failures: [] });
  assertEquals(rpcCalls[0], {
    name: "forgejo_repo_tokens_to_revoke",
    args: { p_instance_url: config.url, p_stale_minutes: STALE_CLAIM_MINUTES, p_limit: MAX_REVOCATIONS_PER_PASS }
  });
});

Deno.test(
  "revoke: claims each token, revokes it in Forgejo, then deletes the row its own claim still holds",
  async () => {
    const { client, rpcCalls, deleted } = fakeTokenSupabase([
      { id: 1, user_id: "u1", repository_id: 42, login: "alex.kim" },
      { id: 2, user_id: "u2", repository_id: 43, login: "sam.lee" }
    ]);
    const revoked: [string, number][] = [];
    const cutoffs: number[] = [];
    const start = Date.now();
    const result = await revokeDroppedTokens(client, config, (_cfg, login, repositoryId, mintedBefore) => {
      revoked.push([login, repositoryId]);
      cutoffs.push(mintedBefore!);
      return Promise.resolve(1);
    });
    assertEquals(result, { revoked: 2, failures: [] });
    assertEquals(revoked, [
      ["alex.kim", 42],
      ["sam.lee", 43]
    ]);
    // Each revoke is bounded by the time its claim was taken, so a token re-minted after the claim survives.
    for (const cutoff of cutoffs) assert(cutoff >= start && cutoff <= Date.now());
    assertEquals(rpcCalls[1], {
      name: "claim_forgejo_repo_token_revocation",
      args: { p_id: 1, p_stale_minutes: STALE_CLAIM_MINUTES }
    });
    assertEquals(deleted[0], [
      ["eq", "id", 1],
      ["eq", "revoke_claim_id", claimGeneration(1)]
    ]);
    assertEquals(deleted[1], [
      ["eq", "id", 2],
      ["eq", "revoke_claim_id", claimGeneration(2)]
    ]);
  }
);

Deno.test("revoke: a token another pass claimed, or a student who came back, is left alone", async () => {
  const { client, deleted } = fakeTokenSupabase([{ id: 1, user_id: "u1", repository_id: 42, login: "a" }], {
    claimable: new Set()
  });
  let calls = 0;
  const result = await revokeDroppedTokens(client, config, () => {
    calls++;
    return Promise.resolve(1);
  });
  assertEquals(result, { revoked: 0, failures: [] });
  assertEquals(calls, 0);
  assertEquals(deleted.length, 0);
});

Deno.test("revoke: a missing Forgejo login is reported and the cleanup record is kept", async () => {
  const { client, deleted } = fakeTokenSupabase([{ id: 5, user_id: "u5", repository_id: 42, login: null }]);
  let calls = 0;
  const result = await revokeDroppedTokens(client, config, () => {
    calls++;
    return Promise.resolve(1);
  });
  assertEquals(result.revoked, 0);
  assertEquals(
    result.failures.map((failure) => failure.userId),
    ["u5"]
  );
  assertEquals(calls, 0);
  assertEquals(deleted.length, 0);
});

Deno.test("revoke: a failed revoke keeps the row and the pass carries on", async () => {
  const { client, deleted } = fakeTokenSupabase(
    [
      { id: 1, user_id: "u1", repository_id: 42, login: "a" },
      { id: 2, user_id: "u2", repository_id: 43, login: "b" },
      { id: 3, user_id: "u3", repository_id: 44, login: "c" }
    ],
    { claimErrorFor: 3 }
  );
  const result = await revokeDroppedTokens(client, config, (_cfg, login) =>
    login === "a" ? Promise.reject(new Error("Forgejo token revoke failed: 502")) : Promise.resolve(1)
  );
  assertEquals(result.revoked, 1);
  assertEquals(
    result.failures.map((f) => f.userId),
    ["u1", "u3"]
  );
  assertEquals(deleted.length, 1);
  assertEquals(deleted[0][0], ["eq", "id", 2]);
});

Deno.test("revoke: a failed list fails the pass", async () => {
  const { client } = fakeTokenSupabase([], { dueError: new Error("PostgREST 502") });
  await assertRejects(() => revokeDroppedTokens(client, config), Error, "PostgREST 502");
});

type Leaver = {
  id: number;
  assignment_group_id: number;
  profile_id: string;
  repository: string;
  repository_id: number | null;
  login: string;
};

const leaver = (id: number, login: string, over: Partial<Leaver> = {}): Leaver => ({
  id,
  assignment_group_id: 70 + id,
  profile_id: `p${id}`,
  repository: `cs4535/cs4535-hw1-group-${id}`,
  repository_id: 500 + id,
  login,
  ...over
});

function fakeLeaverSupabase(
  due: Leaver[],
  opts: {
    claimable?: Set<number>;
    dueError?: unknown;
    claimErrorFor?: number;
    finishErrorFor?: number;
    /** repositories rows by id, as they stand NOW. Absent means the row is gone. Defaults to each row intact. */
    repoNames?: Map<number, string>;
    repoError?: unknown;
  } = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: [string, unknown][][] = [];
  const repoNames =
    opts.repoNames ??
    new Map(due.filter((d) => d.repository_id != null).map((d) => [d.repository_id as number, d.repository]));
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "forgejo_group_repo_revocations_needed") {
        return Promise.resolve(opts.dueError ? { data: null, error: opts.dueError } : { data: due, error: null });
      }
      const id = args.p_id as number;
      if (name === "claim_forgejo_group_repo_revocation") {
        if (id === opts.claimErrorFor) return Promise.resolve({ data: null, error: new Error("PostgREST 503") });
        const claimable = opts.claimable ?? new Set(due.map((d) => d.id));
        return Promise.resolve({ data: claimable.has(id) ? claimGeneration(id) : null, error: null });
      }
      assertEquals(name, "finish_forgejo_group_repo_revocation");
      if (id === opts.finishErrorFor) return Promise.resolve({ data: null, error: new Error("PostgREST 504") });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const filters: [string, unknown][] = [];
      if (table === "repositories") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return chain;
          },
          maybeSingle: () => {
            if (opts.repoError) return Promise.resolve({ data: null, error: opts.repoError });
            const id = filters.find(([c]) => c === "id")?.[1] as number;
            const repository = repoNames.get(id);
            return Promise.resolve({ data: repository === undefined ? null : { id, repository }, error: null });
          }
        };
        return chain;
      }
      assertEquals(table, "forgejo_group_repo_revocations");
      const chain: Record<string, unknown> = {
        delete: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        then: (done: (r: { error: null }) => void) => {
          deleted.push(filters);
          done({ error: null });
        }
      };
      return chain;
    }
  };
  const finishes = () => rpcCalls.filter((c) => c.name === "finish_forgejo_group_repo_revocation").map((c) => c.args);
  return { client: client as unknown as Parameters<typeof revokeGroupLeavers>[0], rpcCalls, finishes, deleted };
}

Deno.test("group leavers: asks for this instance's backlog with the stale window and pass size", async () => {
  const { client, rpcCalls } = fakeLeaverSupabase([]);
  assertEquals(await revokeGroupLeavers(client, config, () => Promise.resolve()), {
    removed: 0,
    discarded: 0,
    failures: []
  });
  assertEquals(rpcCalls[0], {
    name: "forgejo_group_repo_revocations_needed",
    args: { p_instance_url: config.url, p_stale_minutes: STALE_CLAIM_MINUTES, p_limit: MAX_REVOCATIONS_PER_PASS }
  });
});

Deno.test("group leavers: claims each row, removes the collaborator, then finishes with its own claim", async () => {
  const { client, rpcCalls, finishes } = fakeLeaverSupabase([leaver(1, "alex.kim"), leaver(2, "sam.lee")]);
  const removed: [string, string][] = [];
  const result = await revokeGroupLeavers(client, config, (_cfg, repository, login) => {
    removed.push([repository, login]);
    return Promise.resolve();
  });
  assertEquals(result, { removed: 2, discarded: 0, failures: [] });
  assertEquals(removed, [
    ["cs4535/cs4535-hw1-group-1", "alex.kim"],
    ["cs4535/cs4535-hw1-group-2", "sam.lee"]
  ]);
  assertEquals(rpcCalls[1], {
    name: "claim_forgejo_group_repo_revocation",
    args: { p_id: 1, p_stale_minutes: STALE_CLAIM_MINUTES }
  });
  // The group and profile go along, so the database can re-grant a student who rejoined meanwhile.
  assertEquals(finishes(), [
    { p_id: 1, p_claim_id: claimGeneration(1), p_assignment_group_id: 71, p_profile_id: "p1" },
    { p_id: 2, p_claim_id: claimGeneration(2), p_assignment_group_id: 72, p_profile_id: "p2" }
  ]);
});

Deno.test("group leavers: a row another pass claimed gets no Forgejo call", async () => {
  const { client, finishes } = fakeLeaverSupabase([leaver(1, "a")], { claimable: new Set() });
  let calls = 0;
  const result = await revokeGroupLeavers(client, config, () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(result, { removed: 0, discarded: 0, failures: [] });
  assertEquals(calls, 0);
  assertEquals(finishes(), []);
});

Deno.test("group leavers: a failed claim, removal or finish is recorded and the pass carries on", async () => {
  const { client, finishes } = fakeLeaverSupabase([leaver(1, "a"), leaver(2, "b"), leaver(3, "c"), leaver(4, "d")], {
    claimErrorFor: 3,
    finishErrorFor: 4
  });
  const result = await revokeGroupLeavers(client, config, (_cfg, _repository, login) =>
    login === "a" ? Promise.reject(new Error("Forgejo collaborator remove failed: 502")) : Promise.resolve()
  );
  assertEquals(result.removed, 1);
  assertEquals(
    result.failures.map((f) => [f.assignmentGroupId, f.profileId]),
    [
      [71, "p1"],
      [73, "p3"],
      [74, "p4"]
    ]
  );
  // A failed removal keeps its claim, so the row is retried once the claim is stale.
  assertEquals(
    finishes().map((f) => f.p_id),
    [2, 4]
  );
});

Deno.test("group leavers: a repo whose name was reused is dropped, never revoked", async () => {
  // The reviewer's case. Archiving renames the old repo and frees its name (#1398), so during the
  // 10-minute grace a new group can hold a repo called the same thing. Removing the student from THAT one
  // takes away access they currently have, and finish_forgejo_group_repo_revocation cannot repair it: it
  // checks membership of the group this row named, so it would mark the wrong repo not ready.
  const { client, finishes, deleted, rpcCalls } = fakeLeaverSupabase([leaver(1, "alex.kim")], {
    // Row 501 is now the replacement group's repo, under the name this revocation was queued for.
    repoNames: new Map([[501, "cs4535/cs4535-hw1-group-9"]])
  });
  let calls = 0;
  const result = await revokeGroupLeavers(client, config, () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(result, { removed: 0, discarded: 1, failures: [] });
  assertEquals(calls, 0);
  assertEquals(finishes(), []);
  // Claimed first, then deleted under that claim, so a pass that takes the row later keeps its own.
  assertEquals(rpcCalls[1].name, "claim_forgejo_group_repo_revocation");
  assertEquals(deleted, [
    [
      ["id", 1],
      ["claim_id", claimGeneration(1)]
    ]
  ]);
});

Deno.test("group leavers: a repository row that is gone is dropped too", async () => {
  // Archiving removes every collaborator before it renames, and deleting an assignment takes the row with
  // it, so there is nothing left to revoke.
  const { client, finishes, deleted } = fakeLeaverSupabase([leaver(1, "alex.kim")], { repoNames: new Map() });
  let calls = 0;
  const result = await revokeGroupLeavers(client, config, () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(result, { removed: 0, discarded: 1, failures: [] });
  assertEquals(calls, 0);
  assertEquals(finishes(), []);
  assertEquals(deleted.length, 1);
});

Deno.test("group leavers: a row queued before the identity check still runs on its name", async () => {
  // repository_id is null only for rows queued before the migration. They keep the old behaviour rather
  // than being discarded, which would throw away a real pending removal.
  const { client, finishes, deleted } = fakeLeaverSupabase([leaver(1, "alex.kim", { repository_id: null })]);
  const removed: [string, string][] = [];
  const result = await revokeGroupLeavers(client, config, (_cfg, repository, login) => {
    removed.push([repository, login]);
    return Promise.resolve();
  });
  assertEquals(result, { removed: 1, discarded: 0, failures: [] });
  assertEquals(removed, [["cs4535/cs4535-hw1-group-1", "alex.kim"]]);
  assertEquals(finishes().length, 1);
  assertEquals(deleted, []);
});

Deno.test("group leavers: a repository that cannot be read is a failure, not a discard", async () => {
  // A failed read says nothing about the repo. Discarding on it would drop the revocation for good.
  const { client, deleted } = fakeLeaverSupabase([leaver(1, "alex.kim")], { repoError: new Error("PostgREST 502") });
  let calls = 0;
  const result = await revokeGroupLeavers(client, config, () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(result.removed, 0);
  assertEquals(result.discarded, 0);
  assertEquals(result.failures.length, 1);
  assertEquals(calls, 0);
  assertEquals(deleted, []);
});

Deno.test("group leavers: a failed backlog query fails the step", async () => {
  const { client } = fakeLeaverSupabase([], { dueError: new Error("PostgREST 502") });
  await assertRejects(() => revokeGroupLeavers(client, config), Error, "PostgREST 502");
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
  > = {},
  taken: string[] = []
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const writes: { kind: "insert" | "update"; row: Record<string, unknown>; id?: unknown }[] = [];
  let nextId = 100;
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
          const conflict = taken.includes(row.repository as string);
          if (!conflict) writes.push({ kind: "insert", row });
          const id = nextId++;
          return {
            select: () => ({
              single: () =>
                Promise.resolve(
                  conflict
                    ? { data: null, error: { code: "23505", message: "duplicate" } }
                    : { data: { id }, error: null }
                )
            })
          };
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

function stubOps(overrides: Partial<GroupRepoOps> = {}) {
  const calls: string[] = [];
  const ops: GroupRepoOps = {
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
    removeCollaborator: (_cfg, repository, login) => {
      calls.push(`remove ${login} from ${repository}`);
      return Promise.resolve();
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

Deno.test("repos: claims the name, creates the repo, grants write, then marks it ready", async () => {
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
  assertEquals(writes.slice(0, 2), [
    {
      kind: "insert",
      row: {
        assignment_id: 9,
        class_id: 3,
        profile_id: "profile-a",
        assignment_group_id: null,
        repository: "cs4535/hw1-a",
        git_provider: "forgejo",
        is_github_ready: false
      }
    },
    { kind: "update", row: { is_github_ready: true }, id: 100 }
  ]);
});

Deno.test("repos: a name a group claimed first gets no Forgejo calls and no grant", async () => {
  const { client, writes } = fakeRepoSupabase([neededRepo("a")], {}, ["cs4535/hw1-a"]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoRepos(client, config, ops);
  assertEquals(calls, []);
  assertEquals(writes, []);
  assertEquals(result.failures.length, 1);
});

Deno.test("repos: a repo the student can't write to stays not ready, and the pass carries on", async () => {
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
  // Each name is claimed; only b, whose student can write, is marked ready.
  assertEquals(
    writes.filter((w) => w.kind === "insert").map((w) => w.row.repository),
    ["cs4535/hw1-a", "cs4535/hw1-b", "other/hw1-c"]
  );
  assertEquals(
    writes.filter((w) => w.kind === "update"),
    [{ kind: "update", row: { is_github_ready: true }, id: 101 }]
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
    // Recorded as "now" when the bound is the current time, so the test can compare the whole list.
    lte: (column: string, value: string) => (
      filters.push([`lte ${column}`, Math.abs(Date.parse(value) - Date.now()) < 5000 ? "now" : value]), listQuery
    ),
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
  // Only released Forgejo assignments with a handout and no hash yet.
  assertEquals(filters, [
    ["eq git_provider", "forgejo"],
    ["eq has_autograder", true],
    ["not template_repo is", null],
    ["is autograder.workflow_sha", null],
    ["lte release_date", "now"]
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

type NeededGroup = {
  assignment_id: number;
  class_id: number;
  assignment_group_id: number;
  owner: string;
  name: string;
  template_repo: string;
  logins: string[];
  all_members_have_logins: boolean;
};

const neededGroup = (id: number, logins: string[], complete = true): NeededGroup => ({
  assignment_id: 9,
  class_id: 3,
  assignment_group_id: id,
  owner: "cs4535",
  name: `hw1-group-team-${id}`,
  template_repo: "cs4535/hw1-handout",
  logins,
  all_members_have_logins: complete
});

/**
 * The backlog and save RPCs. A save with no grants is the pass claiming the name; it fails for a group
 * in `taken`. A later save reports ready unless the test says the roster changed.
 */
function fakeGroupSupabase(
  needed: NeededGroup[],
  notReady: number[] = [],
  taken: number[] = [],
  // The roster each forgejo_group_member_logins read returns, in order; the backlog's logins by default.
  rosters: Record<number, string[][]> = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const saves: Record<string, unknown>[] = [];
  const rosterReads: Record<number, number> = {};
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "forgejo_group_member_logins") {
        const id = args.p_assignment_group_id as number;
        const read = (rosterReads[id] = (rosterReads[id] ?? 0) + 1);
        const group = needed.find((g) => g.assignment_group_id === id)!;
        const roster = rosters[id]?.[Math.min(read, rosters[id].length) - 1] ?? group.logins;
        return Promise.resolve({ data: roster.map((login) => ({ login })), error: null });
      }
      if (name === "save_forgejo_group_repo") {
        saves.push(args);
        const group = needed.find((g) => g.assignment_group_id === args.p_assignment_group_id)!;
        if ((args.p_granted as string[]).length === 0) {
          const error = taken.includes(group.assignment_group_id) ? { code: "23505", message: "duplicate" } : null;
          return Promise.resolve({ data: false, error });
        }
        const ready = group.all_members_have_logins && !notReady.includes(group.assignment_group_id);
        return Promise.resolve({ data: ready, error: null });
      }
      return Promise.resolve({ data: needed, error: null });
    },
    from(table: string) {
      assertEquals(table, "repositories");
      const lookup = {
        select: () => lookup,
        eq: () => lookup,
        maybeSingle: () => Promise.resolve({ data: null, error: null })
      };
      return { select: () => lookup };
    }
  };
  return { client: client as unknown as Parameters<typeof reconcileForgejoGroupRepos>[0], rpcCalls, saves };
}

Deno.test("group repos: one repo per group, every member a writer, saved through the database", async () => {
  const { client, rpcCalls, saves } = fakeGroupSupabase([neededGroup(5, ["a", "b"])]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(rpcCalls[0], {
    name: "forgejo_group_repos_needed",
    args: { p_instance_url: config.url, p_limit: MAX_REPOS_PER_PASS }
  });
  assertEquals(result, { created: 1, failures: [] });
  assertEquals(calls, [
    "org cs4535",
    "repo cs4535/hw1-group-team-5 from cs4535/hw1-handout",
    "write a on cs4535/hw1-group-team-5",
    "write b on cs4535/hw1-group-team-5"
  ]);
  const save = { p_assignment_group_id: 5, p_repository: "cs4535/hw1-group-team-5", p_instance_url: config.url };
  assertEquals(saves, [
    { ...save, p_granted: [] },
    { ...save, p_granted: ["a", "b"] }
  ]);
});

Deno.test("group repos: a name another group claimed first gets no Forgejo calls and no grants", async () => {
  const { client } = fakeGroupSupabase([neededGroup(5, ["a", "b"])], [], [5]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(calls, []);
  assertEquals(result.created, 0);
  assertEquals(result.failures.length, 1);
});

Deno.test("group repos: a member who joined during the pass leaves the repo not ready, without a failure", async () => {
  const { client, saves } = fakeGroupSupabase([neededGroup(5, ["a", "b"])], [5]);
  const result = await reconcileForgejoGroupRepos(client, config, stubOps().ops);
  assertEquals(result, { created: 0, failures: [] });
  assertEquals(saves.length, 2);
});

Deno.test("group repos: a template outside the class's org is refused before any Forgejo call", async () => {
  const { client } = fakeGroupSupabase([{ ...neededGroup(1, ["a", "b"]), template_repo: "othercourse/hw1-handout" }]);
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(result.created, 0);
  assertEquals(
    result.failures.map((f) => (f.error as Error).message),
    ["The template repo isn't in the class's Forgejo org"]
  );
  assertEquals(calls, []);
});

Deno.test("group repos: a member without an account yet leaves the repo not ready", async () => {
  const { client, saves } = fakeGroupSupabase([neededGroup(5, ["a"], false)]);
  const result = await reconcileForgejoGroupRepos(client, config, stubOps().ops);
  assertEquals(result, { created: 0, failures: [] });
  assertEquals(saves.length, 2);
});

Deno.test("group repos: a member Forgejo won't make a writer fails that group only", async () => {
  const { client, saves } = fakeGroupSupabase([neededGroup(5, ["a", "b"]), neededGroup(6, ["c"])]);
  const { ops } = stubOps({ grantWrite: (_cfg, _repository, login) => Promise.resolve(login !== "b") });
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(result.created, 1);
  assertEquals(
    result.failures.map((f) => [f.assignmentGroupId, (f.error as Error).message]),
    [[5, "Forgejo doesn't report write access for every group member"]]
  );
  assertEquals(
    saves.filter((u) => (u.p_granted as string[]).length > 0).map((u) => u.p_assignment_group_id),
    [6]
  );
});

Deno.test("group repos: a member who left before the row was reserved is not granted", async () => {
  // The backlog read a, b; b left before the reserve, so no revocation was queued for them.
  const { client, saves } = fakeGroupSupabase([neededGroup(5, ["a", "b"])], [], [], { 5: [["a"]] });
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(result, { created: 1, failures: [] });
  assertEquals(
    calls.filter((c) => !c.startsWith("org") && !c.startsWith("repo")),
    ["write a on cs4535/hw1-group-team-5"]
  );
  assertEquals(saves.at(-1)?.p_granted, ["a"]);
});

Deno.test("group repos: a member who left while the grants ran is removed again before the save", async () => {
  const { client, saves } = fakeGroupSupabase([neededGroup(5, ["a", "b"])], [], [], { 5: [["a", "b"], ["a"]] });
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(result, { created: 1, failures: [] });
  assertEquals(
    calls.filter((c) => !c.startsWith("org") && !c.startsWith("repo")),
    [
      "write a on cs4535/hw1-group-team-5",
      "write b on cs4535/hw1-group-team-5",
      "remove b from cs4535/hw1-group-team-5"
    ]
  );
  assertEquals(saves.at(-1)?.p_granted, ["a"]);
});

Deno.test("group repos: a failed roster read grants nobody", async () => {
  const { client: base } = fakeGroupSupabase([neededGroup(5, ["a", "b"])]);
  const client = {
    ...base,
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "forgejo_group_member_logins") return Promise.resolve({ data: null, error: new Error("boom") });
      return (base as unknown as { rpc: (n: string, a: Record<string, unknown>) => unknown }).rpc(name, args);
    }
  } as unknown as Parameters<typeof reconcileForgejoGroupRepos>[0];
  const { ops, calls } = stubOps();
  const result = await reconcileForgejoGroupRepos(client, config, ops);
  assertEquals(result.created, 0);
  assertEquals(result.failures.length, 1);
  assertEquals(
    calls.filter((c) => c.startsWith("write")),
    []
  );
});

/**
 * One repositories table for an individual and a group pass, unique on the name. Both ownership lookups
 * finish before either pass claims, as when two passes overlap; `first` decides which claim lands first.
 */
function overlappingPasses(first: "student" | "group") {
  const rows = new Map<string, string>();
  let lookups = 0;
  let bothLooked: () => void;
  const lookedUp = new Promise<void>((resolve) => (bothLooked = resolve));
  let firstClaimed: () => void;
  const claimedFirst = new Promise<void>((resolve) => (firstClaimed = resolve));
  async function claim(by: "student" | "group", repository: string) {
    if (by !== first) await claimedFirst;
    const holder = rows.get(repository);
    const error = holder && holder !== by ? { code: "23505", message: "duplicate" } : null;
    if (!error) rows.set(repository, by);
    if (by === first) firstClaimed();
    return error;
  }
  const client = (by: "student" | "group", needed: unknown[]) =>
    ({
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === "forgejo_group_member_logins") {
          return { data: (needed as NeededGroup[])[0].logins.map((login) => ({ login })), error: null };
        }
        if (name !== "save_forgejo_group_repo") return { data: needed, error: null };
        if ((args.p_granted as string[]).length === 0) {
          return { data: false, error: await claim(by, args.p_repository as string) };
        }
        return { data: true, error: null };
      },
      from() {
        const filters: Record<string, unknown> = {};
        const lookup = {
          select: () => lookup,
          eq: (column: string, value: unknown) => ((filters[column] = value), lookup),
          maybeSingle: async () => {
            if (++lookups === 2) bothLooked();
            await lookedUp;
            return { data: null, error: null };
          }
        };
        return {
          select: () => lookup,
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const error = await claim(by, row.repository as string);
                return error ? { data: null, error } : { data: { id: 1 }, error: null };
              }
            })
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) })
        };
      }
    }) as unknown as Parameters<typeof reconcileForgejoRepos>[0];
  return { client, rows };
}

for (const first of ["student", "group"] as const) {
  Deno.test(
    `a student and a group deriving the same name: when the ${first} claims first, the other makes no Forgejo calls`,
    async () => {
      // Group 5's repo is hw1-group-team-5; so is the repo of a student whose login is group-team-5.
      const { client, rows } = overlappingPasses(first);
      const student = stubOps();
      const group = stubOps();
      const [studentResult, groupResult] = await Promise.all([
        reconcileForgejoRepos(client("student", [neededRepo("group-team-5")]), config, student.ops),
        reconcileForgejoGroupRepos(client("group", [neededGroup(5, ["a", "b"])]), config, group.ops)
      ]);
      assertEquals(rows.get("cs4535/hw1-group-team-5"), first);
      const [winner, loser] = first === "student" ? [student, group] : [group, student];
      const [won, lost] = first === "student" ? [studentResult, groupResult] : [groupResult, studentResult];
      assertEquals(won.created, 1);
      assertEquals(winner.calls.filter((c) => c.startsWith("write")).length > 0, true);
      assertEquals(lost.created, 0);
      assertEquals(lost.failures.length, 1);
      assertEquals(loser.calls, []);
    }
  );
}

type StaffClass = { class_id: number; org: string; team: string; logins: string[]; repositories: string[] };

function fakeStaffSupabase(
  classes: StaffClass[],
  error: unknown = null,
  opts: { trace?: string[]; recordError?: unknown } = {}
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "record_forgejo_staff_team") {
        // Shares the ops trace when one is passed, so a test can see where the marker lands between them.
        opts.trace?.push(`record ${args.p_class_id}`);
        return Promise.resolve({ data: null, error: opts.recordError ?? null });
      }
      return Promise.resolve(error ? { data: null, error } : { data: classes, error: null });
    }
  } as unknown as Parameters<typeof reconcileForgejoStaffTeams>[0];
  return { client, rpcCalls };
}

function stubStaffOps(overrides: Partial<StaffTeamOps> = {}) {
  const calls: string[] = [];
  const ops: StaffTeamOps = {
    ensureStaffTeam: (_cfg, org, name) => {
      calls.push(`team ${org}/${name}`);
      return Promise.resolve(org === "cs4535" ? 7 : 8);
    },
    syncTeamMembers: (_cfg, teamId, logins) => {
      calls.push(`members ${teamId} ${logins.join(",")}`);
      return Promise.resolve({ added: logins.length, removed: 0 });
    },
    grantTeamRepos: (_cfg, teamId, org, repositories) => {
      calls.push(`repos ${teamId} ${org} ${repositories.join(",")}`);
      return Promise.resolve(repositories.length);
    },
    ...overrides
  };
  return { ops, calls };
}

const staffClass = (classId: number, org: string): StaffClass => ({
  class_id: classId,
  org,
  team: `${org}-staff`,
  logins: ["prof", "ta"],
  repositories: [`${org}/${org}-hw1-handout`, `${org}/${org}-hw1-alex`]
});

Deno.test("staff teams: each class's team gets its staff, then its repos", async () => {
  const { client, rpcCalls } = fakeStaffSupabase([staffClass(1, "cs4535"), staffClass(2, "cs3500")]);
  const { ops, calls } = stubStaffOps();
  const result = await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(result, { synced: 2, failures: [] });
  assertEquals(rpcCalls, [
    { name: "forgejo_staff_teams", args: { p_instance_url: config.url, p_limit: MAX_STAFF_TEAMS_PER_PASS } },
    {
      name: "record_forgejo_staff_team",
      args: {
        p_class_id: 1,
        p_instance_url: config.url,
        p_org: "cs4535",
        p_team: "cs4535-staff",
        p_team_id: 7
      }
    },
    {
      name: "record_forgejo_staff_team",
      args: {
        p_class_id: 2,
        p_instance_url: config.url,
        p_org: "cs3500",
        p_team: "cs3500-staff",
        p_team_id: 8
      }
    }
  ]);
  assertEquals(calls, [
    "team cs4535/cs4535-staff",
    "members 7 prof,ta",
    "repos 7 cs4535 cs4535/cs4535-hw1-handout,cs4535/cs4535-hw1-alex",
    "team cs3500/cs3500-staff",
    "members 8 prof,ta",
    "repos 8 cs3500 cs3500/cs3500-hw1-handout,cs3500/cs3500-hw1-alex"
  ]);
});

Deno.test("staff teams: the team is recorded as soon as it exists, before the steps that can fail", async () => {
  // The backlog lists a class only while it has live Forgejo repos, but the team outlives them: #1398
  // archives a deleted assignment's repos and leaves the team holding its grants. Without a record of the
  // team the class drops out of the backlog and a TA dropped afterwards keeps access for good. Recording
  // it before syncTeamMembers means a failure there still leaves the class in the backlog to retry.
  const trace: string[] = [];
  const { client } = fakeStaffSupabase([staffClass(1, "cs4535")], null, { trace });
  const { ops } = stubStaffOps({
    ensureStaffTeam: (_cfg, org, name) => {
      trace.push(`team ${org}/${name}`);
      return Promise.resolve(7);
    },
    syncTeamMembers: (_cfg, teamId, logins) => {
      trace.push(`members ${teamId} ${logins.join(",")}`);
      return Promise.resolve({ added: logins.length, removed: 0 });
    },
    grantTeamRepos: (_cfg, teamId, org, repositories) => {
      trace.push(`repos ${teamId} ${org} ${repositories.join(",")}`);
      return Promise.resolve(repositories.length);
    }
  });
  await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(trace, [
    "team cs4535/cs4535-staff",
    "record 1",
    "members 7 prof,ta",
    "repos 7 cs4535 cs4535/cs4535-hw1-handout,cs4535/cs4535-hw1-alex"
  ]);
});

Deno.test("staff teams: a class whose team could not be made records nothing", async () => {
  const { client, rpcCalls } = fakeStaffSupabase([staffClass(1, "cs4535")]);
  const { ops } = stubStaffOps({
    ensureStaffTeam: () => Promise.reject(new Error("Forgejo team create failed: 403"))
  });
  const result = await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(result.synced, 0);
  assertEquals(result.failures.length, 1);
  assertEquals(
    rpcCalls.map((c) => c.name),
    ["forgejo_staff_teams"]
  );
});

Deno.test("staff teams: a failed record is a failure, so the class is retried", async () => {
  // Swallowing it would leave the class unrecorded while reporting success, which is the state this whole
  // marker exists to avoid.
  const { client } = fakeStaffSupabase([staffClass(1, "cs4535")], null, {
    recordError: new Error("PostgREST 502")
  });
  const { ops, calls } = stubStaffOps();
  const result = await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(result.synced, 0);
  assertEquals(result.failures.length, 1);
  // It failed before the members sync, so nothing on Forgejo was changed past the team itself.
  assertEquals(calls, ["team cs4535/cs4535-staff"]);
});

Deno.test("staff teams: a class whose repos are all archived still syncs its members", async () => {
  // What the record buys: the backlog keeps returning the class, with no repositories to grant.
  const { client } = fakeStaffSupabase([{ ...staffClass(1, "cs4535"), repositories: [] }]);
  const { ops, calls } = stubStaffOps();
  const result = await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(result, { synced: 1, failures: [] });
  assertEquals(calls, ["team cs4535/cs4535-staff", "members 7 prof,ta", "repos 7 cs4535 "]);
});

Deno.test("staff teams: a class with no staff left empties its team", async () => {
  const { client } = fakeStaffSupabase([{ ...staffClass(1, "cs4535"), logins: [] }]);
  const { ops, calls } = stubStaffOps();
  await reconcileForgejoStaffTeams(client, config, ops);
  assert(calls.includes("members 7 "));
});

Deno.test("staff teams: a class that fails doesn't stop the others, and its repos wait for its members", async () => {
  const { client } = fakeStaffSupabase([staffClass(1, "cs4535"), staffClass(2, "cs3500")]);
  const { ops, calls } = stubStaffOps({
    syncTeamMembers: (_cfg, teamId) =>
      teamId === 7
        ? Promise.reject(new Error("Forgejo team members read failed: 500"))
        : Promise.resolve({ added: 0, removed: 0 })
  });
  const result = await reconcileForgejoStaffTeams(client, config, ops);
  assertEquals(result.synced, 1);
  assertEquals(
    result.failures.map((f) => [f.classId, (f.error as Error).message]),
    [[1, "Forgejo team members read failed: 500"]]
  );
  assert(!calls.some((c) => c.startsWith("repos 7")));
  assert(calls.some((c) => c.startsWith("repos 8")));
});

Deno.test("staff teams: a failed backlog query is an error", async () => {
  const { client } = fakeStaffSupabase([], new Error("permission denied"));
  await assertRejects(() => reconcileForgejoStaffTeams(client, config, stubStaffOps().ops), Error, "permission denied");
});

Deno.test("reconcileForgejo: a failed earlier step still runs staff-team sync and both revocations", async () => {
  const ran: string[] = [];
  const boom = new Error("repository backlog query failed");
  const step =
    (name: string, fail = false) =>
    () => {
      ran.push(name);
      return fail ? Promise.reject(boom) : Promise.resolve({} as never);
    };
  const steps = {
    reconcileForgejoAccounts: step("accounts"),
    reconcileForgejoRepos: step("repos", true),
    reconcileForgejoGroupRepos: step("groupRepos"),
    reconcileForgejoWorkflowHashes: step("hashes"),
    reconcileForgejoStaffTeams: step("staffTeams"),
    revokeGroupLeavers: step("groupLeavers"),
    revokeDroppedTokens: step("tokens")
  } as unknown as typeof RECONCILE_STEPS;
  const error = await assertRejects(() => reconcileForgejo({} as never, config, steps));
  assertEquals(error, boom);
  assertEquals(ran, ["accounts", "repos", "staffTeams", "groupLeavers", "tokens"]);
});

Deno.test("reconcileForgejo: a failed staff-team sync still runs both revocations, and is reported", async () => {
  const ran: string[] = [];
  const boom = new Error("staff backlog query failed");
  const step =
    (name: string, fail = false) =>
    () => {
      ran.push(name);
      return fail ? Promise.reject(boom) : Promise.resolve({} as never);
    };
  const steps = {
    reconcileForgejoAccounts: step("accounts"),
    reconcileForgejoRepos: step("repos"),
    reconcileForgejoGroupRepos: step("groupRepos"),
    reconcileForgejoWorkflowHashes: step("hashes"),
    reconcileForgejoStaffTeams: step("staffTeams", true),
    revokeGroupLeavers: step("groupLeavers"),
    revokeDroppedTokens: step("tokens")
  } as unknown as typeof RECONCILE_STEPS;
  const error = await assertRejects(() => reconcileForgejo({} as never, config, steps));
  assertEquals(error, boom);
  assertEquals(ran, ["accounts", "repos", "groupRepos", "hashes", "staffTeams", "groupLeavers", "tokens"]);
});
