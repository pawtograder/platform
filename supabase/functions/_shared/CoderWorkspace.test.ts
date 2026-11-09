/**
 * Unit tests for workspace-open and workspace-status (#1222), against an in-memory Coder v2.37.3
 * API served through `fetch` and an in-memory WorkspaceDb.
 *
 * Covers: account creation and reuse, adopting a user a lost write left behind, refusing to adopt
 * by email, workspace create, reuse and start, the concurrent-create 409, the unlinked external auth
 * and unsigned-in paths (always asking Coder about the student, never the service token), a user
 * bound to another subject, the failing startup step with its log lines, a failed build, the editor
 * URL, and which repository a caller may open.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-read --allow-env _shared/CoderWorkspace.test.ts
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  type Caller,
  coderUsername,
  type Deps,
  openWorkspace,
  type RepositoryRow,
  type WorkspaceDb,
  workspaceName,
  type WorkspaceRow,
  workspaceStatus
} from "./CoderWorkspace.ts";
import type { CoderAgent, CoderWorkspace } from "./CoderWrapper.ts";
import { IllegalArgumentError, NotFoundError, SecurityError, UserVisibleError } from "./HandlerUtils.ts";

const CODER_URL = "https://coder.example.com";
const FORGEJO_URL = "https://git.example.com";
const OWNER_ID = "00000000-0000-0000-0000-00000000aaaa";
const ORG_ID = "00000000-0000-0000-0000-00000000000f";
const TEMPLATE = { id: "tmpl-1", active_version_id: "ver-1", default_ttl_ms: 3_600_000 };

const ALEX: Caller = {
  userId: "1a2b3c4d-5e6f-4a1b-8c2d-0e1f2a3b4c5d",
  email: "alex.kim@example.edu",
  name: "Alex Kim"
};
const JORDAN: Caller = { userId: "9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c", email: "jordan@example.edu", name: null };

// ---- fake Coder -----------------------------------------------------------

type FakeUser = {
  id: string;
  username: string;
  email: string;
  login_type: string;
  status: string;
  subject: string | null;
};
type Call = { method: string; path: string; body?: Record<string, unknown> };

class FakeCoder {
  users: FakeUser[] = [
    {
      id: OWNER_ID,
      username: "admin",
      email: "admin@example.com",
      login_type: "password",
      status: "active",
      subject: null
    }
  ];
  /** user id -> linked to Forgejo. The owner is linked, so a lookup without user_id says "authenticated". */
  forgejoLinked = new Set<string>([OWNER_ID]);
  workspaces: CoderWorkspace[] = [];
  /** Agent state applied to every workspace built after it's set. */
  nextAgent: Partial<CoderAgent> = { lifecycle_state: "starting", status: "connected", scripts: [] };
  nextBuildStatus = "running";
  nextJobError = "";
  logs: { id: number; output: string; source_id: string; level: string }[] = [];
  calls: Call[] = [];
  conflicts = 0;
  private seq = 0;

  newId(prefix: string) {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
  }

  addUser(u: Partial<FakeUser> & { username: string; email: string }): FakeUser {
    const user: FakeUser = { id: this.newId("user"), login_type: "oidc", status: "active", subject: null, ...u };
    this.users.push(user);
    return user;
  }

  findUser(key: string) {
    return this.users.find((u) => u.id === key || u.username === key) ?? null;
  }

  build(owner: FakeUser, name: string, repoUrl: string): CoderWorkspace {
    const agent = {
      id: this.newId("agent"),
      name: "main",
      status: "connected",
      lifecycle_state: "ready",
      apps: [],
      scripts: [],
      ...structuredClone(this.nextAgent)
    } as CoderAgent;
    return {
      id: this.newId("ws"),
      name,
      owner_id: owner.id,
      owner_name: owner.username,
      latest_build: {
        status: this.nextBuildStatus,
        transition: "start",
        template_version_id: TEMPLATE.active_version_id,
        job: { error: this.nextJobError || undefined },
        resources: [{ agents: [agent] }]
      },
      // Not part of Coder's response; kept so tests can check the parameter.
      repo_url: repoUrl
    } as CoderWorkspace & { repo_url: string };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Yield, so concurrent calls interleave the way two requests would.
    await new Promise((r) => setTimeout(r, 0));
    const url = new URL(String(input));
    assertEquals(url.origin, CODER_URL);
    assertEquals((init?.headers as Record<string, string>)["Coder-Session-Token"], "owner-token");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + url.search, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/organizations/default") return json(200, { id: ORG_ID });
    if (method === "GET" && path === "/organizations/default/templates/kubernetes") return json(200, TEMPLATE);
    if (method === "GET" && path === "/applications/host") return json(200, { host: "*.coder.example.com" });
    if (method === "POST" && path === "/users") {
      if (this.users.some((u) => u.username === body.username || u.email.toLowerCase() === body.email.toLowerCase())) {
        return json(409, { message: "User already exists." });
      }
      assertEquals(body.login_type, "oidc");
      assertEquals(body.organization_ids, [ORG_ID]);
      const u = this.addUser({ username: body.username, email: body.email });
      return json(201, u);
    }
    if (method === "GET" && path === "/users") {
      const email = url.searchParams.get("q")!.replace(/^email:/, "");
      return json(200, { users: this.users.filter((u) => u.email.toLowerCase() === email.toLowerCase()) });
    }
    if ((m = path.match(/^\/debug\/([^/]+)\/debug-link$/))) {
      const u = this.findUser(decodeURIComponent(m[1]));
      if (!u) return json(404, { message: "Resource not found" });
      if (!u.subject) return json(500, { message: "Failed to get user links.", detail: "sql: no rows in result set" });
      return json(200, { id_token_claims: { sub: u.subject, iss: "https://api.example.com/auth/v1" } });
    }
    if ((m = path.match(/^\/templateversions\/([^/]+)\/external-auth$/))) {
      const who = url.searchParams.get("user_id") ?? OWNER_ID;
      return json(200, [
        {
          id: "forgejo",
          type: "gitea",
          display_name: "Forgejo",
          authenticate_url: `${CODER_URL}/external-auth/forgejo`,
          authenticated: this.forgejoLinked.has(who)
        }
      ]);
    }
    if ((m = path.match(/^\/users\/([^/]+)\/workspace\/([^/]+)$/))) {
      const u = this.findUser(decodeURIComponent(m[1]));
      const ws = this.workspaces.find((w) => w.owner_id === u?.id && w.name === m![2]);
      return ws ? json(200, ws) : json(404, { message: "Resource not found" });
    }
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      const u = this.findUser(decodeURIComponent(m[1]));
      return u ? json(200, u) : json(404, { message: "Resource not found" });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/workspaces$/)) && method === "POST") {
      const owner = this.findUser(decodeURIComponent(m[1]))!;
      if (!this.forgejoLinked.has(owner.id)) {
        return json(403, {
          message: "External authentication is required to create a workspace with this template.",
          validations: [{ field: "external_auth", detail: "forgejo" }]
        });
      }
      if (this.workspaces.some((w) => w.owner_id === owner.id && w.name === body.name)) {
        this.conflicts++;
        return json(409, { message: `Workspace "${body.name}" already exists.` });
      }
      const ws = this.build(owner, body.name, body.rich_parameter_values[0].value);
      this.workspaces.push(ws);
      return json(201, ws);
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/builds$/)) && method === "POST") {
      const ws = this.workspaces.find((w) => w.id === m![1])!;
      ws.latest_build = { ...ws.latest_build, status: "pending", transition: body.transition, resources: [] };
      return json(201, ws.latest_build);
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)$/))) {
      const ws = this.workspaces.find((w) => w.id === m![1]);
      return ws ? json(200, ws) : json(404, { message: "Resource not found" });
    }
    if ((m = path.match(/^\/workspaceagents\/([^/]+)\/logs$/))) return json(200, this.logs);
    throw new Error(`fake Coder: no route for ${method} ${path}`);
  };

  posts(path: RegExp) {
    return this.calls.filter((c) => c.method === "POST" && path.test(c.path));
  }
}

// ---- fake database --------------------------------------------------------

const ASSIGNMENT = { id: 41, class_id: 7, git_provider: "forgejo" };

class FakeDb implements WorkspaceDb {
  assignments = [ASSIGNMENT, { id: 42, class_id: 7, git_provider: "github" }];
  enrollments: { user_id: string; class_id: number; private_profile_id: string; disabled: boolean }[] = [
    { user_id: ALEX.userId, class_id: 7, private_profile_id: "prof-alex", disabled: false },
    { user_id: JORDAN.userId, class_id: 7, private_profile_id: "prof-jordan", disabled: false }
  ];
  groups: { assignment_id: number; profile_id: string; group_id: number }[] = [];
  repos: RepositoryRow[] = [
    repo(501, "prof-alex", null, "cs3500/hw1-alex"),
    repo(502, "prof-jordan", null, "cs3500/hw1-jordan"),
    { ...repo(503, "prof-alex", null, "cs3500-gh/hw2-alex"), assignment_id: 42, git_provider: "github" }
  ];
  accounts: { user_id: string; instance_url: string; coder_user_id: string; coder_username: string }[] = [];
  rows: (WorkspaceRow & { user_id: string; assignment_id: number; repo_url: string })[] = [];
  private nextRow = 1;

  async getAssignment(id: number) {
    return this.assignments.find((a) => a.id === id) ?? null;
  }
  async getEnrollment(userId: string, classId: number) {
    return this.enrollments.find((e) => e.user_id === userId && e.class_id === classId) ?? null;
  }
  async getGroupId(assignmentId: number, profileId: string) {
    return this.groups.find((g) => g.assignment_id === assignmentId && g.profile_id === profileId)?.group_id ?? null;
  }
  async getRepository(id: number) {
    return this.repos.find((r) => r.id === id) ?? null;
  }
  async findRepository(assignmentId: number, profileId: string, groupId: number | null) {
    return (
      this.repos.find(
        (r) =>
          r.assignment_id === assignmentId &&
          (groupId !== null ? r.assignment_group_id === groupId : r.profile_id === profileId)
      ) ?? null
    );
  }
  async getCoderAccount(userId: string, instanceUrl: string) {
    return this.accounts.find((a) => a.user_id === userId && a.instance_url === instanceUrl) ?? null;
  }
  async saveCoderAccount(row: FakeDb["accounts"][number]) {
    const i = this.accounts.findIndex((a) => a.user_id === row.user_id && a.instance_url === row.instance_url);
    if (i >= 0) this.accounts[i] = row;
    else this.accounts.push(row);
  }
  async reserveWorkspace(row: Parameters<WorkspaceDb["reserveWorkspace"]>[0]) {
    let stored = this.rows.find((r) => r.user_id === row.user_id && r.assignment_id === row.assignment_id);
    if (!stored) {
      stored = { id: this.nextRow++, coder_workspace_id: null, ...row };
      this.rows.push(stored);
    }
    return { ...stored };
  }
  async getWorkspaceRow(userId: string, assignmentId: number) {
    const r = this.rows.find((r) => r.user_id === userId && r.assignment_id === assignmentId);
    return r ? { ...r } : null;
  }
  async updateWorkspaceRow(id: number, patch: { coder_workspace_id?: string | null; coder_user_id?: string }) {
    Object.assign(this.rows.find((r) => r.id === id)!, patch);
  }
  async deletionDate() {
    return "2026-12-31T00:00:00+00:00";
  }
}

function repo(id: number, profileId: string | null, groupId: number | null, name: string): RepositoryRow {
  return {
    id,
    assignment_id: ASSIGNMENT.id,
    class_id: 7,
    profile_id: profileId,
    assignment_group_id: groupId,
    repository: name,
    git_provider: "forgejo"
  };
}

function setup() {
  const coder = new FakeCoder();
  const db = new FakeDb();
  const deps: Deps = {
    db,
    coder: { url: CODER_URL, token: "owner-token", fetch: coder.fetch },
    forgejoUrl: FORGEJO_URL
  };
  return { coder, db, deps };
}

/** What the student's first Coder sign-in and Forgejo link do. */
function signInAndLink(coder: FakeCoder, caller: Caller) {
  const u = coder.users.find((u) => u.email === caller.email)!;
  u.subject = caller.userId;
  coder.forgejoLinked.add(u.id);
}

// ---- tests ----------------------------------------------------------------

Deno.test("coderUsername: valid, at most 32 characters, the same every time", () => {
  for (const email of [
    "alex.kim@example.edu",
    "a.very.long.local.part.indeed+tag@x.org",
    "___@x.org",
    "Ünïcödé@x.org"
  ]) {
    const name = coderUsername(email, ALEX.userId);
    assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name), name);
    assert(name.length <= 32, name);
    assertEquals(coderUsername(email, ALEX.userId), name);
  }
  assertEquals(coderUsername("alex.kim@example.edu", ALEX.userId), "alex-kim-1a2b3c4d5e6f");
  assertEquals(coderUsername("___@x.org", ALEX.userId), "user-1a2b3c4d5e6f");
  assertEquals(workspaceName(123456789), "assignment-123456789");
});

Deno.test(
  "first call creates the Coder user and asks the student to sign in; a second call creates nothing",
  async () => {
    const { coder, db, deps } = setup();
    const first = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(first.status, "needs_linking");
    assertEquals(first.authenticate_url, `${CODER_URL}/external-auth/forgejo`);
    assertEquals(coder.posts(/^\/users$/).length, 1);
    const created = coder.findUser("alex-kim-1a2b3c4d5e6f")!;
    assertEquals(created.email, ALEX.email);
    assertEquals(db.accounts, [
      { user_id: ALEX.userId, instance_url: CODER_URL, coder_user_id: created.id, coder_username: created.username }
    ]);

    const second = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(second.coder_user_id, first.coder_user_id);
    assertEquals(coder.posts(/^\/users$/).length, 1, "no second create");
    assertEquals(coder.users.length, 2);
    assertEquals(coder.workspaces.length, 0, "no workspace before the student has signed in and linked Forgejo");
  }
);

Deno.test("a lost account row: the 409 adopts our own unbound user, and one bound to the caller", async () => {
  const { coder, db, deps } = setup();
  const mine = coder.addUser({ username: coderUsername(ALEX.email, ALEX.userId), email: ALEX.email });
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(db.accounts[0].coder_user_id, mine.id);

  // Signed up before Pawtograder made the account, under another username, bound to Jordan's subject.
  const other = coder.addUser({ username: "jordan", email: JORDAN.email, subject: JORDAN.userId });
  await openWorkspace(deps, JORDAN, { assignment_id: 41 });
  assertEquals(db.accounts[1].coder_user_id, other.id);
});

Deno.test("never adopts by email: a user with the caller's email but another or no subject is refused", async () => {
  for (const subject of [null, "someone-else"]) {
    const { coder, db, deps } = setup();
    coder.addUser({ username: "alex", email: ALEX.email, subject });
    const err = await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
    assertEquals(err.status, 409);
    assertEquals(db.accounts.length, 0);
  }
  // Our deterministic username, but bound to someone else.
  const { coder, deps } = setup();
  coder.addUser({ username: coderUsername(ALEX.email, ALEX.userId), email: ALEX.email, subject: "someone-else" });
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
});

Deno.test("unlinked Forgejo: needs_linking with the student's own link state, and no workspace", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.findUser("alex-kim-1a2b3c4d5e6f")!.subject = ALEX.userId; // signed in, not linked
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "needs_linking");
  assertEquals(res.redirect_url, `${CODER_URL}/external-auth/forgejo`);
  const lookups = coder.calls.filter((c) => c.path.startsWith("/templateversions/"));
  assert(lookups.length > 0);
  const userId = coder.findUser("alex-kim-1a2b3c4d5e6f")!.id;
  for (const c of lookups) assertEquals(c.path, `/templateversions/ver-1/external-auth?user_id=${userId}`);
  assertEquals(coder.posts(/\/workspaces$/).length, 0);
  assertEquals(db.rows.length, 0);
});

Deno.test("a Coder user bound to another Pawtograder login is refused before any workspace", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  const u = coder.findUser("alex-kim-1a2b3c4d5e6f")!;
  u.subject = JORDAN.userId; // someone else signed in with Alex's old email first
  coder.forgejoLinked.add(u.id);
  const err = await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), SecurityError);
  assertEquals(err.details, "Your Coder account is bound to a different Pawtograder login");
  assertEquals(coder.workspaces.length, 0);
});

Deno.test("creates the workspace from the template with the repo URL and TTL, then reuses it", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const first = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(first.status, "starting");
  assertEquals(first.workspace_name, "assignment-41");
  const [create] = coder.posts(/\/workspaces$/);
  assertEquals(create.body, {
    template_id: "tmpl-1",
    name: "assignment-41",
    ttl_ms: 3_600_000,
    rich_parameter_values: [{ name: "repo_url", value: "https://git.example.com/cs3500/hw1-alex.git" }]
  });
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].coder_workspace_id, first.workspace_id);
  assertEquals(db.rows[0].repo_url, "https://git.example.com/cs3500/hw1-alex.git");
  assertEquals(first.deletion_date, "2026-12-31T00:00:00+00:00");

  const second = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(second.workspace_id, first.workspace_id);
  assertEquals(second.coder_user_id, first.coder_user_id);
  assertEquals(coder.posts(/\/workspaces$/).length, 1);
  assertEquals(coder.posts(/\/builds$/).length, 0, "a running workspace isn't rebuilt");
});

Deno.test("a stopped workspace is started", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const first = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  const ws = coder.workspaces[0];
  ws.latest_build = { ...ws.latest_build, transition: "stop", status: "stopped", resources: [] };
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "not_started");

  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.workspace_id, first.workspace_id);
  assertEquals(
    coder.posts(/\/builds$/).map((c) => c.body),
    [{ transition: "start" }]
  );
  assertEquals(res.status, "starting");
  assertEquals(res.step, "build");
});

Deno.test("two concurrent first calls make one user and one workspace; the loser takes Coder's 409", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const [a, b] = await Promise.all([
    openWorkspace(deps, ALEX, { assignment_id: 41 }),
    openWorkspace(deps, ALEX, { assignment_id: 41 })
  ]);
  assertEquals(coder.workspaces.length, 1);
  assertEquals(coder.conflicts, 1);
  assertEquals(a.workspace_id, b.workspace_id);
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].coder_workspace_id, a.workspace_id);

  // And for the user: two first calls by a new student.
  const fresh = setup();
  const [c, d] = await Promise.all([
    openWorkspace(fresh.deps, JORDAN, { assignment_id: 41 }),
    openWorkspace(fresh.deps, JORDAN, { assignment_id: 41 })
  ]);
  assertEquals(c.coder_user_id, d.coder_user_id);
  assertEquals(fresh.coder.users.length, 2);
  assertEquals(fresh.db.accounts.length, 1);
});

Deno.test("a failed clone returns the failing step, its exit code and its last log lines", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = {
    lifecycle_state: "start_error",
    status: "connected",
    scripts: [
      { display_name: "Startup Script", status: "ok", exit_code: 0, log_source_id: "src-startup" },
      { display_name: "Git Clone", status: "exit_failure", exit_code: 128, log_source_id: "src-clone" }
    ]
  };
  const clone = Array.from({ length: 25 }, (_, i) => ({
    id: i,
    output: `clone line ${i}`,
    source_id: "src-clone",
    level: "info"
  }));
  coder.logs = [{ id: 100, output: "startup ok", source_id: "src-startup", level: "info" }, ...clone];
  coder.logs.push({
    id: 200,
    output: "fatal: repository 'https://git.example.com/cs3500/nope.git/' not found",
    source_id: "src-clone",
    level: "info"
  });

  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "failed");
  assertEquals(res.step, "clone");
  assertEquals(res.message, '"Git Clone" failed with exit code 128.');
  assertEquals(res.failure!.script, "Git Clone");
  assertEquals(res.failure!.exit_code, 128);
  assertEquals(res.failure!.log_lines.length, 20);
  assertEquals(res.failure!.log_lines.at(-1), "fatal: repository 'https://git.example.com/cs3500/nope.git/' not found");
  assert(!res.failure!.log_lines.includes("startup ok"));
  assertEquals(res.build, { status: "running", transition: "start", error: null });
  assertEquals(res.agent, { lifecycle_state: "start_error", status: "connected" });

  // workspace-status reports the same without building anything.
  const posts = coder.calls.filter((c) => c.method === "POST").length;
  const status = await workspaceStatus(deps, ALEX, { assignment_id: 41 });
  assertEquals(status.failure, res.failure);
  assertEquals(coder.calls.filter((c) => c.method === "POST").length, posts);
});

Deno.test("a failed build reports the build step and Coder's job error", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextBuildStatus = "failed";
  coder.nextJobError = 'pods "coder-alex" is forbidden: exceeded quota';
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "failed");
  assertEquals(res.step, "build");
  assertEquals(res.failure, {
    step: "build",
    script: null,
    exit_code: null,
    log_lines: ['pods "coder-alex" is forbidden: exceeded quota']
  });
});

Deno.test("ready: redirect_url is VS Code on the app subdomain, opened on the cloned folder", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = {
    lifecycle_state: "ready",
    status: "connected",
    scripts: [{ display_name: "Git Clone", status: "ok", exit_code: 0, log_source_id: "s" }],
    apps: [
      {
        slug: "code-server",
        url: "http://localhost:13337/?folder=/home/coder/hw1-alex",
        subdomain: true,
        subdomain_name: "code-server--assignment-41--alex-kim-1a2b3c4d5e6f",
        health: "healthy"
      }
    ]
  };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "ready");
  assertEquals(
    res.redirect_url,
    "https://code-server--assignment-41--alex-kim-1a2b3c4d5e6f.coder.example.com/?folder=/home/coder/hw1-alex"
  );
});

Deno.test("authorization: only the caller's own or group repository, on Forgejo, while enrolled", async () => {
  const { coder, db, deps } = setup();
  // Jordan names Alex's repository.
  const err = await assertRejects(
    () => openWorkspace(deps, JORDAN, { assignment_id: 41, repository_id: 501 }),
    SecurityError
  );
  assertEquals(err.details, "This repository is not yours");
  await assertRejects(() => workspaceStatus(deps, JORDAN, { assignment_id: 41, repository_id: 501 }), SecurityError);
  // A repository from another assignment.
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41, repository_id: 503 }), SecurityError);
  // Not enrolled, or disabled.
  await assertRejects(
    () => openWorkspace(deps, { ...JORDAN, userId: "00000000-0000-4000-8000-0000000000ee" }, { assignment_id: 41 }),
    SecurityError
  );
  db.enrollments[1].disabled = true;
  await assertRejects(() => openWorkspace(deps, JORDAN, { assignment_id: 41 }), SecurityError);
  db.enrollments[1].disabled = false;
  // GitHub assignments and bad ids.
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 42 }), IllegalArgumentError);
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 0 }), IllegalArgumentError);
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 99 }), NotFoundError);
  // No repository yet.
  db.repos = db.repos.filter((r) => r.id !== 502);
  await assertRejects(() => openWorkspace(deps, JORDAN, { assignment_id: 41 }), NotFoundError);
  assertEquals(coder.calls.length, 0, "Coder is never called for a refused request");

  // A group repository opens for every member, by default and by id.
  db.repos.push(repo(600, null, 77, "cs3500/hw1-group-77"));
  db.groups.push(
    { assignment_id: 41, profile_id: "prof-alex", group_id: 77 },
    { assignment_id: 41, profile_id: "prof-jordan", group_id: 77 }
  );
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  await openWorkspace(deps, JORDAN, { assignment_id: 41, repository_id: 600 });
  signInAndLink(coder, ALEX);
  signInAndLink(coder, JORDAN);
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  await openWorkspace(deps, JORDAN, { assignment_id: 41, repository_id: 600 });
  const urls = coder.posts(/\/workspaces$/).map((c) => (c.body!.rich_parameter_values as { value: string }[])[0].value);
  assertEquals(urls, [
    "https://git.example.com/cs3500/hw1-group-77.git",
    "https://git.example.com/cs3500/hw1-group-77.git"
  ]);
  assertEquals(new Set(coder.workspaces.map((w) => w.owner_id)).size, 2, "each member gets their own workspace");
});

Deno.test("workspace-status creates nothing", async () => {
  const { coder, db, deps } = setup();
  assertEquals(await workspaceStatus(deps, ALEX, { assignment_id: 41 }), { status: "not_started" });
  assertEquals(coder.calls.length, 0);
  assertEquals(db.accounts.length + db.rows.length, 0);
});
