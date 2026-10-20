/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { TZDate } from "@date-fns/tz";

// Execute actual function bodies with database/GitHub mocks, no copied filtering logic.
test.each(["github-user-sync", "autograder-create-repos-for-student"])(
  "%s isolates mixed-provider repos",
  async (file) => {
    for (const provisioned of [false, true]) {
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
          repositories: provider === "github" || provisioned ? [repo(provider, "group")] : [],
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
          return query;
        }
      };
      const syncRepoPermissions = jest.fn(async () => ({ madeChanges: false }));
      const name = file === "github-user-sync" ? "ensureAllReposExist" : "handleRequest";
      const text = readFileSync(`supabase/functions/${file}/index.ts`, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
      const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
      const code = ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 });
      const invoke = runInNewContext(`${code}\n${name}`, {
        createClient: () => client,
        getAdminSupabase: () => client,
        REQUEST_SCOPED_AUTH_OPTIONS: {},
        TZDate,
        syncRepoPermissions,
        Deno: { env: { get: () => "test" } },
        isServiceRoleRequest: () => true,
        isUserInOrg: async () => true,
        isOrgInviteWindowKnownClosed: () => true,
        sanitizeRepoNameComponent: (value: string) => value,
        Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
        console: { log: () => {} }
      });
      if (file === "github-user-sync") await invoke("user", "student");
      else await invoke({ headers: new Map(), method: "POST", json: async () => ({ user_id: "user" }) });
      expect(insert).not.toHaveBeenCalled();
      expect(syncRepoPermissions.mock.calls.map((call: unknown[]) => call[1]).sort()).toEqual([
        "course-github-group-github",
        "github-group",
        "github-individual"
      ]);
    }
  }
);
