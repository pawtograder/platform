/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { TZDate } from "@date-fns/tz";

function handler(file: string, name = "handleRequest", context: object) {
  const path = `supabase/functions/${file}/index.ts`;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return runInNewContext(`${ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 })}\n${name}`, context);
}
// Execute actual function bodies with database/GitHub mocks, no copied filtering logic.
test.each(["github-user-sync", "autograder-create-repos-for-student"])(
  "%s isolates mixed-provider repos",
  async (file) => {
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
          classes: { slug: "course", github_org: "org", time_zone: "UTC" },
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
          const result = { data: table === "repositories" ? [repo("github", "group")] : data, error: null };
          const query: Record<string, unknown> = {
            then: (resolve: (value: unknown) => void) => resolve(result),
            insert
          };
          for (const method of ["select", "eq", "in", "is", "not", "lte", "limit", "update", "single"]) {
            query[method] = () => query;
          }
          query.eq = (column: string) => {
            if (column === "classes.assignments.git_provider" && mode === "forgejo-only") result.data = [];
            return query;
          };
          return query;
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
        REQUEST_SCOPED_AUTH_OPTIONS: {},
        TZDate,
        syncRepoPermissions,
        Deno: { env: { get: () => "test" } },
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
  }
);

test.each(["repositories", "autograder", "assignments"])("push routing respects %s providers", async (table) => {
  const text = readFileSync("supabase/functions/github-repo-webhook/index.ts", "utf8");
  const source = ts.createSourceFile("webhook.ts", text, ts.ScriptTarget.Latest);
  const handler = source.statements.find((node) => node.getText(source).startsWith('eventHandler.on("push",'))!;
  for (const provider of ["github", "forgejo"]) {
    const dispatch = jest.fn();
    const row = { id: 1, git_provider: provider, assignments: { git_provider: provider } };
    const client = {
      from: (name: string) => {
        let rows = name === table ? [row] : [];
        let single = false;
        const query = {
          select: () => query,
          eq: (column: string, value: string) => {
            if (column === "git_provider") rows = rows.filter((r) => r.git_provider === value);
            if (column === "assignments.git_provider") rows = rows.filter((r) => r.assignments.git_provider === value);
            return query;
          },
          maybeSingle: () => {
            single = true;
            return query;
          },
          then: (resolve: (result: unknown) => void) =>
            resolve({ data: single ? (rows[0] ?? null) : rows, error: null })
        };
        return query;
      }
    };
    let invoke: (event: unknown) => Promise<void> = async () => {};
    runInNewContext(ts.transpile(handler.getText(source), { target: ts.ScriptTarget.ES2022 }), {
      eventHandler: {
        on: (_: string, fn: typeof invoke) => {
          invoke = fn;
        }
      },
      createClient: () => client,
      REQUEST_SCOPED_AUTH_OPTIONS: {},
      Deno: { env: { get: () => "test" } },
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
    let row: unknown = { git_provider: provider, profile_id: "student", assignment_group_id: null };
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === "git_provider" && provider !== value) row = null;
        return query;
      },
      maybeSingle: async () => ({ data: row, error: null })
    };
    const listCommits = jest.fn(async () => ({ commits: [{ sha: "private-github-history" }], has_more: false }));
    const invoke = handler("repository-list-commits", "handleRequest", {
      listCommits,
      SecurityError: Error,
      assertUserIsInCourse: async () => ({
        supabase: { from: () => query },
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

test("Forgejo group moves reject before any membership writes", async () => {
  const write = jest.fn();
  const query = {
    select: () => query,
    in: () => query,
    eq: () => query,
    delete: write,
    insert: write,
    then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: 1 }], error: null })
  };
  const invoke = handler("assignment-group-instructor-move-student", "handleAssignmentGroupInstructorMoveStudent", {
    createClient: () => ({ from: () => query }),
    REQUEST_SCOPED_AUTH_OPTIONS: {},
    Deno: { env: { get: () => "test" } },
    IllegalArgumentError: Error,
    assertUserIsInstructor: async () => ({ supabase: { from: () => query }, enrollment: {} })
  });
  await expect(
    invoke({
      headers: new Map(),
      json: async () => ({ old_assignment_group_id: 1, new_assignment_group_id: 2, profile_id: "student", class_id: 1 })
    })
  ).rejects.toThrow("Forgejo");
  expect(write).not.toHaveBeenCalled();
});
