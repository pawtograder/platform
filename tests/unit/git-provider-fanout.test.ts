/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { TZDate } from "@date-fns/tz";

const runtime = { REQUEST_SCOPED_AUTH_OPTIONS: {}, Deno: { env: { get: () => "test" } } };

function handler(file: string, name = "handleRequest", context: object) {
  const path = `supabase/functions/${file.endsWith(".ts") ? file : `${file}/index.ts`}`;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return runInNewContext(`${ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 })}\n${name}`, context);
}
// Fluent database mock with value-sensitive provider predicates.
function query(data: unknown, overrides: object = {}) {
  const chain: Record<string, unknown> = {
    then: (done: (result: unknown) => void) => done({ data, error: null }),
    eq: (column: string, value: unknown) => {
      if (column.endsWith("git_provider") && Array.isArray(data)) {
        data = data.filter((row) => column.split(".").reduce((v, key) => v?.[key], row) === value);
      }
      return chain;
    }
  };
  chain.single = chain.maybeSingle = async () => ({
    data: Array.isArray(data) ? (data[0] ?? null) : data,
    error: null
  });
  for (const method of ["select", "in", "is", "not", "lte", "limit", "update"]) chain[method] = () => chain;
  return Object.assign(chain, overrides);
}
// Execute actual function bodies with database/GitHub mocks, no copied filtering logic.
test.each(["github-user-sync", "autograder-create-repos-for-student"])("%s scopes fan-outs", async (file) => {
  for (const mode of ["mixed", "unprovisioned", "forgejo-only"]) {
    const repo = (provider: string, kind: string) => ({
      id: `${provider}-${kind}`,
      repository: `org/${provider}-${kind}`,
      git_provider: provider,
      class_id: 1,
      assignments: { archived_at: null }
    });
    const memberships = ["github", "forgejo"].map((provider) => ({
      assignments: { id: provider, slug: provider, git_provider: provider, template_repo: "org/template" },
      assignment_groups: {
        name: provider,
        repositories: provider === "github" || mode !== "unprovisioned" ? [repo(provider, "group")] : [],
        assignment_groups_members: [{ user_roles: { users: { github_username: "student" } } }]
      }
    }));
    const classes = [
      {
        class_id: 1,
        classes: {
          slug: "course",
          github_org: "org",
          time_zone: "UTC",
          assignments: { git_provider: mode === "forgejo-only" ? "forgejo" : "github" }
        },
        profiles: {
          repositories: [repo("github", "individual"), repo("forgejo", "individual")],
          assignment_groups_members: memberships
        }
      }
    ];
    const insert = jest.fn(() => {
      throw new Error("No repository should be inserted");
    });
    const client = {
      from: (table: string) => {
        const data = table === "user_roles" ? classes : table === "users" ? { github_username: "student" } : [];
        return query(table === "repositories" ? [repo("github", "group")] : data, { insert });
      }
    };
    const reinviteToOrgTeam = jest.fn(async () => true);
    const syncRepoPermissions = jest.fn(async () => ({ madeChanges: false }));
    const name = file === "github-user-sync" ? "ensureAllReposExist" : "handleRequest";
    const invoke = handler(file, name, {
      reinviteToOrgTeam,
      UserVisibleError: Error,
      createClient: () => client,
      getAdminSupabase: () => client,
      ...runtime,
      TZDate,
      syncRepoPermissions,
      isServiceRoleRequest: () => true,
      isUserInOrg: async () => true,
      isOrgInviteWindowKnownClosed: () => false,
      sanitizeRepoNameComponent: (value: string) => value,
      Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
      console: { log: () => {} }
    });
    if (file === "github-user-sync") await invoke("user", "student");
    else await invoke({ headers: new Map(), method: "POST", json: async () => ({ user_id: "user" }) });
    expect(insert).not.toHaveBeenCalled();
    expect(reinviteToOrgTeam).toHaveBeenCalledTimes(mode !== "forgejo-only" && file === "github-user-sync" ? 1 : 0);
    expect(syncRepoPermissions.mock.calls.map((call: unknown[]) => call[1]).sort()).toEqual(
      mode === "forgejo-only" ? [] : ["course-github-group-github", "github-group", "github-individual"]
    );
  }
});

test.each(["repositories", "autograder", "assignments"])("push routing respects %s providers", async (table) => {
  const text = readFileSync("supabase/functions/github-repo-webhook/index.ts", "utf8");
  const source = ts.createSourceFile("webhook.ts", text, ts.ScriptTarget.Latest);
  const handler = source.statements.find((node) => node.getText(source).startsWith('eventHandler.on("push",'))!;
  for (const provider of ["github", "forgejo"]) {
    const dispatch = jest.fn();
    const row = { id: 1, git_provider: provider, assignments: { git_provider: provider } };
    const client = { from: (name: string) => query(name === table ? [row] : []) };
    let invoke: (event: unknown) => Promise<void> = async () => {};
    runInNewContext(ts.transpile(handler.getText(source), { target: ts.ScriptTarget.ES2022 }), {
      eventHandler: {
        on: (_: string, fn: typeof invoke) => {
          invoke = fn;
        }
      },
      createClient: () => client,
      ...runtime,
      Sentry: {
        Scope: class {
          setTag() {}
        }
      },
      console: { log() {} },
      tagScopeWithGenericPayload() {},
      maybeCrash() {},
      captureWebhookException() {},
      handlePushToStudentRepo: dispatch,
      handlePushToGraderSolution: dispatch,
      handlePushToTemplateRepo: dispatch
    });
    await invoke({ name: "push", payload: { repository: { full_name: "same/name" }, ref: "refs/heads/main" } });
    expect(dispatch).toHaveBeenCalledTimes(provider === "github" ? 1 : 0);
  }
});

test("commit history never authorizes a same-named repository on another provider", async () => {
  for (const provider of ["github", "forgejo"]) {
    const rows = [{ git_provider: provider, profile_id: "student", assignment_group_id: null }];
    const listCommits = jest.fn(async () => ({ commits: [{ sha: "private-github-history" }], has_more: false }));
    const invoke = handler("repository-list-commits", "handleRequest", {
      listCommits,
      SecurityError: Error,
      assertUserIsInCourse: async () => ({
        supabase: { from: () => query(rows) },
        enrollment: { role: "student", private_profile_id: "student" }
      }),
      console: { log() {} }
    });
    const response = invoke({
      headers: new Map(),
      json: async () => ({ course_id: 1, repo_name: "same/name", page: 1 })
    });
    if (provider === "github")
      await expect(response).resolves.toMatchObject({ commits: [{ sha: "private-github-history" }] });
    else await expect(response).rejects.toThrow("not authorized");
    expect(listCommits).toHaveBeenCalledTimes(provider === "github" ? 1 : 0);
  }
});

test.each(["github", "forgejo"])("%s group moves reach writes only for GitHub", async (provider) => {
  const rows = [{ id: 1, assignments: { git_provider: provider } }];
  const write = jest.fn(() => {
    throw new Error("membership write reached");
  });
  const client = { from: () => query(rows, { delete: write, insert: write }) };
  const invoke = handler("assignment-group-instructor-move-student", "handleAssignmentGroupInstructorMoveStudent", {
    createClient: () => client,
    ...runtime,
    IllegalArgumentError: Error,
    assertUserIsInstructor: async () => ({ supabase: client, enrollment: {} })
  });
  const response = invoke({
    headers: new Map(),
    json: async () => ({ old_assignment_group_id: 1, new_assignment_group_id: 2, profile_id: "student", class_id: 1 })
  });
  await expect(response).rejects.toThrow(provider === "forgejo" ? "Forgejo" : "membership write reached");
  expect(write).toHaveBeenCalledTimes(provider === "forgejo" ? 0 : 1);
});

test("Forgejo assignment copies reject before database writes", async () => {
  const copy = handler("cli/commands/assignments.ts", "copySingleAssignment", { CLICommandError: Error });
  await expect(copy({}, { git_provider: "forgejo" }, {}, {}, {})).rejects.toThrow("Forgejo");
});
