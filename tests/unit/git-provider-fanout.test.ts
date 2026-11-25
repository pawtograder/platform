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
  const text = fn.getText(source).replace(/^export /, "");
  return runInNewContext(`${ts.transpile(text, { target: ts.ScriptTarget.ES2022 })}\n${name}`, context);
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
    },
    // Embedded `not in` filters drop nested rows, as PostgREST does.
    not: (column: string, operator: string, value: string) => {
      const path = column.split(".");
      const field = path.pop()!;
      const key = path.pop();
      if (operator === "in" && key && Array.isArray(data)) {
        const excluded = value.slice(1, -1).split(",");
        for (const row of data) {
          const parent = path.reduce((v, k) => v?.[k], row);
          if (Array.isArray(parent?.[key]))
            parent[key] = parent[key].filter((r: Record<string, unknown>) => !excluded.includes(String(r[field])));
        }
      }
      return chain;
    },
    // Embedded `is` filters drop nested rows the same way; top-level ones are not applied.
    is: (column: string, value: unknown) => {
      const path = column.split(".");
      const field = path.pop()!;
      const key = path.pop();
      if (key && Array.isArray(data)) {
        for (const row of data) {
          const parent = path.reduce((v, k) => v?.[k], row);
          if (Array.isArray(parent?.[key]))
            parent[key] = parent[key].filter((r: Record<string, unknown>) => r[field] === value);
        }
      }
      return chain;
    }
  };
  chain.single = chain.maybeSingle = async () => ({
    data: Array.isArray(data) ? (data[0] ?? null) : data,
    error: null
  });
  for (const method of ["select", "in", "lte", "limit", "update"]) chain[method] = () => chain;
  return Object.assign(chain, overrides);
}
// Execute actual function bodies with database/GitHub mocks, no copied filtering logic.
test.each(["github-user-sync", "autograder-create-repos-for-student"])("%s scopes fan-outs", async (file) => {
  // "no-assignments" is a GitHub class before its first assignment, which must still get its org invite.
  for (const mode of ["mixed", "unprovisioned", "forgejo-only", "no-assignments"]) {
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
          assignments:
            mode === "no-assignments"
              ? []
              : [{ git_provider: mode === "forgejo-only" ? "forgejo" : "github", archived_at: null }]
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
      getGitProvider: () => ({ syncRepoPermissions }),
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

// No-repo assignments default to GitHub, so only repo-backed ones decide whether a class is GitHub.
test.each([
  ["github-user-sync", "ensureAllReposExist"],
  ["github-user-sync", "ensureStaffOrgMembership"],
  ["autograder-create-repos-for-student", "handleRequest"]
])("%s %s invites by repo-backed assignment hosts", async (file, name) => {
  const cases: [string, { git_provider: string; repo_mode: string; archived_at?: string }[], boolean][] = [
    [
      "Forgejo repo plus GitHub no-repo",
      [
        { git_provider: "forgejo", repo_mode: "template_only_staff" },
        { git_provider: "github", repo_mode: "none" }
      ],
      false
    ],
    [
      "Forgejo repo plus GitHub no-submission",
      [
        { git_provider: "forgejo", repo_mode: "template_only_staff" },
        { git_provider: "github", repo_mode: "no_submission" }
      ],
      false
    ],
    [
      "only no-repo",
      [
        { git_provider: "github", repo_mode: "none" },
        { git_provider: "github", repo_mode: "no_submission" }
      ],
      true
    ],
    [
      "GitHub repo plus Forgejo repo",
      [
        { git_provider: "github", repo_mode: "template_with_student_forks" },
        { git_provider: "forgejo", repo_mode: "template_only_staff" }
      ],
      true
    ],
    [
      "archived GitHub repo plus live Forgejo repo",
      [
        { git_provider: "github", repo_mode: "template_with_student_forks", archived_at: "2026-10-01T00:00:00Z" },
        { git_provider: "forgejo", repo_mode: "template_only_staff" }
      ],
      false
    ]
  ];
  for (const [label, assignments, invited] of cases) {
    const classes = [
      {
        class_id: 1,
        role: "instructor",
        classes: {
          slug: "course",
          github_org: "org",
          time_zone: "UTC",
          // Assignments are live unless a case archives them.
          assignments: assignments.map((a) => ({ archived_at: null, ...a }))
        },
        profiles: { repositories: [], assignment_groups_members: [] }
      }
    ];
    const client = {
      from: (table: string) =>
        query(table === "user_roles" ? classes : table === "users" ? { github_username: "student" } : [])
    };
    const reinviteToOrgTeam = jest.fn(async () => true);
    const invoke = handler(file, name, {
      reinviteToOrgTeam,
      UserVisibleError: Error,
      createClient: () => client,
      getAdminSupabase: () => client,
      ...runtime,
      TZDate,
      isServiceRoleRequest: () => true,
      isUserInOrg: async () => false,
      isOrgInviteWindowKnownClosed: () => false,
      Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
      console: { log: () => {} }
    });
    if (file === "github-user-sync") await invoke("user", "student");
    else await invoke({ headers: new Map(), method: "POST", json: async () => ({ user_id: "user" }) });
    expect([label, reinviteToOrgTeam.mock.calls.length]).toEqual([label, invited ? 1 : 0]);
  }
});

// The student-repo lookup is shared with forgejo-repo-webhook; the routing test runs the real one.
const repoPush = Object.fromEntries(
  ["findStudentRepository", "fromGitHubPush", "isDefaultBranchPush"].map((name) => [
    name,
    handler("_shared/RepoPush.ts", name, { console, Sentry: { captureException() {} } })
  ])
);

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
      ...repoPush,
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

test.each(["github", "forgejo"])("%s group moves reach the move", async (provider) => {
  const rows = [{ id: 1, assignments: { git_provider: provider } }];
  const client = { from: () => query(rows) };
  // Every membership, group and repository write happens inside the move, which skips GitHub jobs for Forgejo repos.
  const moveStudentBetweenGroups = jest.fn(async () => {});
  const invoke = handler("assignment-group-instructor-move-student", "handleAssignmentGroupInstructorMoveStudent", {
    createClient: () => client,
    ...runtime,
    moveStudentBetweenGroups,
    enqueueGithubArchiveRepo: jest.fn(),
    enqueueSyncRepoPermissions: jest.fn(),
    assertUserIsInstructor: async () => ({ supabase: client, enrollment: {} })
  });
  const response = invoke({
    headers: new Map(),
    json: async () => ({ old_assignment_group_id: 1, new_assignment_group_id: 2, profile_id: "student", class_id: 1 })
  });
  await expect(response).resolves.toBeUndefined();
  expect(moveStudentBetweenGroups).toHaveBeenCalledTimes(1);
});

test.each(["github", "forgejo"])("%s group leave enqueues GitHub jobs only for a GitHub repo", async (provider) => {
  const membership = {
    id: 5,
    class_id: 1,
    assignment_group_id: 7,
    classes: { github_org: "org", slug: "cs1" },
    assignment_groups: { repositories: [{ repository: "org/cs1-hw1-group-a", git_provider: provider }] }
  };
  const remaining = [{ profiles: { user_roles: { users: { github_username: "other" } } } }];
  const client = {
    from: (table: string) =>
      table === "assignments"
        ? query({ class_id: 1, group_formation_deadline: null, classes: { time_zone: null } })
        : query(membership, {
            delete: () => query(null),
            select: (columns: string) => (columns.includes("assignment_groups(") ? query(membership) : query(remaining))
          })
  };
  const enqueueGithubArchiveRepo = jest.fn();
  const enqueueSyncRepoPermissions = jest.fn();
  const invoke = handler("assignment-group-leave", "handleAssignmentGroupLeave", {
    createClient: () => client,
    ...runtime,
    TZDate,
    IllegalArgumentError: Error,
    SecurityError: Error,
    enqueueGithubArchiveRepo,
    enqueueSyncRepoPermissions,
    assertUserIsInCourse: async () => ({ enrollment: { private_profile_id: "student" } })
  });
  await expect(invoke({ headers: new Map(), json: async () => ({ assignment_id: 1 }) })).resolves.toEqual({
    message: "You have left the group"
  });
  expect(enqueueSyncRepoPermissions).toHaveBeenCalledTimes(provider === "github" ? 1 : 0);
  expect(enqueueGithubArchiveRepo).not.toHaveBeenCalled();
});

test("Forgejo assignment copies reject before database writes", async () => {
  const copy = handler("cli/commands/assignments.ts", "copySingleAssignment", { CLICommandError: Error });
  await expect(copy({}, { git_provider: "forgejo" }, {}, {}, {})).rejects.toThrow("Forgejo");
});

test.each(["github", "forgejo"])(
  "%s join-request approval syncs permissions only for a GitHub repo",
  async (provider) => {
    const request = {
      profile_id: "joiner",
      assignment_groups: {
        id: 7,
        name: "group-a",
        assignments: { id: 1, group_formation_deadline: null, max_group_size: 3 },
        assignment_groups_members: [{ profile_id: "student" }],
        classes: { github_org: "org", slug: "cs1" },
        repositories: [{ repository: "org/cs1-hw1-group-a", git_provider: provider }]
      }
    };
    const members = [{ profiles: { user_roles: { users: { github_username: "student" } } } }];
    const client = {
      from: (table: string) =>
        table === "assignment_group_join_request"
          ? query(request)
          : query(members, { insert: async () => ({ error: null }) })
    };
    const enqueueSyncRepoPermissions = jest.fn();
    const invoke = handler("assignment-group-approve-request", "handleAssignmentGroupApproveRequest", {
      createClient: () => client,
      ...runtime,
      TZDate,
      SecurityError: Error,
      enqueueSyncRepoPermissions,
      assertUserIsInCourse: async () => ({
        enrollment: { private_profile_id: "student", classes: { time_zone: "UTC" } }
      }),
      Sentry: { captureException: jest.fn() },
      console
    });
    await expect(
      invoke({ headers: new Map(), json: async () => ({ join_request_id: 1, course_id: 1 }) })
    ).resolves.toEqual({ message: "Join request approved for group group-a" });
    expect(enqueueSyncRepoPermissions).toHaveBeenCalledTimes(provider === "github" ? 1 : 0);
  }
);

test.each(["github", "forgejo"])("pr-link-confirm reads the pull request only on a %s assignment", async (provider) => {
  const link = { id: 1, class_id: 1, assignment_id: 2, pr_repo: "same/name", pr_number: 3 };
  const client = { from: (table: string) => query(table === "assignments" ? { git_provider: provider } : link) };
  const getPullRequest = jest.fn(async () => {
    throw new Error("reached GitHub");
  });
  const invoke = handler("pr-link-confirm", "handleRequest", {
    createClient: () => client,
    ...runtime,
    getPullRequest,
    SecurityError: Error,
    UserVisibleError: Error,
    assertUserIsInCourse: async () => ({ enrollment: { role: "instructor" } })
  });
  const response = invoke({ headers: new Map([["Authorization", "token"]]), json: async () => ({ link_id: 1 }) });
  await expect(response).rejects.toThrow(provider === "github" ? "reached GitHub" : "only supported for GitHub");
  expect(getPullRequest).toHaveBeenCalledTimes(provider === "github" ? 1 : 0);
});

test.each(["github", "forgejo"])("get-pr-base-files reads the base tree only on a %s assignment", async (provider) => {
  const rows: Record<string, unknown> = {
    submissions: { id: 1, class_id: 1, assignment_id: 2, base_sha: "base" },
    assignments: { upstream_repo: "same/name", git_provider: provider },
    pr_base_tree_cache: { files: { "a.txt": "cached" } }
  };
  const client = { from: (table: string) => query(rows[table]) };
  const invoke = handler("get-pr-base-files", "handleRequest", {
    createClient: () => client,
    ...runtime,
    SecurityError: Error,
    UserVisibleError: Error,
    assertUserIsInCourse: async () => ({ enrollment: { role: "instructor" } })
  });
  const response = invoke({ headers: new Map([["Authorization", "token"]]), json: async () => ({ submission_id: 1 }) });
  if (provider === "github") await expect(response).resolves.toEqual({ files: { "a.txt": "cached" } });
  else await expect(response).rejects.toThrow("only supported for GitHub");
});

test.each([
  ["handleSyncGradeWorkflowContext", { class: 1, assignment: 2 }],
  ["handleCrossAssignmentCopyContext", { class: 1, source_assignment: 2, target_assignment: 3 }]
])("CLI %s rejects Forgejo assignments before touching GitHub", async (name, params) => {
  const getFileFromRepo = jest.fn();
  const fetchRepositoriesForAssignment = jest.fn(async () => []);
  const invoke = handler("cli/commands/repos.ts", name, {
    CLICommandError: Error,
    getAdminClient: () => ({}),
    resolveClass: async () => ({ id: 1 }),
    assertUserCanAccessClass: async () => {},
    resolveAssignment: async (_: unknown, __: number, id: number) => ({
      id,
      git_provider: id === 3 || name === "handleSyncGradeWorkflowContext" ? "forgejo" : "github",
      template_repo: "org/handout"
    }),
    getFileFromRepo,
    fetchRepositoriesForAssignment
  });
  await expect(invoke({ userId: "user" }, params)).rejects.toThrow("Forgejo");
  expect(getFileFromRepo).not.toHaveBeenCalled();
  expect(fetchRepositoriesForAssignment).not.toHaveBeenCalled();
});
