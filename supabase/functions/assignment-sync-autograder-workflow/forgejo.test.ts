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

function stubRepo(files: Record<string, string>) {
  const changes: { changes: ForgejoFileChange[]; message: string }[] = [];
  const ops: ForgejoWorkflowOps = {
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
    liveWorkflow: "custom"
  });
  assertEquals(changes, []);
});

Deno.test("enable: the parked copy is renamed back, keeping the instructor's edits", async () => {
  const { ops, changes } = stubRepo({ [PARKED]: "custom" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, true, server, ops), {
    commitSha: "c0ffee",
    liveWorkflow: "custom"
  });
  assertEquals(changes[0].changes, [
    { operation: "update", path: LIVE, fromPath: PARKED, sha: `sha-of-${PARKED}`, content: "custom" }
  ]);
});

Deno.test("enable: with no workflow at all, the stock Forgejo workflow is added", async () => {
  const { ops, changes } = stubRepo({});
  const result = await syncForgejoGradeWorkflow(config, repo, true, server, ops);
  assertEquals(result, { commitSha: "c0ffee", liveWorkflow: forgejoGradeWorkflow(server) });
  assertEquals(changes[0].changes, [{ operation: "create", path: LIVE, content: forgejoGradeWorkflow(server) }]);
});

Deno.test("disable: grade.yml is renamed to grade.yml.disabled in one commit", async () => {
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  assertEquals(await syncForgejoGradeWorkflow(config, repo, false, server, ops), {
    commitSha: "c0ffee",
    liveWorkflow: null
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
    liveWorkflow: null
  });
  assertEquals(changes, []);
});

type Sharer = { id: number; has_autograder: boolean | null; submission_mode: string | null; repo_mode: string };

/** Records each write as table, values and the filters applied to it. */
function fakeSupabase(sharers: Sharer[]) {
  const writes: { table: string; values: Record<string, unknown>; filters: string[] }[] = [];
  const reads: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          reads.push(`${table}: ${columns}`);
          const chain = {
            eq: (column: string, value: unknown) => (reads.push(`eq ${column} ${value}`), chain),
            neq: (column: string, value: unknown) => {
              reads.push(`neq ${column} ${value}`);
              return Promise.resolve({ data: sharers, error: null });
            }
          };
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

const assignment = { id: 7, class_id: 3, template_repo: repo, forgejo_org: null, class_slug: "CS4535" };

Deno.test("sync: enabling writes the workflow, pins the new head and sets the hash from what was written", async () => {
  const { client, writes } = fakeSupabase([{ id: 8, has_autograder: true, submission_mode: "push", repo_mode: "x" }]);
  const { ops } = stubRepo({});
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result, { action: "added", has_autograder: true, template_repo: repo });
  assertEquals(writes, [
    {
      table: "assignments",
      values: { latest_template_sha: "c0ffee" },
      filters: ["in id 7,8", `eq template_repo ${repo}`]
    },
    {
      table: "autograder",
      values: { workflow_sha: await sha256Hex(forgejoGradeWorkflow(server)) },
      filters: ["in id 7,8"]
    }
  ]);
});

Deno.test("sync: an already live grade.yml only fills an unset hash", async () => {
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

Deno.test("sync: disabling parks the workflow and leaves the hash", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({ [LIVE]: "custom" });
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, false, server, ops);
  assertEquals(result, { action: "removed", has_autograder: false, template_repo: repo });
  assertEquals(
    writes.map((w) => w.table),
    ["assignments"]
  );
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
  await syncForgejoAssignmentWorkflow(fakeSupabase([]).client, config, inOrg, true, server, shared.ops);
});

Deno.test("sync: another assignment on the handout with the other setting is refused", async () => {
  const { client } = fakeSupabase([
    { id: 8, has_autograder: true, submission_mode: "push", repo_mode: "template_only_staff" }
  ]);
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
