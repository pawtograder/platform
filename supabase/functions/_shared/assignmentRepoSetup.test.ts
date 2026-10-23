/**
 * Unit tests for the staff-repository setup jobs.
 *
 * What these pin is mostly ordering, because ordering is what broke. The solution job used to
 * write autograder.grader_repo before creating the repository, so any failure after that write
 * left an assignment pointing at a repo that did not exist. Now no pointer may be written until
 * the repository exists and its config has been read, and a failure at any earlier step must
 * leave the autograder row untouched. The handout's pointer write also has to precede the
 * workflow-hash update, which matches rows by template_repo.
 *
 * GitHub calls go through the injectable `github` option and Supabase through a small fake that
 * records every write, so nothing here touches the network.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-all _shared/assignmentRepoSetup.test.ts
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";

// GitHubWrapper, which this module imports, builds a GitHub App at import time and needs a
// non-empty private key. Nothing under test authenticates. Set it before the dynamic import.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { setupHandoutRepo, setupSolutionRepo, runAssignmentRepoSetup, AssignmentSetupConfigError } = await import(
  "./assignmentRepoSetup.ts"
);
const { NonRetryableGitHubError } = await import("./GitHubWrapper.ts");

type Row = Record<string, unknown>;
type Write = { table: string; op: "update" | "upsert"; values: Row; filters: [string, unknown][] };

/** Assignment row shape the jobs read (`*, classes(slug,github_org)`). */
function assignmentRow(overrides: Row = {}): Row {
  return {
    id: 7,
    class_id: 3,
    slug: "hw1",
    title: "HW 1",
    repo_mode: "template_only_staff",
    has_autograder: true,
    source_assignment_id: null,
    template_repo: null,
    latest_template_sha: null,
    submission_mode: "push",
    protect_block_force_push: true,
    classes: { slug: "fa26", github_org: "neu-org" },
    ...overrides
  };
}

/**
 * Just enough of SupabaseClient for these jobs: chained select/update/upsert/eq, maybeSingle for
 * reads, a thenable builder for writes, and rpc for the template resolver.
 */
function fakeSupabase(opts: {
  assignment: Row | null;
  /** Other assignment rows, by id (a fork's source). */
  otherAssignments?: Record<number, Row>;
  config?: unknown;
  failUpdateOn?: string;
  /** Successive answers from claim_assignment_repo_setup; true once exhausted. */
  claims?: boolean[];
  /** What a read of assignment_repo_setup returns. */
  setupRow?: Row | null;
}) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const writes: Write[] = [];
  const log: string[] = [];
  const from = (table: string) => {
    let op: "select" | "update" | "upsert" = "select";
    let values: Row = {};
    const filters: [string, unknown][] = [];
    const builder = {
      select: () => builder,
      update: (v: Row) => {
        op = "update";
        values = v;
        return builder;
      },
      upsert: (v: Row) => {
        op = "upsert";
        values = v;
        writes.push({ table, op, values, filters });
        log.push(`upsert:${table}`);
        return Promise.resolve({ error: null });
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      maybeSingle: () => {
        if (table === "assignments") {
          const id = filters.find(([col]) => col === "id")?.[1] as number | undefined;
          const other = id !== undefined ? opts.otherAssignments?.[id] : undefined;
          const row = other ?? opts.assignment;
          const classFilter = filters.find(([col]) => col === "class_id");
          if (row && classFilter && row.class_id !== classFilter[1])
            return Promise.resolve({ data: null, error: null });
          return Promise.resolve({ data: row, error: null });
        }
        if (table === "assignment_repo_setup") return Promise.resolve({ data: opts.setupRow ?? null, error: null });
        if (table === "autograder") return Promise.resolve({ data: { config: opts.config ?? null }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (op !== "update") return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        writes.push({ table, op, values, filters });
        log.push(`update:${table}`);
        const error = opts.failUpdateOn === table ? { message: `update ${table} failed`, code: "XX000" } : null;
        return Promise.resolve({ error }).then(resolve, reject);
      }
    };
    return builder;
  };
  const rpc = (name: string, args?: unknown) => {
    log.push(`rpc:${name}`);
    rpcCalls.push({ name, args });
    if (name === "claim_assignment_repo_setup") {
      return Promise.resolve({ data: opts.claims?.length ? opts.claims.shift() : true, error: null });
    }
    if (name === "resolve_class_template_repos") {
      return Promise.resolve({
        data: [{ handout_template_repo: "tpl/handout", solution_template_repo: "tpl/solution" }],
        error: null
      });
    }
    return Promise.resolve({ data: null, error: null });
  };
  // deno-lint-ignore no-explicit-any
  return { client: { from, rpc } as any, writes, log, rpcCalls };
}

/** GitHub fakes that append to the same log as the database fake, so ordering is checkable. */
function fakeGithub(log: string[], overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const wrap =
    (name: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      log.push(`gh:${name}`);
      return Promise.resolve(overrides[name] ? overrides[name](...args) : impl(...args));
    };
  return {
    calls,
    github: {
      createRepo: wrap("createRepo", () => "head-sha-1"),
      syncRepoPermissions: wrap("syncRepoPermissions", () => ({ madeChanges: false, removalsSkipped: false })),
      getFileFromRepo: wrap("getFileFromRepo", () => ({
        content: "grader: overlay\ngradedParts: []\nsubmissionFiles:\n  files: ['src/**/*.java']\n  testFiles: []\n"
      })),
      deleteFileFromRepo: wrap("deleteFileFromRepo", () => ({ deleted: true, commit_sha: "stripped-sha" })),
      getDefaultBranchHeadSha: wrap("getDefaultBranchHeadSha", () => "handout-head"),
      updateAutograderWorkflowHash: wrap("updateAutograderWorkflowHash", () => null)
      // deno-lint-ignore no-explicit-any
    } as any
  };
}

const scope = () => new Sentry.Scope();

// ------------------------------------------------------------------------------------------------
// Solution
// ------------------------------------------------------------------------------------------------

Deno.test("solution: pointers are written once, after the repo exists and its config was read", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const result = await setupSolutionRepo({
    adminSupabase: db.client,
    assignmentId: 7,
    scope: scope(),
    github: gh.github
  });

  assertEquals(result.state, "ready");
  assertEquals(result.repo_full_name, "neu-org/fa26-solution-hw1");

  const autograderWrites = db.writes.filter((w) => w.table === "autograder");
  assertEquals(autograderWrites.length, 1, "one write, carrying every pointer together");
  const w = autograderWrites[0];
  assertEquals(w.values.grader_repo, "neu-org/fa26-solution-hw1");
  assertEquals(w.values.latest_autograder_sha, "head-sha-1");
  assertEquals((w.values.config as { grader: string }).grader, "overlay");

  const firstAutograderWrite = db.log.indexOf("update:autograder");
  assert(db.log.indexOf("gh:createRepo") < firstAutograderWrite);
  assert(db.log.indexOf("gh:getFileFromRepo") < firstAutograderWrite);
});

Deno.test("solution: the config is read at the commit being recorded, not the moving default branch", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  await setupSolutionRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github });
  const read = gh.calls.find((c) => c.name === "getFileFromRepo")!;
  assertEquals(read.args[0], "neu-org/fa26-solution-hw1");
  assertEquals(read.args[1], "pawtograder.yml");
  assertEquals(read.args[3], "head-sha-1");
});

for (const failing of ["createRepo", "syncRepoPermissions", "getFileFromRepo"]) {
  Deno.test(`solution: a ${failing} failure leaves the autograder row untouched`, async () => {
    const db = fakeSupabase({ assignment: assignmentRow() });
    const gh = fakeGithub(db.log, {
      [failing]: () => {
        throw new Error(`${failing} exploded`);
      }
    });
    await assertRejects(
      () => setupSolutionRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github }),
      Error,
      `${failing} exploded`
    );
    assertEquals(
      db.writes.filter((w) => w.table === "autograder"),
      [],
      "no grader_repo pointing at a repository that may not exist"
    );
  });
}

Deno.test("solution: a failed pointer write fails the job instead of reporting success", async () => {
  const db = fakeSupabase({ assignment: assignmentRow(), failUpdateOn: "autograder" });
  const gh = fakeGithub(db.log);
  await assertRejects(() =>
    setupSolutionRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github })
  );
});

Deno.test("solution: running twice converges on the same pointers", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const opts = { adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github };
  await setupSolutionRepo(opts);
  await setupSolutionRepo(opts);
  const [a, b] = db.writes.filter((w) => w.table === "autograder").map((w) => w.values);
  assertEquals(a, b);
});

Deno.test("solution: no-repository modes skip without touching GitHub", async () => {
  for (const repo_mode of ["none", "no_submission"]) {
    const db = fakeSupabase({ assignment: assignmentRow({ repo_mode }) });
    const gh = fakeGithub(db.log);
    const result = await setupSolutionRepo({
      adminSupabase: db.client,
      assignmentId: 7,
      scope: scope(),
      github: gh.github
    });
    assertEquals(result.state, "skipped");
    assertEquals(result.skip_reason, "no_repositories");
    assertEquals(gh.calls, []);
  }
});

Deno.test("solution: a course with no GitHub org is a non-retryable configuration error", async () => {
  const db = fakeSupabase({ assignment: assignmentRow({ classes: { slug: "fa26", github_org: null } }) });
  const gh = fakeGithub(db.log);
  const err = await assertRejects(() =>
    setupSolutionRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github })
  );
  assert(err instanceof AssignmentSetupConfigError);
  assert(err instanceof NonRetryableGitHubError, "so the worker dead-letters it without tripping the org circuit");
  assertEquals(gh.calls, []);
});

Deno.test("solution: only createRepo runs inside the per-org limiter", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const inside: string[] = [];
  await setupSolutionRepo({
    adminSupabase: db.client,
    assignmentId: 7,
    scope: scope(),
    github: gh.github,
    scheduleCreate: async (org, fn) => {
      assertEquals(org, "neu-org", "the limiter is charged to the org the repo is created in");
      const before = gh.calls.length;
      const out = await fn();
      inside.push(...gh.calls.slice(before).map((c) => c.name));
      return out;
    }
  });
  assertEquals(inside, ["createRepo"]);
});

// ------------------------------------------------------------------------------------------------
// Handout
// ------------------------------------------------------------------------------------------------

Deno.test("handout: the pointer is written after creation and before the workflow hash", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const result = await setupHandoutRepo({
    adminSupabase: db.client,
    assignmentId: 7,
    scope: scope(),
    github: gh.github
  });

  assertEquals(result.state, "ready");
  assertEquals(result.repo_full_name, "neu-org/fa26-handout-hw1");
  const pointer = db.writes.find((w) => w.table === "assignments")!;
  assertEquals(pointer.values.template_repo, "neu-org/fa26-handout-hw1");
  assertEquals(pointer.values.latest_template_sha, "handout-head");

  // updateAutograderWorkflowHash matches autograder rows by template_repo, so it must run after.
  assert(db.log.indexOf("gh:createRepo") < db.log.indexOf("update:assignments"));
  assert(db.log.indexOf("update:assignments") < db.log.indexOf("gh:updateAutograderWorkflowHash"));
  const hash = gh.calls.find((c) => c.name === "updateAutograderWorkflowHash")!;
  assertEquals(hash.args, ["neu-org/fa26-handout-hw1", "handout-head"]);
});

Deno.test("handout: a createRepo failure writes no pointer", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log, {
    createRepo: () => {
      throw new Error("GitHub took too long");
    }
  });
  await assertRejects(() =>
    setupHandoutRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github })
  );
  assertEquals(db.writes, []);
});

Deno.test("handout: a repo-only assignment strips grade.yml and records that commit", async () => {
  const db = fakeSupabase({ assignment: assignmentRow({ has_autograder: false }) });
  const gh = fakeGithub(db.log);
  await setupHandoutRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github });
  const pointer = db.writes.find((w) => w.table === "assignments")!;
  assertEquals(pointer.values.latest_template_sha, "stripped-sha");
  assertEquals(
    gh.calls.some((c) => c.name === "updateAutograderWorkflowHash"),
    false,
    "no grade.yml to hash"
  );
});

Deno.test("handout: a fork whose autograder setting differs from its source is a configuration error", async () => {
  const db = fakeSupabase({
    assignment: assignmentRow({ repo_mode: "fork_from_prior_assignment", source_assignment_id: 6 }),
    otherAssignments: {
      6: { id: 6, class_id: 3, title: "HW 0", has_autograder: false, template_repo: "neu-org/fa26-handout-hw0" }
    }
  });
  const gh = fakeGithub(db.log);
  const err = await assertRejects(() =>
    setupHandoutRepo({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github })
  );
  assert(err instanceof AssignmentSetupConfigError);
  assertEquals(gh.calls, []);
  assertEquals(db.writes, []);
});

Deno.test("handout: a fork adopts its source's handout without creating a repository", async () => {
  const db = fakeSupabase({
    assignment: assignmentRow({ repo_mode: "fork_from_prior_assignment", source_assignment_id: 6 }),
    otherAssignments: {
      6: {
        id: 6,
        class_id: 3,
        title: "HW 0",
        has_autograder: true,
        template_repo: "neu-org/fa26-handout-hw0",
        latest_template_sha: "src-sha"
      }
    }
  });
  const gh = fakeGithub(db.log);
  const result = await setupHandoutRepo({
    adminSupabase: db.client,
    assignmentId: 7,
    scope: scope(),
    github: gh.github
  });
  assertEquals(result.state, "ready");
  assertEquals(result.repo_full_name, "neu-org/fa26-handout-hw0");
  assertEquals(
    gh.calls.map((c) => c.name),
    ["updateAutograderWorkflowHash"]
  );
  const pointer = db.writes.find((w) => w.table === "assignments")!;
  assertEquals(pointer.values, { template_repo: "neu-org/fa26-handout-hw0", latest_template_sha: "src-sha" });
});

Deno.test("both: a deleted assignment is skipped, not failed", async () => {
  for (const job of [setupHandoutRepo, setupSolutionRepo]) {
    const db = fakeSupabase({ assignment: null });
    const gh = fakeGithub(db.log);
    const result = await job({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github });
    assertEquals(result.state, "skipped");
    assertEquals(result.skip_reason, "assignment_not_found");
    assertEquals(gh.calls, []);
  }
});

Deno.test("both: E2E fixtures never reach GitHub", async () => {
  const fixture = assignmentRow({ classes: { slug: "e2e-ignore-abc", github_org: "pawtograder-playground" } });
  for (const job of [setupHandoutRepo, setupSolutionRepo]) {
    const db = fakeSupabase({ assignment: fixture });
    const gh = fakeGithub(db.log);
    const result = await job({ adminSupabase: db.client, assignmentId: 7, scope: scope(), github: gh.github });
    assertEquals(result.state, "skipped");
    assertEquals(result.skip_reason, "e2e_fixture");
    assertEquals(gh.calls, []);
  }
});

// ------------------------------------------------------------------------------------------------
// The synchronous wrapper path
// ------------------------------------------------------------------------------------------------

Deno.test("wrapper: an assignment outside the authorized class is not claimed or reported on", async () => {
  // Authorized for class 99; the assignment is in class 3.
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const result = await runAssignmentRepoSetup("solution", {
    adminSupabase: db.client,
    assignmentId: 7,
    classId: 99,
    scope: scope(),
    github: gh.github
  });
  assertEquals(result.skip_reason, "assignment_not_found");
  assertEquals(db.rpcCalls, [], "no claim, no event: another course's row stays as it was");
  assertEquals(gh.calls, []);
});

Deno.test("wrapper: claims, runs, and reports success", async () => {
  const db = fakeSupabase({ assignment: assignmentRow() });
  const gh = fakeGithub(db.log);
  const result = await runAssignmentRepoSetup("solution", {
    adminSupabase: db.client,
    assignmentId: 7,
    classId: 3,
    scope: scope(),
    github: gh.github
  });
  assertEquals(result.state, "ready");
  assertEquals(db.log.indexOf("rpc:claim_assignment_repo_setup") < db.log.indexOf("gh:createRepo"), true);
  const report = db.rpcCalls.find((c) => c.name === "record_assignment_repo_setup_event");
  assertEquals((report?.args as { p_event: string }).p_event, "succeeded");
});

Deno.test("wrapper: when the worker holds the claim, it waits and returns the worker's result", async () => {
  const db = fakeSupabase({
    assignment: assignmentRow(),
    claims: [false],
    setupRow: { state: "ready", repo_full_name: "neu-org/fa26-solution-hw1" }
  });
  const gh = fakeGithub(db.log);
  const result = await runAssignmentRepoSetup("solution", {
    adminSupabase: db.client,
    assignmentId: 7,
    classId: 3,
    scope: scope(),
    github: gh.github
  });
  assertEquals(result.state, "ready");
  assertEquals(result.response.org_name, "neu-org");
  assertEquals(result.response.repo_name, "fa26-solution-hw1");
  assertEquals(gh.calls, [], "never ran createRepo alongside the worker");
});
