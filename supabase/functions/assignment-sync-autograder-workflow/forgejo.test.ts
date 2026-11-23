import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { ForgejoConfig, ForgejoFileChange } from "../_shared/ForgejoWrapper.ts";
import { forgejoGradeWorkflow, gradeWorkflowSha } from "../_shared/forgejoGradeWorkflow.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import {
  FORGEJO_DISABLED_GRADE_WORKFLOW_PATH as PARKED,
  FORGEJO_GRADE_WORKFLOW_PATH as LIVE,
  syncForgejoAssignmentWorkflow,
  syncForgejoGradeWorkflow,
  type ForgejoWorkflowOps
} from "./forgejo.ts";

const config: ForgejoConfig = { url: "https://git.example.edu", authorization: "Basic eA==", authSourceId: 3 };
const repo = "cs4535/cs4535-handout-hw1";
const server = "https://api.example.edu";

function stubRepo(files: Record<string, string>, head = "head1", headMessage = "an instructor's commit") {
  const changes: { changes: ForgejoFileChange[]; message: string }[] = [];
  const readRefs: (string | undefined)[] = [];
  const ops: ForgejoWorkflowOps = {
    head: (_cfg, repository, ref) => {
      assertEquals(repository, repo);
      assertEquals(ref, "main");
      return Promise.resolve({ sha: head, commit: { message: headMessage } });
    },
    read: (_cfg, repository, path, ref) => {
      assertEquals(repository, repo);
      readRefs.push(ref);
      return Promise.resolve(path in files ? { content: files[path], sha: `sha-of-${path}` } : null);
    },
    change: (_cfg, repository, list, message) => {
      assertEquals(repository, repo);
      changes.push({ changes: list, message });
      return Promise.resolve("c0ffee");
    }
  };
  return { ops, changes, readRefs };
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

Deno.test("the files are read at the head that is returned", async () => {
  const { ops, readRefs } = stubRepo({ [PARKED]: "custom" }, "head7");
  await syncForgejoGradeWorkflow(config, repo, true, server, ops);
  assertEquals(readRefs, ["head7", "head7"]);
  const off = stubRepo({ [LIVE]: "custom" }, "head8");
  await syncForgejoGradeWorkflow(config, repo, false, server, off.ops);
  assertEquals(off.readRefs, ["head8", "head8"]);
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
  assertEquals(result, {
    commitSha: "c0ffee",
    liveWorkflow: forgejoGradeWorkflow(server),
    headSha: "c0ffee"
  });
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

function fakeSupabase(
  sharers: Sharer[],
  repoCount = 0,
  repoCountError: { message: string } | null = null,
  failingWrite: string | null = null,
  hashes: Record<number, string | null> = {}
) {
  const writes: { table: string; values: Record<string, unknown>; filters: string[] }[] = [];
  const reads: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          reads.push(`${table}: ${columns}`);
          const result =
            table === "repositories"
              ? { data: null, count: repoCountError ? null : repoCount, error: repoCountError }
              : { data: sharers, count: null, error: null };
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
          let ids: unknown[] = [];
          const chain = {
            in: (column: string, list: unknown[]) => (
              (ids = list), entry.filters.push(`in ${column} ${list.join(",")}`), chain
            ),
            eq: (column: string, value: unknown) => (entry.filters.push(`eq ${column} ${value}`), chain),
            is: (column: string, value: unknown) => (entry.filters.push(`is ${column} ${value}`), chain),
            or: (filter: string) => (entry.filters.push(`or ${filter}`), chain),
            select: () => chain,
            then: (done: (r: { data: { id: unknown }[]; error: { message: string } | null }) => void) =>
              done({
                // Only the hash write filters on the stored value: it updates rows holding another hash.
                data: ids.filter((id) => (hashes[id as number] ?? null) !== values.workflow_sha).map((id) => ({ id })),
                error: table === failingWrite ? { message: `${table} write failed` } : null
              })
          };
          return chain;
        }
      };
    }
  } as unknown as Parameters<typeof syncForgejoAssignmentWorkflow>[0];
  return { client, writes, reads };
}

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

const ids = (list: number[]) => `in id ${list.join(",")}`;
const flagWrite = (list: number[]) => ({
  table: "assignments",
  values: { has_autograder: true },
  filters: [ids(list), "eq git_provider forgejo", "eq has_autograder false"]
});
const hashWrite = async (content: string, list: number[]) => {
  const sha = await gradeWorkflowSha(content);
  return {
    table: "autograder",
    values: { workflow_sha: sha },
    filters: [ids(list), `or workflow_sha.is.null,workflow_sha.neq.${sha}`]
  };
};
const pinWrite = (sha: string, list: number[]) => ({
  table: "assignments",
  values: { latest_template_sha: sha },
  filters: [ids(list), "eq git_provider forgejo"]
});

Deno.test("sync: enabling writes the workflow, keeps the flag on, sets the hash, then pins the new head", async () => {
  const { client, writes } = fakeSupabase([sharer()]);
  const { ops } = stubRepo({});
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result, {
    action: "added",
    has_autograder: true,
    template_repo: repo,
    existing_repositories_unchanged: 0
  });
  assertEquals(writes, [
    flagWrite([7, 8]),
    await hashWrite(forgejoGradeWorkflow(server), [7, 8]),
    pinWrite("c0ffee", [7, 8])
  ]);
});

Deno.test("sync: disabling is refused before anything is read or written", async () => {
  const { client, writes, reads } = fakeSupabase([]);
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, assignment, false, server, ops),
    UserVisibleError,
    "can't be turned off on a Forgejo assignment"
  );
  assertEquals([writes, reads, changes], [[], [], []]);
});

Deno.test("sync: the handout's other assignments are looked up on Forgejo only, case-insensitively", async () => {
  const { client, reads, writes } = fakeSupabase([sharer({ id: 8, template_repo: repo.toUpperCase() })]);
  const { ops } = stubRepo({});
  await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(reads.includes("eq git_provider forgejo"), true);
  assertEquals(reads.includes(`ilike template_repo ${repo}`), true);
  assertEquals(writes[1].filters[0], ids([7, 8]));
});

Deno.test("sync: a row ilike matched on `_` but naming another repository is dropped", async () => {
  const { client, writes } = fakeSupabase([sharer({ id: 9, template_repo: "cs4535/cs4535Xhandout-hw1" })]);
  const { ops } = stubRepo({});
  await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(writes[1].filters[0], ids([7]));
});

Deno.test("sync: a live grade.yml whose hash and revision are recorded changes nothing", async () => {
  const hash = await gradeWorkflowSha("custom");
  const { client, writes } = fakeSupabase([], 4, null, null, { 7: hash });
  const { ops, changes } = stubRepo({ [LIVE]: "custom" });
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(changes, []);
  assertEquals(result, {
    action: "unchanged",
    has_autograder: true,
    template_repo: repo,
    existing_repositories_unchanged: 0
  });
  assertEquals(writes, [flagWrite([7]), await hashWrite("custom", [7])]);
});

Deno.test("sync: a failed hash write is repaired after another handout commit lands", async () => {
  // The enable commit landed, the hash write failed (so the pin never ran), then a README push.
  const { client, writes } = fakeSupabase([], 4, null, null, { 7: await gradeWorkflowSha("parked long ago") });
  const { ops, changes } = stubRepo({ [LIVE]: "custom" }, "readme-head", "Update README");
  const stale = { ...assignment, latest_template_sha: "old-head" };
  const result = await syncForgejoAssignmentWorkflow(client, config, stale, true, server, ops);
  assertEquals(changes, []);
  assertEquals(result.action, "unchanged");
  assertEquals(result.record_error, undefined);
  assertEquals(writes, [flagWrite([7]), await hashWrite("custom", [7]), pinWrite("readme-head", [7])]);
  assertEquals(result.existing_repositories_unchanged, 4);
});

Deno.test("sync: a failed pin is repaired after another handout commit lands", async () => {
  const { client, writes } = fakeSupabase([], 4, null, null, { 7: await gradeWorkflowSha("custom") });
  const { ops } = stubRepo({ [LIVE]: "custom" }, "readme-head", "Update README");
  const stale = { ...assignment, latest_template_sha: "old-head" };
  const result = await syncForgejoAssignmentWorkflow(client, config, stale, true, server, ops);
  assertEquals(writes, [flagWrite([7]), await hashWrite("custom", [7]), pinWrite("readme-head", [7])]);
  // The hash already matched, so the earlier attempt is the one that reported these repositories.
  assertEquals(result.existing_repositories_unchanged, 0);
});

Deno.test("sync: an enable that loses a race to another enable reads again and succeeds", async () => {
  const { client, writes } = fakeSupabase([]);
  const files: Record<string, string> = {};
  const { ops } = stubRepo(files);
  let commits = 0;
  ops.change = () => {
    commits++;
    // The other request's commit landed between this request's read and its commit.
    files[LIVE] = forgejoGradeWorkflow(server);
    return Promise.reject(new Error("Forgejo file change failed: 422 file already exists"));
  };
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(commits, 1);
  assertEquals(result.action, "unchanged");
  assertEquals(writes[0], flagWrite([7]));
});

Deno.test("sync: a failed repository count fails before the handout or any row is written", async () => {
  const { client, writes } = fakeSupabase([], 0, { message: "count failed" });
  const { ops, changes } = stubRepo({});
  await assertRejects(() => syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops));
  assertEquals([writes, changes], [[], []]);
});

Deno.test("sync: a handout whose head cannot be read is left pinned where it is", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({ [LIVE]: "custom" });
  ops.head = () => Promise.reject(new Error("Forgejo commit lookup failed: 404"));
  const stale = { ...assignment, latest_template_sha: "old-head" };
  await syncForgejoAssignmentWorkflow(client, config, stale, true, server, ops);
  assertEquals(writes, [flagWrite([7]), await hashWrite("custom", [7])]);
});

Deno.test("sync: student repositories the change cannot reach are counted for the instructor", async () => {
  const { client } = fakeSupabase([], 12);
  const { ops } = stubRepo({});
  const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
  assertEquals(result.existing_repositories_unchanged, 12);
  const unchanged = fakeSupabase([], 12, null, null, { 7: await gradeWorkflowSha("custom") });
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
  const inOrg = { ...assignment, forgejo_org: "Shared-Org", template_repo: "shared-org/h" };
  const shared = stubRepo({});
  shared.ops.read = () => Promise.resolve(null);
  shared.ops.change = () => Promise.resolve("c0ffee");
  shared.ops.head = () => Promise.resolve({ sha: "head1", commit: { message: "head" } });
  await syncForgejoAssignmentWorkflow(fakeSupabase([]).client, config, inOrg, true, server, shared.ops);
});

Deno.test("sync: another assignment on the handout with the autograder off is refused", async () => {
  const { client } = fakeSupabase([sharer({ repo_mode: "template_only_staff", has_autograder: false })]);
  const { ops, changes } = stubRepo({});
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops),
    UserVisibleError,
    "1 other assignment with a different autograder setting"
  );
  assertEquals(changes, []);
});

Deno.test("sync: a Forgejo commit that fails twice is reported to the instructor and writes nothing", async () => {
  const { client, writes } = fakeSupabase([]);
  const { ops } = stubRepo({});
  let commits = 0;
  ops.change = () => (commits++, Promise.reject(new Error("Forgejo file change failed: 500 internal")));
  await assertRejects(
    () => syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops),
    UserVisibleError,
    "500 internal"
  );
  assertEquals(commits, 2);
  assertEquals(writes, []);
});

for (const table of ["autograder", "assignments"]) {
  Deno.test(`sync: a failed ${table} write after the commit is returned, not thrown`, async () => {
    const { client } = fakeSupabase([], 2, null, table);
    const { ops, changes } = stubRepo({});
    const result = await syncForgejoAssignmentWorkflow(client, config, assignment, true, server, ops);
    assertEquals(changes.length, 1);
    assertEquals(result.action, "added");
    assertEquals(result.record_error, `${table} write failed`);
    assertEquals(result.existing_repositories_unchanged, 2);
  });
}
