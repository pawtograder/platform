/**
 * Turning the autograder on or off for a Forgejo assignment (#1386): grade.yml in the Forgejo handout,
 * and the stored workflow hash. Forgejo's file calls are stubbed; Supabase is a fake that records writes.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net assignment-sync-autograder-workflow/
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoFileChange } from "../_shared/ForgejoWrapper.ts";
import { forgejoGradeWorkflow } from "../_shared/forgejoGradeWorkflow.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import {
  FORGEJO_DISABLED_GRADE_WORKFLOW_PATH as PARKED,
  FORGEJO_GRADE_WORKFLOW_PATH as LIVE,
  sha256Hex,
  syncForgejoAssignmentWorkflow,
  syncForgejoGradeWorkflow,
  type ForgejoWorkflowOps
} from "./forgejo.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };
const repo = "cs4535/cs4535-handout-hw1";
const server = "https://api.example.edu";

function stubRepo(files: Record<string, string>, head = "head1") {
  const changes: { changes: ForgejoFileChange[]; message: string }[] = [];
  const ops: ForgejoWorkflowOps = {
    head: (_cfg, repository, ref) => {
      assertEquals(repository, repo);
      assertEquals(ref, "main");
      return Promise.resolve({ sha: head, commit: { message: "head" } });
    },
    read: (_cfg, repository, path) => {
      assertEquals(repository, repo);
      return Promise.resolve(path in files ? { content: files[path], sha: `sha-of-${path}` } : null);
    },
    change: (_cfg, repository, list, message) => {
      assertEquals(repository, repo);
      changes.push({ changes: list, message });
      return Promise.resolve("c0ffee");
    }
  };
  return { ops, changes };
}

Deno.test("enable: a live grade.yml is kept and nothing is committed", async () => {
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, true, server, ops), {
    commitSha: null,
    liveWorkflow: "custom",
    headSha: "head1"
  });
  assertEquals(changes, []);
});

Deno.test("enable: the parked copy is renamed back, keeping the instructor's edits", async () => {
  const { ops, changes } = stubRepo({ [PARKED]: "custom" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, true, server, ops), {
    commitSha: "c0ffee",
    liveWorkflow: "custom",
    headSha: "c0ffee"
  });
  assertEquals(changes[0].changes, [
    { operation: "update", path: LIVE, fromPath: PARKED, sha: `sha-of-${PARKED}`, content: "custom" }
  ]);
});

Deno.test("enable: with no workflow at all, the stock Forgejo workflow is added", async () => {
  const { ops, changes } = stubRepo({});
  const result = await syncForgejoGradeWorkflow(config, repo, true, server, ops);
  assertEquals(result, { commitSha: "c0ffee", liveWorkflow: forgejoGradeWorkflow(server), headSha: "c0ffee" });
  assertEquals(changes[0].changes, [{ operation: "create", path: LIVE, content: forgejoGradeWorkflow(server) }]);
});

Deno.test("disable: grade.yml is renamed to grade.yml.disabled in one commit", async () => {
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, false, server, ops), {
    commitSha: "c0ffee",
    liveWorkflow: null,
    headSha: "c0ffee"
  });
  assertEquals(changes.length, 1);
  assertEquals(changes[0].changes, [
    { operation: "update", path: PARKED, fromPath: LIVE, sha: `sha-of-${LIVE}`, content: "custom" }
  ]);
});

Deno.test("disable: an older parked copy is replaced by the live one", async () => {
  const { ops, changes } = stubRepo({ [LIVE]: "new", [PARKED]: "old" });
  await syncForgejoGradeWorkflow(config, repo, false, server, ops);
  assertEquals(changes[0].changes, [
    { operation: "update", path: PARKED, sha: `sha-of-${PARKED}`, content: "new" },
    { operation: "delete", path: LIVE, sha: `sha-of-${LIVE}` }
  ]);
});

Deno.test("disable: a handout without grade.yml is left alone", async () => {
  const { ops, changes } = stubRepo({ [PARKED]: "old" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, false, server, ops), {
    commitSha: null,
    liveWorkflow: null,
    headSha: "head1"
  });
  assertEquals(changes, []);
});

type Sharer = {
  id: number;
  has_autograder: boolean | null;
  submission_mode: string | null;
  repo_mode: string;
  template_repo: string;
};

/** Records each write as table, values and the filters applied to it, and each read's filters. */
function fakeSupabase(sharers: Sharer[], repoCount = 0) {
  const writes: { table: string; values: Record<string, unknown>; filters: string[] }[] = [];
  const reads: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          reads.push(`${table}: ${columns}`);
          const result =
            table === "repositories"
              ? { data: null, count: repoCount, error: null }
              : { data: sharers, count: null, error: null };
          // Every filter is chainable and the chain is awaitable, so the call sites can apply them in
          // any order and await wherever they stop.
          const chain: Record<string, unknown> = {
            then: (done: (r: unknown) => void) => done(result)
          };
          for (const op of ["eq", "neq", "ilike", "in"]) {
            chain[op] = (column: string, value: unknown) => {
              reads.push(`${op} ${column} ${Array.isArray(value) ? value.join(",") : value}`);
              return chain;
            };
          }
          return chain;
        },
        update(values: Record<string, unknown>) {
          const entry = { table, values, filters: [] as string[] };
          writes.push(entry);
          const chain = {
            in: (column: string, ids: unknown[]) => (entry.filters.push(`in ${column} ${ids.join(",")}`), chain),
            eq: (column: string, value: unknown) => (entry.filters.push(`eq ${column} ${value}`), chain),
            is: (column: string, value: unknown) => (entry.filters.push(`is ${column} ${value}`), chain),
            then: (done: (r: { error: null }) => void) => done({ error: null })
          };
          return chain;
        }
      };
    }
  } as unknown as Parameters<typeof syncForgejoAssignmentWorkflow>[0];
  return { client, writes, reads };
}

/** Its stored revision is the handout's head, so nothing below is treated as an unfinished attempt. */
const assignment = {
  id: 7,
  class_id: 3,
  template_repo: repo,
  forgejo_org: null,
  class_slug: "CS4535",
  latest_template_sha: "head1"
};

const sharer = (over: Partial<Sharer> = {}): Sharer => ({
  id: 8,
  has_autograder: true,
  submission_mode: "push",
  repo_mode: "x",
  template_repo: repo,
  ...over
});

Deno.test("sync: enabling writes the workflow, sets the hash, then pins the new head", async () => {
  const { client, writes } = fakeSupabase([sharer()]);
  const { ops } = stubRepo({});
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result, {
    action: "added",
    has_autograder: true,
    template_repo: repo,
    existing_repositories_unchanged: 0
  });
  // The hash is written BEFORE the revision: a stale revision is what tells a retry that an earlier
  // attempt committed to the handout and did not finish.
  assertEquals(writes, [
    {
      table: "autograder",
      values: { workflow_sha: await sha256Hex(forgejoGradeWorkflow(server)) },
      filters: ["in id 7,8"]
    },
    {
      table: "assignments",
      values: { latest_template_sha: "c0ffee" },
      filters: ["in id 7,8", "eq git_provider forgejo"]
    }
  ]);
});

Deno.test("sync: the handout's other assignments are looked up on Forgejo only, case-insensitively", async () => {
  // A GitHub assignment can hold the same owner/name: repository names are unique per provider, not
  // across providers, so an unscoped lookup would hand it a Forgejo revision and workflow hash.
  const { client, reads, writes } = fakeSupabase([sharer({ id: 8, template_repo: repo.toUpperCase() })]);
  const { ops } = stubRepo({});
  await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(reads.includes("eq git_provider forgejo"), true);
  assertEquals(reads.includes(`ilike template_repo ${repo}`), true);
  // The row differs only in case, so it IS the same handout and is written with this assignment.
  assertEquals(writes[0].filters, ["in id 7,8"]);
});

Deno.test("sync: a row ilike matched on `_` but naming another repository is dropped", async () => {
  // `_` is a single-character wildcard in LIKE, so the query can return a repository that is not this
  // one; only exact (lowercased) names are kept.
  const { client, writes } = fakeSupabase([sharer({ id: 9, template_repo: "cs4535/cs4535Xhandout-hw1" })]);
  const { ops } = stubRepo({});
  await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(writes[0].filters, ["in id 7"]);
});

Deno.test("sync: an already live grade.yml on a current revision only fills an unset hash", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({ [LIVE]: "custom" });
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result.action, "unchanged");
  assertEquals(writes, [
    {
      table: "autograder",
      values: { workflow_sha: await sha256Hex("custom") },
      filters: ["in id 7", "is workflow_sha null"]
    }
  ]);
});

Deno.test("sync: a retry after a failed pin repairs the hash and the revision", async () => {
  // The previous attempt committed grade.yml and died before either write, so the handout already
  // agrees with the flag and no commit is made here. The stored revision still names the old head,
  // which is what makes the repair detectable: both writes run, and the hash is no longer conditional
  // on being unset, because what is stored is the value that attempt should have replaced.
  const { client, writes } = fakeSupabase([]);
  const { ops, changes } = stubRepo({ [LIVE]: "custom" }, "committed-head");
  const stale = { ...assignment, latest_template_sha: "old-head" };
  const result = await syncForgejoAssignmentWorkflow(client, config, stale, true, server, ops);
  assertEquals(changes, []);
  assertEquals(result.action, "unchanged");
  assertEquals(writes, [
    { table: "autograder", values: { workflow_sha: await sha256Hex("custom") }, filters: ["in id 7"] },
    {
      table: "assignments",
      values: { latest_template_sha: "committed-head" },
      filters: ["in id 7", "eq git_provider forgejo"]
    }
  ]);
});

Deno.test("sync: a handout whose head cannot be read is left pinned where it is", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({ [LIVE]: "custom" });
  ops.head = () => Promise.reject(new Error("Forgejo commit lookup failed: 404"));
  const stale = { ...assignment, latest_template_sha: "old-head" };
  await syncForgejoAssignmentWorkflow(client, config, stale, true, server, ops);
  assertEquals(
    writes.map((w) => w.table),
    ["autograder"]
  );
});

Deno.test("sync: disabling parks the workflow and leaves the hash", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({ [LIVE]: "custom" });
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, false, server, ops);
  assertEquals(result, {
    action: "removed",
    has_autograder: false,
    template_repo: repo,
    existing_repositories_unchanged: 0
  });
  assertEquals(
    writes.map((w) => w.table),
    ["assignments"]
  );
});

Deno.test("sync: student repositories the change cannot reach are counted for the instructor", async () => {
  // Forgejo has no handout sync, so these keep the grade.yml they were generated with. The caller
  // turns this into the warning the GitHub path gets when its queueing fails.
  const { client } = fakeSupabase([], 12);
  const { ops } = stubRepo({});
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result.existing_repositories_unchanged, 12);
  // An unchanged handout leaves nothing behind, so nothing is reported.
  const unchanged = fakeSupabase([], 12);
  const live = stubRepo({ [LIVE]: "custom" });
  const second = await syncForgejoAssignmentWorkflow(unchanged.client, config, assignment, true, server, live.ops);
  assertEquals(second.existing_repositories_unchanged, 0);
});

Deno.test("sync: a handout outside the class's Forgejo org is refused before any Forgejo call", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops, changes } = stubRepo({});
  const other = { ...assignment, template_repo: "othercourse/handout" };
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, other, true, server, ops),
    UserVisibleError,
    "isn't in the class's Forgejo org"
  );
  assertEquals([writes, changes], [[], []]);
  // forgejo_org wins over the slug.
  const inOrg = { ...assignment, forgejo_org: "Shared-Org", template_repo: "shared-org/h" };
  const shared = stubRepo({});
  shared.ops.read = () => Promise.resolve(null);
  shared.ops.change = () => Promise.resolve("c0ffee");
  shared.ops.head = () => Promise.resolve({ sha: "head1", commit: { message: "head" } });
  await syncForgejoAssignmentWorkflow(fakeSupabase([]).client, config, inOrg, true, server, shared.ops);
});

Deno.test("sync: another assignment on the handout with the other setting is refused", async () => {
  const { client } = fakeSupabase([sharer({ repo_mode: "template_only_staff" })]);
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, assignment, false, server, ops),
    UserVisibleError,
    "1 other assignment with a different autograder setting"
  );
  assertEquals(changes, []);
});

Deno.test("sync: a failed Forgejo commit is reported to the instructor and writes nothing", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({});
  ops.change = () => Promise.reject(new Error("Forgejo file change failed: 409 sha mismatch"));
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops),
    UserVisibleError,
    "409 sha mismatch"
  );
  assertEquals(writes, []);
});
