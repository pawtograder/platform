/**
 * A staff member's Test Assignment repo on a Forgejo assignment. Forgejo steps are stubbed; Supabase is a fake
 * answering each table with a fixed row.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net forgejo-reconciler/testRepo.test.ts
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig } from "../_shared/ForgejoWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { RepoOps } from "./reconcile.ts";
import { createForgejoTestRepo, type ForgejoTestAssignment } from "./testRepo.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };

const assignment: ForgejoTestAssignment = {
  id: 9,
  class_id: 3,
  slug: "HW1",
  template_repo: "cs4535/cs4535-handout-hw1",
  repo_mode: "template_only_staff",
  classes: { slug: "CS4535", forgejo_org: null }
};

type Rows = { role?: { private_profile_id: string } | null; account?: { login: string } | null };

function fakeSupabase(rows: Rows) {
  const filters: Record<string, string[]> = {};
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const chain = (table: string, result: () => unknown) => {
    const q: Record<string, unknown> = {};
    const record =
      (op: string) =>
      (...args: unknown[]) => {
        (filters[table] ??= []).push(`${op} ${args.join(" ")}`);
        return q;
      };
    for (const op of ["select", "eq", "not", "limit"]) q[op] = record(op);
    q.maybeSingle = () => Promise.resolve({ data: result(), error: null });
    return q;
  };
  const client = {
    from(table: string) {
      if (table === "user_roles") return chain(table, () => rows.role ?? null);
      if (table === "git_accounts") return chain(table, () => rows.account ?? null);
      // repositories: no row yet, so one is reserved, then marked ready.
      const lookup = chain(table, () => null);
      return {
        ...lookup,
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: 41 }, error: null }) }) };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (_column: string, id: unknown) => {
            updated.push({ ...values, id });
            return Promise.resolve({ error: null });
          }
        })
      };
    }
  } as unknown as Parameters<typeof createForgejoTestRepo>[0];
  return { client, filters, inserted, updated };
}

function stubOps(write = true) {
  const calls: string[] = [];
  const ops: RepoOps = {
    ensureOrg: (_cfg, org) => (calls.push(`org ${org}`), Promise.resolve()),
    ensureRepoFromTemplate: (_cfg, template, owner, name) => (
      calls.push(`generate ${template} -> ${owner}/${name}`), Promise.resolve()
    ),
    grantWrite: (_cfg, repository, login) => (calls.push(`write ${repository} ${login}`), Promise.resolve(write))
  };
  return { ops, calls };
}

Deno.test(
  "test repo: made like a student's, in the class org, against the staff member's private profile",
  async () => {
    const { client, filters, inserted, updated } = fakeSupabase({
      role: { private_profile_id: "staff-profile" },
      account: { login: "Pat.Lee" }
    });
    const { ops, calls } = stubOps();
    const result = await createForgejoTestRepo(client, config, assignment, "user-1", ops);
    assertEquals(result, {
      is_ok: true,
      message: "Created your test repository cs4535/cs4535-hw1-pat.lee on Forgejo."
    });
    assertEquals(calls, [
      "org cs4535",
      "generate cs4535/cs4535-handout-hw1 -> cs4535/cs4535-hw1-pat.lee",
      "write cs4535/cs4535-hw1-pat.lee Pat.Lee"
    ]);
    assertEquals(inserted, [
      {
        assignment_id: 9,
        class_id: 3,
        profile_id: "staff-profile",
        assignment_group_id: null,
        repository: "cs4535/cs4535-hw1-pat.lee",
        git_provider: "forgejo",
        is_github_ready: false
      }
    ]);
    assertEquals(updated, [{ is_github_ready: true, id: 41 }]);
    // The account is the one on this instance.
    assertEquals(filters.git_accounts.includes("eq instance_url https://git.example.edu"), true);
  }
);

Deno.test("test repo: without a Forgejo account yet, staff are told to wait, and nothing is created", async () => {
  const { client } = fakeSupabase({ role: { private_profile_id: "p" }, account: null });
  const { ops, calls } = stubOps();
  const error = await assertRejects(
    () => createForgejoTestRepo(client, config, assignment, "user-1", ops),
    UserVisibleError,
    "Forgejo account isn't ready yet"
  );
  assertEquals(error.status, 409);
  assertEquals(calls, []);
});

Deno.test("test repo: someone with no role in the class is refused", async () => {
  const { client } = fakeSupabase({ role: null, account: { login: "x" } });
  const error = await assertRejects(
    () => createForgejoTestRepo(client, config, assignment, "admin-1", stubOps().ops),
    UserVisibleError
  );
  assertEquals(error.status, 403);
});

Deno.test("test repo: no handout yet, or no Forgejo settings, is refused before any lookup", async () => {
  const { client } = fakeSupabase({});
  await assertRejects(
    () => createForgejoTestRepo(client, config, { ...assignment, template_repo: null }, "u", stubOps().ops),
    UserVisibleError,
    "no Forgejo handout"
  );
  const unset = await assertRejects(
    () => createForgejoTestRepo(client, null, assignment, "u", stubOps().ops),
    UserVisibleError
  );
  assertEquals(unset.status, 503);
});

Deno.test("test repo: Forgejo not granting write access is reported as a failure", async () => {
  const { client, updated } = fakeSupabase({ role: { private_profile_id: "p" }, account: { login: "pat" } });
  await assertRejects(
    () => createForgejoTestRepo(client, config, assignment, "u", stubOps(false).ops),
    UserVisibleError,
    "doesn't report write access"
  );
  assertEquals(updated, []);
});
