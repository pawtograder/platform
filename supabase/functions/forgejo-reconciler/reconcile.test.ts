/**
 * The reconcile pass for #1092, against a fake Supabase client and a stubbed account step.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net forgejo-reconciler/
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoUser } from "../_shared/ForgejoWrapper.ts";
import {
  MAX_ACCOUNTS_PER_PASS,
  MAX_REVOCATIONS_PER_PASS,
  reconcileForgejoAccounts,
  revokeDroppedTokens,
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

const claimStamp = (id: number) => `2026-11-17T06:00:0${id}.000000+00:00`;

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
      return Promise.resolve({ data: claimable.has(id) ? claimStamp(id) : null, error: null });
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
    const result = await revokeDroppedTokens(client, config, (_cfg, login, repositoryId) => {
      revoked.push([login, repositoryId]);
      return Promise.resolve(1);
    });
    assertEquals(result, { revoked: 2, failures: [] });
    assertEquals(revoked, [
      ["alex.kim", 42],
      ["sam.lee", 43]
    ]);
    assertEquals(rpcCalls[1], {
      name: "claim_forgejo_repo_token_revocation",
      args: { p_id: 1, p_stale_minutes: STALE_CLAIM_MINUTES }
    });
    assertEquals(deleted[0], [
      ["eq", "id", 1],
      ["eq", "revoke_claimed_at", claimStamp(1)]
    ]);
    assertEquals(deleted[1], [
      ["eq", "id", 2],
      ["eq", "revoke_claimed_at", claimStamp(2)]
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
