/**
 * The reconcile pass for #1092, against a fake Supabase client and a stubbed account step.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net forgejo-reconciler/
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoUser } from "../_shared/ForgejoWrapper.ts";
import { MAX_ACCOUNTS_PER_PASS, reconcileForgejoAccounts, STALE_CLAIM_MINUTES } from "./reconcile.ts";

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
