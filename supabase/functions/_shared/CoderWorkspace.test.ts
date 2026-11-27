/**
 * Unit tests for workspace-open and workspace-status (#1222), against an in-memory Coder v2.37.3
 * API served through `fetch` and an in-memory WorkspaceDb.
 *
 * Covers: account creation with the subject-derived Coder email and reuse, adopting a user a lost
 * write left behind, refusing to adopt by email, the concurrent user create (409 and 500),
 * workspace create, reuse and start, the concurrent-create 409 and 500, the unlinked external auth
 * and unsigned-in paths (always asking Coder about the student, never the service token), a user
 * bound to another subject, the failing startup step with its log lines, a failed build, the
 * restart after a failed or lost agent or an unhealthy editor (within open's time budget, finished
 * by a status read when the stop is slow), no second stop for a workspace another open already
 * restarted, a failed stop build, one start per restart however the callers interleave, answering
 * within the budget in real time when a Coder or database call hangs, no claim taken without time
 * to use it, a stale claim taken over, an open while Coder is already stopping the workspace (kept
 * as a claim, with no second stop, and started once), readiness only with a connected agent, the
 * editor URL, a group change, which repository a caller may open, the repo_url shape the template
 * accepts, a Coder user that predates the Coder email (an account conflict until staff delete it),
 * and a course without cloud-workspaces.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-read --allow-env _shared/CoderWorkspace.test.ts
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  budgetFetch,
  type Caller,
  coderEmail,
  coderUsername,
  type Deps,
  gitCredentialsFile,
  linkUrl,
  OPEN_BUDGET_MS,
  openWorkspace,
  type RepositoryRow,
  RESTART_CLAIM_MS,
  startBudget,
  type WorkspaceDb,
  workspaceName,
  type WorkspaceRow,
  withinBudget,
  workspaceStatus
} from "./CoderWorkspace.ts";
import { budgetClient, githubConfig, supabaseWorkspaceDb } from "./CoderWorkspaceDb.ts";
import type { CoderAgent, CoderWorkspace } from "./CoderWrapper.ts";
import { IDLE_TOKEN_MS, REPLACED_TOKEN_GRACE_MS } from "./ForgejoWrapper.ts";
import { IllegalArgumentError, NotFoundError, SecurityError, UserVisibleError } from "./HandlerUtils.ts";

const CODER_URL = "https://coder.example.com";
const FORGEJO_URL = "https://git.example.com";
const OWNER_ID = "00000000-0000-0000-0000-00000000aaaa";
const ORG_ID = "00000000-0000-0000-0000-00000000000f";
const TEMPLATE = { id: "tmpl-1", active_version_id: "ver-1", default_ttl_ms: 3_600_000 };
/** The template's repo_url validation with forgejo_url = FORGEJO_URL (main.tf `repo_url_regex`). */
const REPO_URL_REGEX =
  /^((https:\/\/git\.example\.com|https:\/\/github\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/;

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
  /** Coder soft-deletes users. */
  deleted?: boolean;
};

/**
 * Fake time: sleeps and Coder calls move it, so a test can measure what open spends. A test on real
 * time sets `now` to Date.now.
 */
class Clock {
  // Starts at the real time, so claims made on it are still fresh when a test switches to real time.
  t = Date.now();
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms;
  };
  iso() {
    return new Date(this.now()).toISOString();
  }
}
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
  linked = new Set<string>([OWNER_ID]);
  /** The template's one external auth provider. Phase 2's GitHub one is optional. */
  provider = { id: "forgejo", type: "gitea", display_name: "Forgejo", optional: false };
  workspaces: CoderWorkspace[] = [];
  /** Agent state applied to every workspace built after it's set. */
  nextAgent: Partial<CoderAgent> = { lifecycle_state: "starting", status: "connected", scripts: [] };
  nextBuildStatus = "running";
  nextJobError = "";
  logs: { id: number; output: string; source_id: string; level: string }[] = [];
  calls: Call[] = [];
  conflicts = 0;
  /**
   * How a create for a taken name fails: 409 from Coder's name check, or the 500 its unique index
   * gives when two creates both passed that check (seen live, see evidence/cw17c.md).
   */
  conflictAs: 409 | 500 = 409;
  /** The same for a user create: Coder's existence check (409), or the insert losing a race (500). */
  userConflictAs: 409 | 500 = 409;
  /**
   * When set, a pending build finishes on the next read: a stop leaves the workspace stopped, a start
   * runs it with `nextAgent`. Otherwise builds stay pending.
   */
  autoBuild = false;
  /** Fake milliseconds each Coder call takes. */
  latencyMs = 0;
  /**
   * Real milliseconds a call's response takes to come back, after Coder has acted on it. The wait
   * ends early, with the abort, when the request's signal fires.
   */
  slow?: (method: string, path: string) => number;
  private seq = 0;
  keys: { key: string; id: string; userId: string; name: string; expiresAt: number; deleted: boolean }[] = [];
  secrets: Record<string, Record<string, { value: string; file_path: string }>> = {};
  secretUpdatedAt: Record<string, Record<string, string>> = {};
  failSecretWrite = false;
  failKeyDelete = false;
  noProviders = false;

  constructor(private clock: Clock) {}

  newId(prefix: string) {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
  }

  addUser(u: Partial<FakeUser> & { username: string; email: string }): FakeUser {
    const user: FakeUser = { id: this.newId("user"), login_type: "oidc", status: "active", subject: null, ...u };
    this.users.push(user);
    return user;
  }

  /** Like Coder, a deleted user is still found by id (GetUserByID), but not by username. */
  findUser(key: string) {
    return this.users.find((u) => u.id === key || (u.username === key && !u.deleted)) ?? null;
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
      template_active_version_id: TEMPLATE.active_version_id,
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
    init?.signal?.throwIfAborted();
    const res = await this.handle(input, init);
    const ms = this.slow?.(init?.method ?? "GET", new URL(String(input)).pathname.replace(/^\/api\/v2/, "")) ?? 0;
    if (ms > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal!.reason);
          },
          { once: true }
        );
      });
    }
    return res;
  };

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // Yield, so concurrent calls interleave the way two requests would.
    await new Promise((r) => setTimeout(r, 0));
    this.clock.t += this.latencyMs;
    const url = new URL(String(input));
    assertEquals(url.origin, CODER_URL);
    const token = (init?.headers as Record<string, string>)["Coder-Session-Token"];
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + url.search, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    let m: RegExpMatchArray | null;

    if (token !== "owner-token") {
      const key = this.keys.find((k) => k.key === token && !k.deleted && k.expiresAt > this.clock.now());
      if (!key) return json(401, { message: "API key expired or deleted." });
      assert(path.startsWith("/users/me/secrets"), `a student key used for ${method} ${path}`);
      if (this.failSecretWrite) return json(500, { message: "Internal error writing secret." });
      const secrets = (this.secrets[key.userId] ??= {});
      const updatedAt = (this.secretUpdatedAt[key.userId] ??= {});
      if (path === "/users/me/secrets" && method === "GET") {
        return json(
          200,
          Object.keys(secrets).map((name) => ({ name, updated_at: updatedAt[name] }))
        );
      }
      if ((m = path.match(/^\/users\/me\/secrets\/([^/]+)$/)) && method === "DELETE") {
        const name = decodeURIComponent(m[1]);
        if (!secrets[name]) return json(404, { message: "Resource not found" });
        delete secrets[name];
        delete updatedAt[name];
        return new Response(null, { status: 204 });
      }
      if ((m = path.match(/^\/users\/me\/secrets\/([^/]+)$/)) && method === "PATCH") {
        const name = decodeURIComponent(m[1]);
        if (!secrets[name])
          return json(404, { message: "Resource not found or you do not have access to this resource" });
        secrets[name] = { ...secrets[name], ...body };
        updatedAt[name] = this.clock.iso();
        return json(200, { name, file_path: secrets[name].file_path });
      }
      if (path === "/users/me/secrets" && method === "POST") {
        if (secrets[body.name]) {
          return json(409, {
            message: "Validation failed.",
            validations: [{ field: "name", detail: "name already in use" }]
          });
        }
        secrets[body.name] = { value: body.value, file_path: body.file_path };
        updatedAt[body.name] = this.clock.iso();
        return json(201, { name: body.name, file_path: body.file_path });
      }
      throw new Error(`fake Coder: no student-key route for ${method} ${path}`);
    }
    if ((m = path.match(/^\/users\/([^/]+)\/secrets$/)) && method === "POST") {
      return json(403, { message: "Forbidden." });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/keys\/tokens$/))) {
      const userId = decodeURIComponent(m[1]);
      if (method === "POST") {
        assertEquals(body.scope, "all");
        // UniqueIndexAPIKeyName: a name stays taken until its key is deleted, expired or not.
        if (this.keys.some((k) => k.userId === userId && k.name === body.token_name && !k.deleted)) {
          return json(409, { message: `A token with name "${body.token_name}" already exists.` });
        }
        const key = `${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}-${"s".repeat(22)}`;
        this.keys.push({
          key,
          id: key.slice(0, 10),
          userId,
          name: body.token_name,
          expiresAt: this.clock.now() + body.lifetime / 1_000_000,
          deleted: false
        });
        return json(201, { key });
      }
      return json(
        200,
        this.keys
          // v2.37.3 leaves expired keys out unless include_expired is set.
          .filter((k) => k.userId === userId && !k.deleted)
          .filter((k) => url.searchParams.get("include_expired") === "true" || k.expiresAt > this.clock.now())
          .map((k) => ({ id: k.id, token_name: k.name, expires_at: new Date(k.expiresAt).toISOString() }))
      );
    }
    if ((m = path.match(/^\/users\/([^/]+)\/keys\/([^/]+)$/)) && method === "DELETE") {
      const key = this.keys.find((k) => k.userId === decodeURIComponent(m![1]) && k.id === m![2] && !k.deleted);
      if (this.failKeyDelete) return json(500, { message: "Internal error deleting API key." });
      if (!key) return json(404, { message: "Resource not found" });
      key.deleted = true;
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path === "/organizations/default") return json(200, { id: ORG_ID });
    if (method === "GET" && path === "/organizations/default/templates/kubernetes") return json(200, TEMPLATE);
    if (method === "GET" && path === "/applications/host") return json(200, { host: "*.coder.example.com" });
    if (method === "POST" && path === "/users") {
      const live = this.users.filter((u) => !u.deleted);
      if (live.some((u) => u.username === body.username || u.email.toLowerCase() === body.email.toLowerCase())) {
        if (this.userConflictAs === 500) {
          return json(500, {
            message: "Internal error creating user.",
            detail: 'pq: duplicate key value violates unique constraint "idx_users_username"'
          });
        }
        return json(409, { message: "User already exists." });
      }
      assertEquals(body.login_type, "oidc");
      assertEquals(body.organization_ids, [ORG_ID]);
      const u = this.addUser({ username: body.username, email: body.email });
      return json(201, u);
    }
    if (method === "GET" && path === "/users") {
      const email = url.searchParams.get("q")!.replace(/^email:/, "");
      return json(200, {
        users: this.users.filter((u) => !u.deleted && u.email.toLowerCase() === email.toLowerCase())
      });
    }
    if ((m = path.match(/^\/debug\/([^/]+)\/debug-link$/))) {
      const u = this.findUser(decodeURIComponent(m[1]));
      if (!u) return json(404, { message: "Resource not found" });
      if (!u.subject) return json(500, { message: "Failed to get user links.", detail: "sql: no rows in result set" });
      return json(200, { id_token_claims: { sub: u.subject, iss: "https://api.example.com/auth/v1" } });
    }
    if ((m = path.match(/^\/templateversions\/([^/]+)\/external-auth$/))) {
      if (this.noProviders) return json(200, []);
      const who = url.searchParams.get("user_id") ?? OWNER_ID;
      return json(200, [
        {
          ...this.provider,
          authenticate_url: `${CODER_URL}/external-auth/${this.provider.id}`,
          authenticated: this.linked.has(who)
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
      if (!this.noProviders && !this.provider.optional && !this.linked.has(owner.id)) {
        return json(403, {
          message: "External authentication is required to create a workspace with this template.",
          validations: [{ field: "external_auth", detail: this.provider.id }]
        });
      }
      const repoUrl = body.rich_parameter_values.find((p: { name: string }) => p.name === "repo_url")?.value;
      if (typeof repoUrl !== "string" || !REPO_URL_REGEX.test(repoUrl)) {
        return json(400, {
          message: "Unable to validate parameters",
          validations: [{ field: "repo_url", detail: "Parameter value does not match the validation regex" }]
        });
      }
      if (this.workspaces.some((w) => w.owner_id === owner.id && w.name === body.name)) {
        this.conflicts++;
        if (this.conflictAs === 500) {
          return json(500, {
            message: "Internal server error",
            detail:
              'execute transaction: insert workspace: pq: duplicate key value violates unique constraint "workspaces_owner_id_lower_idx"'
          });
        }
        return json(409, { message: `Workspace "${body.name}" already exists.` });
      }
      const ws = this.build(owner, body.name, repoUrl);
      this.workspaces.push(ws);
      return json(201, ws);
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)\/builds$/)) && method === "POST") {
      const ws = this.workspaces.find((w) => w.id === m![1])!;
      if (["pending", "starting", "stopping"].includes(ws.latest_build.status)) {
        return json(409, { message: "A workspace build is already active." });
      }
      ws.latest_build = {
        ...ws.latest_build,
        status: "pending",
        transition: body.transition,
        // Coder builds on the last build's version unless the request names one.
        template_version_id: body.template_version_id ?? ws.latest_build.template_version_id,
        resources: []
      };
      return json(201, ws.latest_build);
    }
    if ((m = path.match(/^\/workspaces\/([^/]+)$/))) {
      const ws = this.workspaces.find((w) => w.id === m![1]);
      if (ws && this.autoBuild && ws.latest_build.status === "pending") {
        if (ws.latest_build.transition === "stop") {
          ws.latest_build = { ...ws.latest_build, status: "stopped" };
        } else {
          const owner = this.findUser(ws.owner_id)!;
          ws.latest_build = this.build(owner, ws.name, "").latest_build;
        }
      }
      return ws ? json(200, ws) : json(404, { message: "Resource not found" });
    }
    if ((m = path.match(/^\/workspaceagents\/([^/]+)\/logs$/))) return json(200, this.logs);
    throw new Error(`fake Coder: no route for ${method} ${path}`);
  }

  posts(path: RegExp) {
    return this.calls.filter((c) => c.method === "POST" && path.test(c.path));
  }
}

// ---- fake Forgejo ---------------------------------------------------------

class FakeForgejo {
  tokens: Record<string, { name: string; sha1: string; repo: string }[]> = {};
  calls: Call[] = [];
  failMint = false;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 0));
    const url = new URL(String(input));
    assertEquals(url.origin, FORGEJO_URL);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + url.search, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/users\/([^/]+)\/tokens$/))) {
      const list = (this.tokens[decodeURIComponent(m[1])] ??= []);
      if (method === "GET")
        return json(200, url.searchParams.get("page") === "1" ? list.map((t) => ({ name: t.name })) : []);
      if (this.failMint) return json(500, { message: "boom" });
      const repo = `${body.repositories[0].owner}/${body.repositories[0].name}`;
      const sha1 = crypto.randomUUID().replace(/-/g, "").padEnd(40, "0");
      list.push({ name: body.name, sha1, repo });
      return json(201, { id: list.length, name: body.name, sha1 });
    }
    if ((m = path.match(/^\/users\/([^/]+)\/tokens\/([^/]+)$/)) && method === "DELETE") {
      const login = decodeURIComponent(m[1]);
      const before = (this.tokens[login] ?? []).length;
      this.tokens[login] = (this.tokens[login] ?? []).filter((t) => t.name !== decodeURIComponent(m![2]));
      return new Response(null, { status: before === this.tokens[login].length ? 404 : 204 });
    }
    throw new Error(`fake Forgejo: no route for ${method} ${path}`);
  };

  live(login: string, sha1: string) {
    return (this.tokens[login] ?? []).find((t) => t.sha1 === sha1) ?? null;
  }
}

// ---- fake database --------------------------------------------------------

const ASSIGNMENT = { id: 41, class_id: 7, git_provider: "forgejo" };

class FakeDb implements WorkspaceDb {
  constructor(private clock: Clock) {}
  assignments = [ASSIGNMENT, { id: 42, class_id: 7, git_provider: "github" }];
  enrollments: {
    user_id: string;
    class_id: number;
    private_profile_id: string;
    disabled: boolean;
    github_org_confirmed: boolean | null;
  }[] = [
    { user_id: ALEX.userId, class_id: 7, private_profile_id: "prof-alex", disabled: false, github_org_confirmed: true },
    {
      user_id: JORDAN.userId,
      class_id: 7,
      private_profile_id: "prof-jordan",
      disabled: false,
      github_org_confirmed: null
    }
  ];
  /** classes.features by class id. */
  features: Record<number, unknown> = { 7: [{ name: "cloud-workspaces", enabled: true }] };
  groups: { assignment_id: number; profile_id: string; group_id: number }[] = [];
  repos: RepositoryRow[] = [
    repo(501, "prof-alex", null, "cs3500/hw1-alex"),
    repo(502, "prof-jordan", null, "cs3500/hw1-jordan"),
    { ...repo(503, "prof-alex", null, "cs3500-gh/hw2-alex"), assignment_id: 42, git_provider: "github" }
  ];
  accounts: { user_id: string; instance_url: string; coder_user_id: string; coder_username: string }[] = [];
  rows: (WorkspaceRow & { user_id: string; assignment_id: number; repository_id: number; repo_url: string })[] = [];
  private nextRow = 1;

  async getAssignment(id: number) {
    return this.assignments.find((a) => a.id === id) ?? null;
  }
  async getEnrollment(userId: string, classId: number) {
    return this.enrollments.find((e) => e.user_id === userId && e.class_id === classId) ?? null;
  }
  async getCourseFeatures(classId: number) {
    return this.features[classId] ?? null;
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
    let stored = this.rows.find((r) => r.user_id === row.user_id && r.repository_id === row.repository_id);
    if (!stored) {
      stored = {
        id: this.nextRow++,
        coder_workspace_id: null,
        superseded_at: null,
        restart_started_at: null,
        restart_phase: null,
        restart_token: null,
        ...row
      };
      this.rows.push(stored);
    }
    return { ...stored };
  }
  async markCurrentWorkspace(row: { id: number; user_id: string; assignment_id: number }) {
    for (const r of this.rows) {
      if (r.id === row.id) r.superseded_at = null;
      else if (r.user_id === row.user_id && r.assignment_id === row.assignment_id && !r.superseded_at) {
        r.superseded_at = new Date().toISOString();
      }
    }
  }
  async getWorkspaceRow(userId: string, repositoryId: number) {
    const r = this.rows.find((r) => r.user_id === userId && r.repository_id === repositoryId);
    return r ? { ...r } : null;
  }
  async updateWorkspaceRow(id: number, patch: Parameters<WorkspaceDb["updateWorkspaceRow"]>[1]) {
    Object.assign(this.rows.find((r) => r.id === id)!, patch);
  }
  restartClaims = 0;
  // Each is synchronous once called, like the single UPDATE it stands for.
  async claimRestart(id: number, staleBefore: string) {
    const r = this.rows.find((r) => r.id === id)!;
    if (r.restart_started_at && r.restart_started_at >= staleBefore) return null;
    holdClaim(r, this.clock.iso(), "stopping");
    this.restartClaims++;
    return r.restart_token;
  }
  async takeRestartStart(id: number, token: string) {
    const r = this.rows.find((r) => r.id === id)!;
    if (r.restart_token !== token) return null;
    holdClaim(r, this.clock.iso(), "starting");
    return r.restart_token;
  }
  async releaseRestart(id: number, token: string) {
    const r = this.rows.find((r) => r.id === id)!;
    if (r.restart_token === token)
      Object.assign(r, { restart_started_at: null, restart_phase: null, restart_token: null });
  }
  async deletionDate() {
    return "2026-12-31T00:00:00+00:00";
  }
  forgejoLogins: Record<string, string> = { [ALEX.userId]: "alex.kim", [JORDAN.userId]: "jordan" };
  recordedTokens: { user_id: string; repository_id: number; instance_url: string }[] = [];
  async getForgejoLogin(userId: string, instanceUrl: string) {
    assertEquals(instanceUrl, FORGEJO_URL);
    return this.forgejoLogins[userId] ?? null;
  }
  async recordForgejoToken(userId: string, repositoryId: number, instanceUrl: string) {
    this.recordedTokens.push({ user_id: userId, repository_id: repositoryId, instance_url: instanceUrl });
  }
}

/** Puts a claim on the row, with a new token, as another call taking it would. */
function holdClaim(row: WorkspaceRow, at: string, phase: "stopping" | "starting") {
  Object.assign(row, { restart_started_at: at, restart_phase: phase, restart_token: crypto.randomUUID() });
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
  const clock = new Clock();
  const coder = new FakeCoder(clock);
  const db = new FakeDb(clock);
  const forgejo = new FakeForgejo();
  const reported: unknown[] = [];
  const deps: Deps = {
    db,
    coder: { url: CODER_URL, token: "owner-token", fetch: coder.fetch },
    forgejo: { url: FORGEJO_URL, authorization: "Basic eA==", authSourceId: 1, fetch: forgejo.fetch },
    github: { url: "https://github.com", externalAuthId: "github" },
    report: (e) => reported.push(e),
    now: clock.now,
    sleep: clock.sleep
  };
  return { clock, coder, db, deps, forgejo, reported };
}

/** What the student's first Coder sign-in and Forgejo link do. */
function signInAndLink(coder: FakeCoder, caller: Caller) {
  const u = coder.users.find((u) => u.email === coderEmail(caller.userId))!;
  u.subject = caller.userId;
  coder.linked.add(u.id);
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
  assertEquals(workspaceName(9007199254740991), "repo-9007199254740991");
  assertEquals(coderEmail(ALEX.userId), "1a2b3c4d-5e6f-4a1b-8c2d-0e1f2a3b4c5d@coder.pawtograder.invalid");
});

Deno.test(
  "first call creates the Coder user and asks the student to sign in; a second call creates nothing",
  async () => {
    const { coder, db, deps } = setup();
    const first = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(first.status, "needs_linking");
    // Coder's sign-in first, then its Forgejo link, so a student with no Coder session ends up linked.
    assertEquals(
      first.authenticate_url,
      `${CODER_URL}/api/v2/users/oidc/callback?redirect=%2Fexternal-auth%2Fforgejo%2Fcallback`
    );
    assertEquals(first.redirect_url, first.authenticate_url);
    assertEquals(coder.posts(/^\/users$/).length, 1);
    const created = coder.findUser("alex-kim-1a2b3c4d5e6f")!;
    assertEquals(created.email, coderEmail(ALEX.userId), "never the real, transferable email");
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
  const mine = coder.addUser({ username: coderUsername(ALEX.email, ALEX.userId), email: coderEmail(ALEX.userId) });
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(db.accounts[0].coder_user_id, mine.id);

  // Made under an older username (Jordan's email changed since), already bound to Jordan.
  const other = coder.addUser({ username: "jordan-old", email: coderEmail(JORDAN.userId), subject: JORDAN.userId });
  await openWorkspace(deps, JORDAN, { assignment_id: 41 });
  assertEquals(db.accounts[1].coder_user_id, other.id);
});

Deno.test("never by real email: a Coder user with the caller's real email is neither adopted nor used", async () => {
  for (const subject of [null, "someone-else"]) {
    const { coder, db, deps } = setup();
    const stranger = coder.addUser({ username: "alex", email: ALEX.email, subject });
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assert(db.accounts[0].coder_user_id !== stranger.id);
    assertEquals(coder.findUser(db.accounts[0].coder_user_id)!.email, coderEmail(ALEX.userId));
  }
  // Our deterministic username, but with a real email (made before the Coder email existed) or bound
  // to someone else: never adopted, an account conflict for staff.
  for (const u of [
    { email: ALEX.email, subject: null },
    { email: coderEmail(ALEX.userId), subject: "someone-else" }
  ]) {
    const { coder, db, deps } = setup();
    const taken = coder.addUser({ username: coderUsername(ALEX.email, ALEX.userId), ...u });
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(res.status, "account_conflict");
    assertEquals(res.coder_user_id, taken.id);
    assert(res.message!.includes(`"${taken.username}"`), res.message);
    assertEquals(db.accounts.length, 0);
  }
});

Deno.test(
  "a stored Coder user with a real email: account_conflict, not needs_linking forever; once staff delete it, a new one",
  async () => {
    const { coder, db, deps } = setup();
    // Made before Coder sign-ins used the Coder email: the row proves Pawtograder made it, but Coder
    // looks Alex's sign-in up by the Coder email, so Alex can never sign in to it.
    const legacy = coder.addUser({ username: coderUsername(ALEX.email, ALEX.userId), email: ALEX.email });
    db.accounts.push({
      user_id: ALEX.userId,
      instance_url: CODER_URL,
      coder_user_id: legacy.id,
      coder_username: legacy.username
    });
    for (let i = 0; i < 2; i++) {
      const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
      assertEquals(res.status, "account_conflict");
      assertEquals(res.coder_user_id, legacy.id);
    }
    // The same user without the row gets the same answer.
    db.accounts = [];
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "account_conflict");
    db.accounts.push({
      user_id: ALEX.userId,
      instance_url: CODER_URL,
      coder_user_id: legacy.id,
      coder_username: legacy.username
    });
    assertEquals(coder.posts(/\/workspaces$/).length, 0);
    assertEquals(db.rows.length, 0);

    // A user bound to Alex keeps working: Coder rewrites the email on Alex's next sign-in.
    legacy.subject = ALEX.userId;
    coder.linked.add(legacy.id);
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
    coder.workspaces = [];
    db.rows = [];
    legacy.subject = null;

    // Staff delete it. Coder still answers the deleted user by id, so it's looked up by username.
    legacy.deleted = true;
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(res.status, "needs_linking");
    assert(res.coder_user_id !== legacy.id);
    const fresh = coder.findUser(res.coder_user_id!)!;
    assertEquals([fresh.username, fresh.email], [legacy.username, coderEmail(ALEX.userId)]);
    assertEquals(db.accounts[0].coder_user_id, fresh.id);
  }
);

Deno.test("unlinked Forgejo: needs_linking with the student's own link state, and no workspace", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.findUser("alex-kim-1a2b3c4d5e6f")!.subject = ALEX.userId; // signed in, not linked
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "needs_linking");
  assertEquals(
    res.redirect_url,
    `${CODER_URL}/api/v2/users/oidc/callback?redirect=%2Fexternal-auth%2Fforgejo%2Fcallback`
  );
  const lookups = coder.calls.filter((c) => c.path.startsWith("/templateversions/"));
  assert(lookups.length > 0);
  const userId = coder.findUser("alex-kim-1a2b3c4d5e6f")!.id;
  for (const c of lookups) assertEquals(c.path, `/templateversions/ver-1/external-auth?user_id=${userId}`);
  assertEquals(coder.posts(/\/workspaces$/).length, 0);
  assertEquals(db.rows.length, 0);
});

Deno.test("linkUrl: Coder's OIDC sign-in, redirecting to the provider's link callback by path", () => {
  const url = new URL(linkUrl(CODER_URL, "forgejo"));
  assertEquals(url.origin + url.pathname, `${CODER_URL}/api/v2/users/oidc/callback`);
  assertEquals([...url.searchParams], [["redirect", "/external-auth/forgejo/callback"]]);
  assertEquals(
    new URL(linkUrl(CODER_URL, "git-school")).searchParams.get("redirect"),
    "/external-auth/git-school/callback"
  );
});

Deno.test("needs_linking links the provider Coder says is missing, not Coder's link page", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.findUser("alex-kim-1a2b3c4d5e6f")!.subject = ALEX.userId;
  const base = coder.fetch;
  deps.coder = {
    ...deps.coder,
    fetch: async (input, init) => {
      const res = await base(input, init);
      if (!new URL(String(input)).pathname.endsWith("/external-auth")) return res;
      const list = (await res.json()) as { id: string; authenticate_url: string }[];
      const renamed = list.map((e) => ({
        ...e,
        id: "git-school",
        authenticate_url: `${CODER_URL}/external-auth/git-school`
      }));
      return new Response(JSON.stringify(renamed), { status: 200, headers: { "content-type": "application/json" } });
    }
  };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "needs_linking");
  assertEquals(new URL(res.redirect_url!).searchParams.get("redirect"), "/external-auth/git-school/callback");
});

Deno.test("a link removed between the check and the create: needs_linking with the same sign-in link", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const u = coder.findUser("alex-kim-1a2b3c4d5e6f")!;
  const base = coder.fetch;
  deps.coder = {
    ...deps.coder,
    fetch: (input, init) => {
      if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/workspaces")) {
        coder.linked.delete(u.id);
      }
      return base(input, init);
    }
  };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "needs_linking");
  assertEquals(res.authenticate_url, linkUrl(CODER_URL, "forgejo"));
  assertEquals(res.redirect_url, res.authenticate_url);
  assertEquals(coder.workspaces.length, 0);
  assertEquals(db.rows[0].coder_workspace_id ?? null, null);
});

Deno.test("a Coder user bound to another Pawtograder login is refused before any workspace", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  const u = coder.findUser("alex-kim-1a2b3c4d5e6f")!;
  u.subject = JORDAN.userId; // bound to someone else, however that happened
  coder.linked.add(u.id);
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
  assertEquals(first.workspace_name, "repo-501");
  const [create] = coder.posts(/\/workspaces$/);
  assertEquals(create.body, {
    template_id: "tmpl-1",
    name: "repo-501",
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

Deno.test("a workspace built on an older template version starts on the active one", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  const ws = coder.workspaces[0];
  ws.latest_build = {
    ...ws.latest_build,
    template_version_id: "ver-0",
    transition: "stop",
    status: "stopped",
    resources: []
  };

  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "starting");
  // Without a version, Coder would rebuild on ver-0 and template fixes would never reach this workspace.
  assertEquals(
    coder.posts(/\/builds$/).map((c) => c.body!.template_version_id),
    [TEMPLATE.active_version_id]
  );
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
    [{ transition: "start", template_version_id: TEMPLATE.active_version_id }]
  );
  assertEquals(res.status, "starting");
  assertEquals(res.step, "build");
});

Deno.test(
  "two concurrent first calls make one user and one workspace; the loser takes Coder's 409 or 500",
  async () => {
    for (const conflictAs of [409, 500] as const) {
      const { coder, db, deps } = setup();
      coder.conflictAs = conflictAs;
      await openWorkspace(deps, ALEX, { assignment_id: 41 });
      signInAndLink(coder, ALEX);
      const [a, b] = await Promise.all([
        openWorkspace(deps, ALEX, { assignment_id: 41 }),
        openWorkspace(deps, ALEX, { assignment_id: 41 })
      ]);
      assertEquals(coder.workspaces.length, 1);
      assertEquals(coder.conflicts, 1);
      assertEquals(a.workspace_id, b.workspace_id);
      assertEquals(b.status, "starting");
      assertEquals(db.rows.length, 1);
      assertEquals(db.rows[0].coder_workspace_id, a.workspace_id);
    }

    // And for the user: two first calls by a new student, with Coder answering the loser's create
    // with 409 (its existence check saw the user) or 500 (both passed it, the insert lost).
    for (const userConflictAs of [409, 500] as const) {
      const fresh = setup();
      fresh.coder.userConflictAs = userConflictAs;
      const [c, d] = await Promise.all([
        openWorkspace(fresh.deps, JORDAN, { assignment_id: 41 }),
        openWorkspace(fresh.deps, JORDAN, { assignment_id: 41 })
      ]);
      assertEquals(c.coder_user_id, d.coder_user_id);
      assertEquals(fresh.coder.posts(/^\/users$/).length, 2, "both calls tried to create");
      assertEquals(fresh.coder.users.length, 2);
      assertEquals(fresh.db.accounts.length, 1);
    }
  }
);

Deno.test("a failed user create with no user behind it is not swallowed", async () => {
  const { coder, deps } = setup();
  const realFetch = coder.fetch;
  deps.coder.fetch = async (input, init) =>
    init?.method === "POST" && new URL(String(input)).pathname === "/api/v2/users"
      ? new Response(JSON.stringify({ message: "Internal error creating user." }), { status: 500 })
      : await realFetch(input, init);
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), Error, "Coder user create failed: 500");
});

Deno.test("a failed clone returns the failing step, the clone script's reason and its last log lines", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = {
    lifecycle_state: "start_error",
    status: "connected",
    scripts: [
      { display_name: "Startup Script", status: "ok", exit_code: 0, log_source_id: "src-startup" },
      { display_name: "Git Clone", status: "exit_failure", exit_code: 1, log_source_id: "src-clone" }
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
  coder.logs.push({
    id: 201,
    output: "Git Clone failed: git clone exited with 128",
    source_id: "src-clone",
    level: "info"
  });

  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "failed");
  assertEquals(res.step, "clone");
  // The script exits 1 on every failure, so the reason is its "Git Clone failed:" line.
  assertEquals(res.message, "Git Clone failed: git clone exited with 128");
  assertEquals(res.failure!.script, "Git Clone");
  assertEquals(res.failure!.exit_code, 1);
  assertEquals(res.failure!.log_lines.length, 20);
  assertEquals(res.failure!.log_lines.slice(-2), [
    "fatal: repository 'https://git.example.com/cs3500/nope.git/' not found",
    "Git Clone failed: git clone exited with 128"
  ]);
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

Deno.test("the reason is the clone script's own line, and other scripts report their exit code", async () => {
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = failedClone();
  const link =
    "Git Clone failed: the workspace owner hasn't linked their forgejo account: https://coder.example.com/external-auth/forgejo";
  coder.logs = [
    { id: 1, output: "Git Clone failed: an earlier start's reason", source_id: "src-clone", level: "info" },
    { id: 2, output: link, source_id: "src-clone", level: "info" },
    { id: 3, output: "Git Clone failed: another script's line", source_id: "src-other", level: "info" }
  ];
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.step, "clone");
  assertEquals(res.message, link);

  // No reason line (Coder's own backstop killed the script): the exit code, not a guess.
  coder.logs = [
    { id: 4, output: "Cloning https://git.example.com/cs3500/hw1-alex.git...", source_id: "src-clone", level: "info" }
  ];
  assertEquals(
    (await workspaceStatus(deps, ALEX, { assignment_id: 41 })).message,
    '"Git Clone" failed with exit code 1.'
  );

  const { coder: coder2, deps: deps2 } = setup();
  await openWorkspace(deps2, ALEX, { assignment_id: 41 });
  signInAndLink(coder2, ALEX);
  coder2.nextAgent = {
    lifecycle_state: "start_error",
    status: "connected",
    scripts: [{ display_name: "Startup Script", status: "exit_failure", exit_code: 7, log_source_id: "src-startup" }]
  };
  coder2.logs = [{ id: 1, output: "Git Clone failed: not this script", source_id: "src-startup", level: "info" }];
  const startup = await openWorkspace(deps2, ALEX, { assignment_id: 41 });
  assertEquals(startup.step, "editor");
  assertEquals(startup.message, '"Startup Script" failed with exit code 7.');
});

Deno.test("repo_url is <FORGEJO_URL>/<owner>/<repo>.git, and a name the template refuses creates nothing", async () => {
  const { coder, db, deps } = setup();
  db.repos[0] = repo(501, "prof-alex", null, "cs3500/hw1_alex.v2");
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "starting");
  assertEquals(coder.posts(/\/workspaces$/)[0].body!.rich_parameter_values, [
    { name: "repo_url", value: "https://git.example.com/cs3500/hw1_alex.v2.git" }
  ]);

  for (const name of [
    "",
    "cs3500",
    "cs3500/",
    "/hw1",
    "cs3500/.coder-modules",
    "cs3500/hw1/extra",
    "cs 3500/hw1",
    "cs3500/hw1?x=1",
    "cs--3500/hw1",
    "cs3500-/hw1"
  ]) {
    const t = setup();
    t.db.repos[0] = repo(501, "prof-alex", null, name);
    await assertRejects(() => openWorkspace(t.deps, ALEX, { assignment_id: 41 }), IllegalArgumentError);
    assertEquals(
      t.coder.calls.filter((c) => c.method === "POST"),
      [],
      `nothing is created for "${name}"`
    );
    assertEquals(t.db.rows.length, 0);
  }
});

Deno.test("gitCredentialsFile: distinct repositories get distinct files, split at the first --", () => {
  assertEquals(gitCredentialsFile("cs3500/hw1-alex"), "/home/coder/.git-credentials-cs3500--hw1-alex");
  // The only owner/name pair that could share a file with a/b--c is a--b/c, and no Forgejo owner has "--".
  assertEquals(gitCredentialsFile("a/b--c"), "/home/coder/.git-credentials-a--b--c");
  for (const owner of ["a--b", "a-_b", "a..b", "a-", "a."]) {
    let threw = false;
    try {
      gitCredentialsFile(`${owner}/c`);
    } catch (e) {
      threw = e instanceof IllegalArgumentError;
    }
    assert(threw, owner);
  }
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
        subdomain_name: "code-server--repo-501--alex-kim-1a2b3c4d5e6f",
        health: "healthy"
      }
    ]
  };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "ready");
  assertEquals(
    res.redirect_url,
    "https://code-server--repo-501--alex-kim-1a2b3c4d5e6f.coder.example.com/?folder=/home/coder/hw1-alex"
  );
});

Deno.test("authorization: only the caller's own or group repository, on a known host, while enrolled", async () => {
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
  // A host no template accepts, and bad ids.
  db.assignments.push({ id: 43, class_id: 7, git_provider: "gitlab" });
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 43 }), IllegalArgumentError);
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

Deno.test("workspace-open refuses a course without cloud-workspaces, and creates nothing", async () => {
  const { coder, db, deps } = setup();
  for (const features of [
    null,
    [],
    [{ name: "cloud-workspaces", enabled: false }],
    [{ name: "cloud-workspaces", enabled: "true" }],
    [
      { name: "cloud-workspaces", enabled: false },
      { name: "cloud-workspaces", enabled: true }
    ]
  ]) {
    db.features[7] = features;
    const err = await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
    assertEquals([err.status, err.details], [403, "Cloud workspaces are not enabled for this course"]);
  }
  assertEquals(coder.calls.length, 0, "Coder is never called");
  assertEquals(db.accounts.length + db.rows.length, 0);
  // Not enrolled still reads as not enrolled.
  await assertRejects(
    () => openWorkspace(deps, { ...JORDAN, userId: "00000000-0000-4000-8000-0000000000ee" }, { assignment_id: 41 }),
    SecurityError
  );
});

Deno.test("workspace-status creates nothing", async () => {
  const { coder, db, deps } = setup();
  assertEquals(await workspaceStatus(deps, ALEX, { assignment_id: 41 }), { status: "not_started" });
  assertEquals(coder.calls.length, 0);
  assertEquals(db.accounts.length + db.rows.length, 0);
});

Deno.test("a group change opens a new workspace for the new repository and supersedes the old one", async () => {
  const { coder, db, deps } = setup();
  db.repos.push(repo(600, null, 77, "cs3500/group77"), repo(601, null, 88, "cs3500/group88"));
  db.groups.push({ assignment_id: 41, profile_id: "prof-alex", group_id: 77 });
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  const in77 = await openWorkspace(deps, ALEX, { assignment_id: 41 });

  // Staff move Alex from group 77 to group 88.
  db.groups[0].group_id = 88;
  const in88 = await openWorkspace(deps, ALEX, { assignment_id: 41, repository_id: 601 });
  assert(in88.workspace_id !== in77.workspace_id, "never the old group's workspace");
  assertEquals(in88.workspace_name, "repo-601");
  const ws88 = coder.workspaces.find((w) => w.id === in88.workspace_id) as CoderWorkspace & { repo_url: string };
  assertEquals(ws88.repo_url, "https://git.example.com/cs3500/group88.git");
  assertEquals(coder.workspaces.length, 2, "the old workspace is kept: it may hold unpushed work");
  const [row77, row88] = db.rows;
  assertEquals([row77.repository_id, row88.repository_id], [600, 601]);
  assert(row77.superseded_at !== null, "the cleanup job deletes the old one after 14 days");
  assertEquals(row88.superseded_at, null);

  // Status reads resolve by repository too, with or without the id.
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).workspace_id, in88.workspace_id);
  // Group 77's repository is no longer Alex's.
  await assertRejects(() => workspaceStatus(deps, ALEX, { assignment_id: 41, repository_id: 600 }), SecurityError);

  // Moving back reuses the first workspace and supersedes the second.
  db.groups[0].group_id = 77;
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).workspace_id, in77.workspace_id);
  assertEquals(db.rows[0].superseded_at, null);
  assert(db.rows[1].superseded_at !== null);
});

function failedClone(): Partial<CoderAgent> {
  return {
    lifecycle_state: "start_error",
    status: "connected",
    scripts: [{ display_name: "Git Clone", status: "exit_failure", exit_code: 1, log_source_id: "src-clone" }]
  };
}

function readyAgent(status = "connected"): Partial<CoderAgent> {
  return {
    lifecycle_state: "ready",
    status,
    scripts: [{ display_name: "Git Clone", status: "ok", exit_code: 0, log_source_id: "s" }],
    apps: [{ slug: "code-server", subdomain: false, health: "healthy" }]
  };
}

Deno.test("open restarts a workspace whose startup failed (stop, then start); a status read doesn't", async () => {
  for (const lifecycle_state of ["start_error", "start_timeout"]) {
    const { coder, db, deps } = setup();
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    signInAndLink(coder, ALEX);
    coder.nextAgent = { ...failedClone(), lifecycle_state };
    const failed = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(failed.status, "failed");

    // Reading the status never builds anything.
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "failed");
    assertEquals(coder.posts(/\/builds$/).length, 0);

    // Forgejo is back: the next open stops the workspace, waits, and starts it again.
    coder.autoBuild = true;
    coder.nextAgent = readyAgent();
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(
      coder.posts(/\/builds$/).map((c) => c.body),
      [{ transition: "stop" }, { transition: "start", template_version_id: TEMPLATE.active_version_id }]
    );
    assertEquals(res.workspace_id, failed.workspace_id, "the same workspace, so the same home volume");
    assertEquals(res.status, "ready");
    assertEquals(db.rows[0].restart_started_at, null);
  }
});

Deno.test("two opens of a failed workspace restart it once", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = failedClone();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.autoBuild = true;
  coder.nextAgent = readyAgent();
  const [a, b] = await Promise.all([
    openWorkspace(deps, ALEX, { assignment_id: 41 }),
    openWorkspace(deps, ALEX, { assignment_id: 41 })
  ]);
  assertEquals(db.restartClaims, 1);
  assertEquals(
    coder.posts(/\/builds$/).map((c) => c.body),
    [{ transition: "stop" }, { transition: "start", template_version_id: TEMPLATE.active_version_id }]
  );
  assertEquals(new Set([a.status, b.status]), new Set(["ready", "restarting"]), "the other call says restarting");
});

/** A workspace whose clone failed, so the next open restarts it; the fake's builds then stay pending. */
async function failedWorkspace() {
  const t = setup();
  await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
  signInAndLink(t.coder, ALEX);
  t.coder.nextAgent = failedClone();
  await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
  t.coder.nextAgent = readyAgent();
  return t;
}

const buildPosts = (coder: FakeCoder) => coder.posts(/\/builds$/).map((c) => c.body!.transition);

Deno.test(
  "a slow stop: open answers restarting within 20 s, counting each call's time, a status read posts the start, then ready",
  async () => {
    const { clock, coder, db, deps } = await failedWorkspace();
    // Every Coder call takes a second, and the stop doesn't finish while open waits.
    coder.latencyMs = 1_000;
    const t0 = clock.t;
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    const spent = clock.t - t0;
    assert(spent <= 20_000, `open took ${spent} ms; Kong gives up at 60 s`);
    assert(spent >= 15_000, `open gave the stop most of its budget (${spent} ms)`);
    assertEquals([res.status, res.step, res.build!.transition], ["restarting", "build", "stop"]);
    assertEquals(buildPosts(coder), ["stop"]);
    const claim = db.rows[0].restart_started_at;
    assert(claim !== null, "the claim stays while the stop runs");

    // Still stopping: status reads say restarting and post nothing.
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "restarting");
    assertEquals(buildPosts(coder), ["stop"]);

    // The stop finishes. The next status read posts the start and gives up the claim.
    coder.workspaces[0].latest_build.status = "stopped";
    const started = await workspaceStatus(deps, ALEX, { assignment_id: 41 });
    assertEquals(buildPosts(coder), ["stop", "start"]);
    assertEquals([started.status, started.build!.transition, started.build!.status], ["starting", "start", "pending"]);
    assertEquals(db.rows[0].restart_started_at, null);

    // Later reads see the start build, and nothing posts another.
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
    coder.autoBuild = true;
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals(buildPosts(coder), ["stop", "start"]);
  }
);

Deno.test("a restart's start is posted once, by whichever call swaps the claim first", async () => {
  // Two status reads, or a status read and an open, after the stop finished.
  for (const second of [workspaceStatus, openWorkspace]) {
    const { coder, db, deps } = await failedWorkspace();
    coder.latencyMs = 1_000;
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    coder.latencyMs = 0;
    coder.workspaces[0].latest_build.status = "stopped";
    const [a, b] = await Promise.all([
      workspaceStatus(deps, ALEX, { assignment_id: 41 }),
      second(deps, ALEX, { assignment_id: 41 })
    ]);
    assertEquals(buildPosts(coder), ["stop", "start"]);
    if (second === workspaceStatus) {
      // The two reads run in step: the loser saw the stopped workspace while the winner held the
      // claim to post the start.
      assertEquals(new Set([a.status, b.status]), new Set(["starting", "restarting"]));
    } else {
      assertEquals(a.status, "starting");
      assert(["starting", "restarting"].includes(b.status), b.status);
    }
    assertEquals(db.rows[0].restart_started_at, null);
  }
});

Deno.test("an open whose stop finishes within its budget starts the workspace itself", async () => {
  const { coder, db, deps } = await failedWorkspace();
  coder.autoBuild = true;
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(buildPosts(coder), ["stop", "start"]);
  assertEquals(res.status, "ready");
  assertEquals(db.rows[0].restart_started_at, null);
});

Deno.test("a stop that finishes as the budget runs out: open leaves the start to a status read", async () => {
  const { clock, coder, db, deps } = await failedWorkspace();
  coder.latencyMs = 1_000;
  const t0 = clock.t;
  // The stop finishes on the read that starts 16 s in and ends at 17 s, when too little time is left
  // for the start.
  const base = coder.fetch;
  deps.coder.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
    const build = coder.workspaces[0].latest_build;
    if (isWorkspaceRead(init?.method ?? "GET", path) && build.transition === "stop" && clock.t - t0 >= 16_000) {
      build.status = "stopped";
    }
    return await base(input, init);
  };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals([res.status, res.build!.transition, res.build!.status], ["restarting", "stop", "stopped"]);
  assertEquals(buildPosts(coder), ["stop"]);
  assertEquals(db.rows[0].restart_phase, "stopping");
  assert(clock.t - t0 <= 20_000, `open took ${clock.t - t0} ms`);

  coder.latencyMs = 0;
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals(buildPosts(coder), ["stop", "start"]);
});

Deno.test("a course that turns cloud-workspaces off: a status read doesn't finish the restart", async () => {
  const { coder, db, deps } = await failedWorkspace();
  coder.latencyMs = 1_000;
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.latencyMs = 0;
  coder.workspaces[0].latest_build.status = "stopped";
  assertEquals(db.rows[0].restart_phase, "stopping", "a status read would post the start");

  db.features[7] = [{ name: "cloud-workspaces", enabled: false }];
  const calls = coder.calls.length;
  const err = await assertRejects(() => workspaceStatus(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
  assertEquals(err.status, 403);
  await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
  assertEquals(coder.calls.length, calls, "Coder is never called");
  assertEquals(buildPosts(coder), ["stop"]);
  assertEquals(db.rows[0].restart_phase, "stopping");

  db.features[7] = [{ name: "cloud-workspaces", enabled: true }];
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals(buildPosts(coder), ["stop", "start"]);
});

Deno.test(
  "a failed start gives the claim up: the workspace reads not_started and the next open starts it",
  async () => {
    const { coder, db, deps } = await failedWorkspace();
    coder.latencyMs = 1_000;
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    coder.latencyMs = 0;
    coder.workspaces[0].latest_build.status = "stopped";
    const realFetch = coder.fetch;
    deps.coder.fetch = async (input, init) =>
      init?.method === "POST" && String(init.body).includes('"start"')
        ? new Response(JSON.stringify({ message: "Internal error creating workspace build." }), { status: 500 })
        : await realFetch(input, init);
    await assertRejects(() => workspaceStatus(deps, ALEX, { assignment_id: 41 }), Error, "workspace start failed: 500");
    assertEquals(db.rows[0].restart_started_at, null);
    // Nothing is starting, so nothing says it is.
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "not_started");

    deps.coder.fetch = realFetch;
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
    assertEquals(buildPosts(coder), ["stop", "start"]);
  }
);

Deno.test("an abandoned claim expires: the workspace reads as it is, and the next restart retakes it", async () => {
  assertEquals(RESTART_CLAIM_MS, 60_000, "a holder's 20 s budget plus a margin");
  const { clock, coder, db, deps } = await failedWorkspace();
  holdClaim(db.rows[0], new Date(clock.t - RESTART_CLAIM_MS - 1).toISOString(), "stopping");
  // A stale `stopping` claim on a workspace that isn't stopped: its stop never reached Coder. It
  // doesn't say restarting, and a status read doesn't act on it; only an open restarts.
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "failed");
  assertEquals(buildPosts(coder), []);
  // Its stop did finish: a status read finishes the restart as usual.
  const ws = coder.workspaces[0];
  ws.latest_build = { ...ws.latest_build, transition: "stop", status: "stopped", resources: [] };
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals(buildPosts(coder), ["start"]);
  assertEquals(db.rows[0].restart_token, null);

  // A fresh claim held by another call: open waits for it instead of restarting.
  const { clock: clock2, coder: coder2, db: db2, deps: deps2 } = await failedWorkspace();
  holdClaim(db2.rows[0], clock2.iso(), "stopping");
  assertEquals((await openWorkspace(deps2, ALEX, { assignment_id: 41 })).status, "restarting");
  assertEquals(buildPosts(coder2), []);
  // Once it's stale, the next open takes it and restarts.
  clock2.t += RESTART_CLAIM_MS + 1;
  coder2.autoBuild = true;
  assertEquals((await openWorkspace(deps2, ALEX, { assignment_id: 41 })).status, "ready");
  assertEquals(buildPosts(coder2), ["stop", "start"]);
  assertEquals(db2.rows[0].restart_started_at, null);

  // Stopped, with the claim in either phase and its holder gone. A fresh `starting` claim has its
  // poster, so nothing else posts. Once stale, a status read retakes it, posts the start and clears
  // the claim, and an open after it posts nothing.
  for (const phase of ["stopping", "starting"] as const) {
    const { clock: clock3, coder: coder3, db: db3, deps: deps3 } = await stoppedRestart();
    holdClaim(db3.rows[0], clock3.iso(), phase);
    if (phase === "starting") {
      assertEquals((await workspaceStatus(deps3, ALEX, { assignment_id: 41 })).status, "restarting");
      assertEquals((await openWorkspace(deps3, ALEX, { assignment_id: 41 })).status, "restarting");
      assertEquals(buildPosts(coder3), ["stop"]);
    }
    clock3.t += RESTART_CLAIM_MS + 1;
    assertEquals((await workspaceStatus(deps3, ALEX, { assignment_id: 41 })).status, "starting", phase);
    assertEquals(db3.rows[0].restart_phase, null, phase);
    assertEquals((await openWorkspace(deps3, ALEX, { assignment_id: 41 })).status, "starting", phase);
    assertEquals(buildPosts(coder3), ["stop", "start"], phase);
  }

  // A stop that outlasts its claim (a pod held by a finalizer) still reads restarting, and nothing
  // posts until it finishes.
  const { clock: clock4, coder: coder4, db: db4, deps: deps4 } = await failedWorkspace();
  coder4.latencyMs = 1_000;
  assertEquals((await openWorkspace(deps4, ALEX, { assignment_id: 41 })).status, "restarting");
  coder4.latencyMs = 0;
  clock4.t += RESTART_CLAIM_MS + 1;
  assertEquals((await workspaceStatus(deps4, ALEX, { assignment_id: 41 })).status, "restarting");
  assertEquals((await openWorkspace(deps4, ALEX, { assignment_id: 41 })).status, "restarting");
  assertEquals(buildPosts(coder4), ["stop"]);
  coder4.workspaces[0].latest_build.status = "stopped";
  assertEquals((await workspaceStatus(deps4, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals([buildPosts(coder4), db4.rows[0].restart_token], [["stop", "start"], null]);
});

/**
 * A restart whose stop outlasted the open: the open answered restarting and holds the claim in
 * `stopping`, and the stop has since finished.
 */
async function stoppedRestart() {
  const t = await failedWorkspace();
  t.coder.latencyMs = 1_000;
  assertEquals((await openWorkspace(t.deps, ALEX, { assignment_id: 41 })).status, "restarting");
  t.coder.latencyMs = 0;
  t.coder.workspaces[0].latest_build.status = "stopped";
  assertEquals(t.db.rows[0].restart_phase, "stopping");
  return t;
}

/**
 * A fetch that holds the first request `match` picks before it reaches Coder, until release() is
 * called: a request delayed on the network.
 */
function holdFirst(base: typeof fetch, match: (method: string, path: string, body: string) => boolean) {
  let release!: () => void;
  let arrived!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrived = r));
  let held = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
    if (!held && match(init?.method ?? "GET", path, String(init?.body ?? ""))) {
      held = true;
      arrived();
      await released;
    }
    return await base(input, init);
  };
  return { fetch, reached, release };
}

/**
 * Like holdFirst, but Coder has answered and the reply is what waits: the caller goes on with a
 * state that may no longer hold when it gets it.
 */
function holdFirstReply(base: typeof fetch, match: (method: string, path: string, body: string) => boolean) {
  let release!: () => void;
  let arrived!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrived = r));
  let held = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
    const res = await base(input, init);
    if (!held && match(init?.method ?? "GET", path, String(init?.body ?? ""))) {
      held = true;
      arrived();
      await released;
    }
    return res;
  };
  return { fetch, reached, release };
}

const isStartPost = (method: string, path: string, body: string) =>
  method === "POST" && path.endsWith("/builds") && body.includes('"start"');
const isWorkspaceRead = (method: string, path: string) => method === "GET" && /^\/workspaces\/[^/]+$/.test(path);
/**
 * Matches workspace reads once a stop has been posted: the reads a restart waits on. A restart reads
 * the workspace once before its stop too, with the claim held, to see that it still needs one.
 */
function readAfterStop() {
  let stopPosted = false;
  return (method: string, path: string, body: string) => {
    if (method === "POST" && path.endsWith("/builds") && body.includes('"stop"')) stopPosted = true;
    return stopPosted && isWorkspaceRead(method, path);
  };
}

function holding(deps: Deps, fetch: typeof globalThis.fetch): Deps {
  return { ...deps, coder: { ...deps.coder, fetch } };
}

Deno.test("a held start: the call that took the claim posts the only start, in every order", async () => {
  // The review's interleaving: A takes the claim and its start POST is held before it reaches Coder.
  // B runs to the end, and any build has time to finish. Then A's POST goes through.
  const callers = { "status read": workspaceStatus, open: openWorkspace };
  for (const [aName, a] of Object.entries(callers)) {
    for (const [bName, b] of Object.entries(callers)) {
      for (const buildsFinish of [false, true]) {
        const what = `A ${aName}, B ${bName}${buildsFinish ? ", builds finish" : ""}`;
        const { coder, db, deps } = await stoppedRestart();
        const held = holdFirst(coder.fetch, isStartPost);
        const first = a(holding(deps, held.fetch), ALEX, { assignment_id: 41 });
        await held.reached;
        assertEquals(db.rows[0].restart_phase, "starting", what);

        assertEquals((await b(deps, ALEX, { assignment_id: 41 })).status, "restarting", what);
        if (buildsFinish) {
          coder.autoBuild = true;
          assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "restarting", what);
        }
        assertEquals(buildPosts(coder), ["stop"], what);

        held.release();
        assertEquals((await first).status, buildsFinish ? "ready" : "starting", what);
        coder.autoBuild = true;
        assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "ready", what);
        assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready", what);
        assertEquals(buildPosts(coder), ["stop", "start"], what);
        assertEquals(db.rows[0].restart_token, null, what);
      }
    }
  }
});

Deno.test("a status read takes over the open's restart: the open doesn't post a start after it", async () => {
  // The open has posted its stop and its next read is held. Meanwhile the stop finishes and a status
  // read takes the claim, holding its own start POST. Then the two go on in each order.
  for (const order of ["open first", "status read first", "status read first, start finished"]) {
    const { coder, db, deps } = await failedWorkspace();
    const openRead = holdFirst(coder.fetch, readAfterStop());
    const open = openWorkspace(holding(deps, openRead.fetch), ALEX, { assignment_id: 41 });
    await openRead.reached;
    assertEquals([buildPosts(coder), db.rows[0].restart_phase], [["stop"], "stopping"], order);
    coder.workspaces[0].latest_build.status = "stopped";

    const readStart = holdFirst(coder.fetch, isStartPost);
    const read = workspaceStatus(holding(deps, readStart.fetch), ALEX, { assignment_id: 41 });
    await readStart.reached;
    assertEquals(db.rows[0].restart_phase, "starting", order);

    if (order === "open first") {
      openRead.release();
      assertEquals((await open).status, "restarting", order);
      assertEquals(buildPosts(coder), ["stop"], order);
      readStart.release();
      assertEquals((await read).status, "starting", order);
    } else {
      readStart.release();
      assertEquals((await read).status, "starting", order);
      if (order.endsWith("start finished")) coder.autoBuild = true;
      openRead.release();
      assertEquals((await open).status, order.endsWith("start finished") ? "ready" : "starting", order);
    }
    coder.autoBuild = true;
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "ready", order);
    assertEquals(buildPosts(coder), ["stop", "start"], order);
    assertEquals(db.rows[0].restart_token, null, order);
  }

  // And the open's own start, held after it took the claim: a status read posts nothing.
  const { coder, db, deps } = await failedWorkspace();
  coder.autoBuild = true;
  const openStart = holdFirst(coder.fetch, isStartPost);
  const open = openWorkspace(holding(deps, openStart.fetch), ALEX, { assignment_id: 41 });
  await openStart.reached;
  assertEquals([coder.workspaces[0].latest_build.status, db.rows[0].restart_phase], ["stopped", "starting"]);
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "restarting");
  openStart.release();
  assertEquals((await open).status, "ready");
  assertEquals(buildPosts(coder), ["stop", "start"]);
});

/** Deps on real time, with a real budget that cuts off the fake Coder's calls (through `base`). */
function onRealTime(
  t: { clock: Clock; coder: FakeCoder; deps: Deps },
  budgetMs: number,
  base: typeof fetch = t.coder.fetch
): Deps {
  t.clock.now = Date.now;
  const budget = startBudget(budgetMs);
  return {
    ...t.deps,
    now: undefined,
    sleep: undefined,
    budget,
    coder: { ...t.deps.coder, fetch: budgetFetch(budget, base) }
  };
}

/** A fetch whose first request `match` picks never reaches Coder: it fails when its signal fires. */
function loseFirst(base: typeof fetch, match: (method: string, path: string, body: string) => boolean): typeof fetch {
  let lost = false;
  return async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
    if (!lost && match(init?.method ?? "GET", path, String(init?.body ?? ""))) {
      lost = true;
      const signal = init!.signal!;
      await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return await base(input, init);
  };
}

const isWorkspaceLookup = (method: string, path: string) => method === "GET" && /\/workspace\//.test(path);
const isBuildPost = (method: string, path: string) => method === "POST" && path.endsWith("/builds");

Deno.test(
  "a Coder call that hangs: open answers restarting within 20 s of real time, and a status read finishes",
  async () => {
    const t = await failedWorkspace();
    const { coder, db } = t;
    // The review's case: the read after the stop (the restart's second) takes 21 s to come back.
    let reads = 0;
    coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 1 ? 21_000 : 0);
    const deps = onRealTime(t, OPEN_BUDGET_MS);
    const t0 = Date.now();
    const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 }));
    const elapsed = Date.now() - t0;
    assert(elapsed < 20_500, `open answered after ${elapsed} ms`);
    assertEquals([res.status, res.step], ["restarting", "build"]);
    assertEquals(buildPosts(coder), ["stop"]);
    assertEquals(db.rows[0].restart_phase, "stopping", "left for a status read to finish");

    // The stop finishes; a later status read, with its own budget, posts the start.
    coder.workspaces[0].latest_build.status = "stopped";
    const read = onRealTime(t, OPEN_BUDGET_MS);
    assertEquals((await workspaceStatus(read, ALEX, { assignment_id: 41 })).status, "starting");
    coder.autoBuild = true;
    assertEquals((await workspaceStatus(read, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals(buildPosts(coder), ["stop", "start"]);
    assertEquals(db.rows[0].restart_token, null);
  }
);

Deno.test(
  "out of time elsewhere: a 504 within the budget; a status read whose start reply is lost settles",
  async () => {
    // A short budget: the signal fires 2 s before its 3 s.
    const t = await failedWorkspace();
    t.coder.slow = (method, path) => (path.endsWith("/templates/kubernetes") ? 10_000 : 0);
    const deps = onRealTime(t, 3_000);
    const t0 = Date.now();
    const err = await assertRejects(
      () => withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 })),
      UserVisibleError
    );
    assert(Date.now() - t0 < 3_000, `answered after ${Date.now() - t0} ms`);
    assertEquals(err.status, 504);
    assertEquals(buildPosts(t.coder), []);

    // A status read posts the start, but Coder's reply doesn't come back in time. The budget leaves
    // the 5 s a claim needs.
    const r = await stoppedRestart();
    r.coder.slow = (method, path) => (method === "POST" && path.endsWith("/builds") ? 10_000 : 0);
    const read = onRealTime(r, 6_000);
    const t1 = Date.now();
    const res = await withinBudget(read.budget!, () => workspaceStatus(read, ALEX, { assignment_id: 41 }));
    assert(Date.now() - t1 < 6_000, `answered after ${Date.now() - t1} ms`);
    assertEquals(res.status, "restarting");
    assertEquals(r.db.rows[0].restart_phase, "starting", "the start may have reached Coder");
    // It did: the next read sees its build, gives the claim up, and nothing else posts a start.
    r.coder.slow = undefined;
    assertEquals((await workspaceStatus(r.deps, ALEX, { assignment_id: 41 })).status, "starting");
    assertEquals(r.db.rows[0].restart_token, null);
    r.coder.autoBuild = true;
    assertEquals((await workspaceStatus(r.deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals((await openWorkspace(r.deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals(buildPosts(r.coder), ["stop", "start"]);
  }
);

Deno.test("a status read takes the claim only with time to post the start, and a lost start is retaken", async () => {
  // The review's repro A: the workspace read comes back with too little of a 6 s budget left (its
  // signal fires at 4 s), and the start POST would never reach Coder.
  const r = await stoppedRestart();
  let reads = 0;
  r.coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 0 ? 1_500 : 0);
  const late = onRealTime(r, 6_000, loseFirst(r.coder.fetch, isStartPost));
  const res = await withinBudget(late.budget!, () => workspaceStatus(late, ALEX, { assignment_id: 41 }));
  assertEquals(res.status, "restarting");
  assertEquals([buildPosts(r.coder), r.db.rows[0].restart_phase], [["stop"], "stopping"], "left for the next read");
  r.coder.slow = undefined;
  assertEquals((await workspaceStatus(r.deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals([buildPosts(r.coder), r.db.rows[0].restart_token], [["stop", "start"], null]);

  // A read with time to spare whose start still never reaches Coder: the claim is `starting` with no
  // build behind it. Its holder may still be posting, so nothing else does until the claim is stale.
  const s = await stoppedRestart();
  const lossy = onRealTime(s, 6_000, loseFirst(s.coder.fetch, isStartPost));
  const lost = await withinBudget(lossy.budget!, () => workspaceStatus(lossy, ALEX, { assignment_id: 41 }));
  assertEquals(lost.status, "restarting");
  assertEquals([buildPosts(s.coder), s.db.rows[0].restart_phase], [["stop"], "starting"]);
  const takenAt = Date.parse(s.db.rows[0].restart_started_at!);
  s.clock.t = takenAt + RESTART_CLAIM_MS - 1_000;
  assertEquals((await workspaceStatus(s.deps, ALEX, { assignment_id: 41 })).status, "restarting");
  assertEquals((await openWorkspace(s.deps, ALEX, { assignment_id: 41 })).status, "restarting");
  assertEquals(buildPosts(s.coder), ["stop"]);
  // Stale: the holder answered long ago. A status read retakes the claim and posts the start.
  s.clock.t = takenAt + RESTART_CLAIM_MS + 1;
  assertEquals((await workspaceStatus(s.deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals([buildPosts(s.coder), s.db.rows[0].restart_token], [["stop", "start"], null]);
  assertEquals((await openWorkspace(s.deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals(buildPosts(s.coder), ["stop", "start"]);
});

Deno.test("an open takes the restart claim only with time to post the stop", async () => {
  // The review's repro B: the workspace lookup comes back with too little of a 6 s budget left, and
  // the stop POST would never reach Coder.
  const t = await failedWorkspace();
  let lookups = 0;
  t.coder.slow = (method, path) => (isWorkspaceLookup(method, path) && lookups++ === 0 ? 1_500 : 0);
  const deps = onRealTime(t, 6_000, loseFirst(t.coder.fetch, isBuildPost));
  const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 }));
  assertEquals(res.status, "restarting");
  assertEquals([buildPosts(t.coder), t.db.rows[0].restart_phase], [[], null], "no claim for anyone to wait on");
  // The workspace reads as it is, and the next open restarts it.
  t.coder.slow = undefined;
  assertEquals((await workspaceStatus(t.deps, ALEX, { assignment_id: 41 })).status, "failed");
  t.coder.autoBuild = true;
  assertEquals((await openWorkspace(t.deps, ALEX, { assignment_id: 41 })).status, "ready");
  assertEquals([buildPosts(t.coder), t.db.rows[0].restart_token], [["stop", "start"], null]);
});

Deno.test("a cut-off restart on a row without the workspace id: the id is recorded first", async () => {
  // The review's repro D. An earlier open's create was cut off after Coder made the workspace, so
  // the row has no id, and this open's restart is cut off on the read after its stop (its second).
  const t = await failedWorkspace();
  t.db.rows[0].coder_workspace_id = null;
  let reads = 0;
  t.coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 1 ? 10_000 : 0);
  const deps = onRealTime(t, 6_000);
  const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 }));
  assertEquals(res.status, "restarting");
  assertEquals(
    [t.db.rows[0].coder_workspace_id, t.db.rows[0].restart_phase, buildPosts(t.coder)],
    [t.coder.workspaces[0].id, "stopping", ["stop"]]
  );
  // The stop finishes, and a status read finds the workspace and posts the start.
  t.coder.slow = undefined;
  t.coder.workspaces[0].latest_build.status = "stopped";
  assertEquals((await workspaceStatus(t.deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals([buildPosts(t.coder), t.db.rows[0].restart_token], [["stop", "start"], null]);
});

Deno.test(
  "a restart cut off before its stop: the claim reads restarting until it is stale, then an open retakes it",
  async () => {
    // The read a restart makes with the claim held, before its stop, doesn't come back in time. No
    // stop was posted, and the claim can't be given up: the budget has cut the database off too.
    const t = await failedWorkspace();
    let reads = 0;
    t.coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 0 ? 10_000 : 0);
    const deps = onRealTime(t, 6_000);
    const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 }));
    assertEquals([res.status, t.db.rows[0].restart_phase, buildPosts(t.coder)], ["restarting", "stopping", []]);

    // Like a stop that never reached Coder: nothing acts on the claim while its holder may be alive.
    t.coder.slow = undefined;
    assertEquals((await workspaceStatus(t.deps, ALEX, { assignment_id: 41 })).status, "restarting");
    assertEquals((await openWorkspace(t.deps, ALEX, { assignment_id: 41 })).status, "restarting");
    assertEquals(buildPosts(t.coder), []);
    // Once it is stale the workspace reads as it is, and the next open restarts it.
    t.clock.t = Date.now() + RESTART_CLAIM_MS + 1;
    assertEquals((await workspaceStatus(t.deps, ALEX, { assignment_id: 41 })).status, "failed");
    t.coder.autoBuild = true;
    assertEquals((await openWorkspace(t.deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals([buildPosts(t.coder), t.db.rows[0].restart_token], [["stop", "start"], null]);
  }
);

Deno.test("an open that read the claim before it went stale doesn't post a start a status read took", async () => {
  // The review's double-start window, at the claim's expiry. The open reads the row and its lookup
  // is held; a status read takes the claim over and its start is held; the open goes on with the
  // claim it read, now stale, on a workspace that still reads stopped.
  const { clock, coder, db, deps } = await stoppedRestart();
  const claimedAt = Date.parse(db.rows[0].restart_started_at!);
  clock.t = claimedAt + RESTART_CLAIM_MS - 1;
  const lookup = holdFirst(coder.fetch, isWorkspaceLookup);
  const open = openWorkspace(holding(deps, lookup.fetch), ALEX, { assignment_id: 41 });
  await lookup.reached;
  const readStart = holdFirst(coder.fetch, isStartPost);
  const read = workspaceStatus(holding(deps, readStart.fetch), ALEX, { assignment_id: 41 });
  await readStart.reached;
  assertEquals(db.rows[0].restart_phase, "starting");

  clock.t = claimedAt + RESTART_CLAIM_MS + 1;
  lookup.release();
  assertEquals((await open).status, "restarting");
  assertEquals(buildPosts(coder), ["stop"]);
  readStart.release();
  assertEquals((await read).status, "starting");
  assertEquals([buildPosts(coder), db.rows[0].restart_token], [["stop", "start"], null]);
});

Deno.test("an open that read the failed workspace before another open restarted it doesn't stop it again", async () => {
  const { coder, db, deps } = await failedWorkspace();
  coder.autoBuild = true;
  // B's lookup answers with the failed workspace, and the answer is held on its way back.
  const lookup = holdFirstReply(coder.fetch, isWorkspaceLookup);
  const b = openWorkspace(holding(deps, lookup.fetch), ALEX, { assignment_id: 41 });
  await lookup.reached;
  // A restarts the workspace and gives its claim up.
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready");
  assertEquals(buildPosts(coder), ["stop", "start"]);
  // B takes the free claim, reads the workspace again, and finds nothing to restart.
  lookup.release();
  assertEquals((await b).status, "ready");
  assertEquals(buildPosts(coder), ["stop", "start"], "the recovered workspace is left running");
  assertEquals(db.rows[0].restart_token, null);
});

Deno.test("an open whose row predates another open's restart claim doesn't post a start beside it", async () => {
  const { coder, db, deps } = await failedWorkspace();
  coder.autoBuild = true;
  // A has read its row, with no claim on it, and its workspace lookup is held on the way to Coder.
  const lookup = holdFirst(coder.fetch, isWorkspaceLookup);
  const a = openWorkspace(holding(deps, lookup.fetch), ALEX, { assignment_id: 41 });
  await lookup.reached;
  // B restarts the workspace: its stop finishes, it takes the claim to `starting`, and its start is
  // held on the way to Coder.
  const start = holdFirst(coder.fetch, isStartPost);
  const b = openWorkspace(holding(deps, start.fetch), ALEX, { assignment_id: 41 });
  await start.reached;
  assertEquals([db.rows[0].restart_phase, buildPosts(coder)], ["starting", ["stop"]]);

  // A now finds the workspace stopped. The row it read says nobody holds a claim, and a start
  // posted on that would run beside B's.
  lookup.release();
  assertEquals((await a).status, "restarting");
  assertEquals(buildPosts(coder), ["stop"], "the start is B's to post");
  start.release();
  assertEquals((await b).status, "ready");
  assertEquals([buildPosts(coder), db.rows[0].restart_token], [["stop", "start"], null]);
});

Deno.test("an open whose lookup reply is older than another open's claim leaves that claim alone", async () => {
  const { coder, db, deps } = await failedWorkspace();
  coder.autoBuild = true;
  // A's lookup answers with the failed start build, and the answer is held on its way back.
  const lookup = holdFirstReply(coder.fetch, isWorkspaceLookup);
  const a = openWorkspace(holding(deps, lookup.fetch), ALEX, { assignment_id: 41 });
  await lookup.reached;
  // B stops the workspace and takes the claim to `starting`, and its start is held on the way to
  // Coder.
  const start = holdFirst(coder.fetch, isStartPost);
  const b = openWorkspace(holding(deps, start.fetch), ALEX, { assignment_id: 41 });
  await start.reached;
  const claim = db.rows[0].restart_token;
  assertEquals([db.rows[0].restart_phase, buildPosts(coder)], ["starting", ["stop"]]);

  // A goes on with a start build that isn't B's: it must not take that build for B's start and
  // give B's claim up. The claim stays, and A posts nothing.
  lookup.release();
  assertEquals((await a).status, "restarting");
  assertEquals([db.rows[0].restart_token, buildPosts(coder)], [claim, ["stop"]]);
  start.release();
  assertEquals((await b).status, "ready");
  assertEquals([buildPosts(coder), db.rows[0].restart_token], [["stop", "start"], null]);
});

Deno.test("an unhealthy editor is failed at the editor step, and open restarts the workspace", async () => {
  const { coder, db, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = readyAgent();
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready");

  // code-server is gone: the build is running and the agent connected and ready, but the app's
  // health check fails.
  coder.workspaces[0].latest_build.resources[0].agents![0].apps![0].health = "unhealthy";
  const res = await workspaceStatus(deps, ALEX, { assignment_id: 41 });
  assertEquals([res.status, res.step, res.message], ["failed", "editor", "VS Code did not start in the workspace."]);
  assertEquals(buildPosts(coder), [], "a status read restarts nothing");

  // The startup script that launches code-server runs only when the workspace starts, so the retry
  // is a restart.
  coder.autoBuild = true;
  const reopened = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(buildPosts(coder), ["stop", "start"]);
  assertEquals([reopened.status, db.rows[0].restart_token], ["ready", null]);
});

/**
 * A ready workspace with a stop under way that no workspace-open posted: Coder's autostop after an
 * hour unused, or a stop posted in Coder. `pending` is the stop build queued, `stopping` its job
 * running.
 */
async function stoppingWorkspace(status: "pending" | "stopping" = "stopping") {
  const t = setup();
  await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
  signInAndLink(t.coder, ALEX);
  t.coder.nextAgent = readyAgent();
  assertEquals((await openWorkspace(t.deps, ALEX, { assignment_id: 41 })).status, "ready");
  const ws = t.coder.workspaces[0];
  ws.latest_build = { ...ws.latest_build, transition: "stop", status, resources: [] };
  return t;
}

Deno.test("an open while a stop is under way is kept: restarting, and one start once the stop finishes", async () => {
  for (const status of ["pending", "stopping"] as const) {
    const { clock, coder, db, deps } = await stoppingWorkspace(status);
    // Nobody has asked for the workspace: a status read says not_started and keeps nothing.
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "not_started", status);
    assertEquals(db.rows[0].restart_token, null);

    // The stop outlasts the open, which answers within its budget and leaves its claim.
    coder.latencyMs = 1_000;
    const t0 = clock.t;
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assert(clock.t - t0 <= 20_000, `open took ${clock.t - t0} ms`);
    assertEquals([res.status, res.step, res.build!.transition], ["restarting", "build", "stop"], status);
    assertEquals(db.rows[0].restart_phase, "stopping");
    assertEquals(buildPosts(coder), [], "the stop is already Coder's: open posts none");

    // Status reads and a second open say restarting, and nothing more is claimed or posted.
    coder.latencyMs = 0;
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "restarting");
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "restarting");
    assertEquals([buildPosts(coder), db.restartClaims], [[], 1]);

    // The stop finishes: of two status reads, one posts the start.
    coder.workspaces[0].latest_build.status = "stopped";
    const [a, b] = await Promise.all([
      workspaceStatus(deps, ALEX, { assignment_id: 41 }),
      workspaceStatus(deps, ALEX, { assignment_id: 41 })
    ]);
    assertEquals(buildPosts(coder), ["start"]);
    assertEquals(new Set([a.status, b.status]), new Set(["starting", "restarting"]));
    assertEquals(db.rows[0].restart_token, null);
    coder.autoBuild = true;
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals(buildPosts(coder), ["start"]);
  }
});

Deno.test("a stop under way that finishes within the open's budget: the open posts the start, once", async () => {
  const one = await stoppingWorkspace("pending");
  one.coder.autoBuild = true;
  assertEquals((await openWorkspace(one.deps, ALEX, { assignment_id: 41 })).status, "ready");
  assertEquals([buildPosts(one.coder), one.db.rows[0].restart_started_at], [["start"], null]);

  // Two opens at once: one holds the claim and starts the workspace, the other waits on it.
  const { coder, db, deps } = await stoppingWorkspace("pending");
  coder.autoBuild = true;
  const [a, b] = await Promise.all([
    openWorkspace(deps, ALEX, { assignment_id: 41 }),
    openWorkspace(deps, ALEX, { assignment_id: 41 })
  ]);
  assertEquals([buildPosts(coder), db.restartClaims], [["start"], 1]);
  assertEquals(new Set([a.status, b.status]), new Set(["ready", "restarting"]), "the other call says restarting");
  assertEquals(db.rows[0].restart_started_at, null);
});

Deno.test(
  "a stop under way that fails or is canceled: failed with Coder's error, the claim given up, and the next open starts",
  async () => {
    for (const outcome of ["failed", "canceled"]) {
      const { coder, db, deps } = await stoppingWorkspace();
      // The stop ends badly by the first read after the open took its claim.
      const base = coder.fetch;
      deps.coder.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
        if (isWorkspaceRead(init?.method ?? "GET", path)) {
          const ws = coder.workspaces[0];
          ws.latest_build = { ...ws.latest_build, status: outcome, job: { error: "pod deletion failed" } };
        }
        return await base(input, init);
      };
      const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
      // A stop build that failed is a failed build, not a workspace nobody started.
      assertEquals(
        [res.status, res.step, res.message, res.build],
        [
          "failed",
          "build",
          "pod deletion failed",
          { status: outcome, transition: "stop", error: "pod deletion failed" }
        ]
      );
      assertEquals(res.failure, { step: "build", script: null, exit_code: null, log_lines: ["pod deletion failed"] });
      assertEquals([buildPosts(coder), db.rows[0].restart_token], [[], null], "nothing waits on a stop that ended");

      deps.coder.fetch = base;
      assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "failed", outcome);
      assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting", outcome);
      assertEquals(buildPosts(coder), ["start"]);
    }
  }
);

Deno.test("an open short of time still keeps its claim when there is no stop to post", async () => {
  // The workspace is being stopped, or is already stopped.
  for (const stopped of [false, true]) {
    const { clock, coder, db, deps } = await stoppingWorkspace();
    if (stopped) coder.workspaces[0].latest_build.status = "stopped";
    // Five Coder calls come before the workspace is known, so under 5 s of the budget is left. That
    // is too little to take a claim that still has a stop to post ("an open takes the restart claim
    // only with time to post the stop"), and enough for one that only waits, or leaves the start to
    // a status read.
    coder.latencyMs = 3_200;
    const t0 = clock.t;
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assert(clock.t - t0 <= 20_000, `open took ${clock.t - t0} ms`);
    assertEquals([res.status, db.rows[0].restart_phase, buildPosts(coder)], ["restarting", "stopping", []]);

    coder.latencyMs = 0;
    coder.workspaces[0].latest_build.status = "stopped";
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
    assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start"], null]);
  }
});

Deno.test(
  "an open kept on a stop under way never posts a stop, even when the start a status read posted fails",
  async () => {
    // The open holds its claim and its read of the workspace is held on the way to Coder.
    const { coder, db, deps } = await stoppingWorkspace();
    const openRead = holdFirst(coder.fetch, isWorkspaceRead);
    const open = openWorkspace(holding(deps, openRead.fetch), ALEX, { assignment_id: 41 });
    await openRead.reached;
    assertEquals(db.rows[0].restart_phase, "stopping");

    // Coder's stop finishes. A status read takes the open's claim, posts the start and gives the claim
    // up, and the start's clone fails.
    coder.workspaces[0].latest_build.status = "stopped";
    coder.nextAgent = failedClone();
    coder.autoBuild = true;
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "failed");
    assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start"], null]);

    // The open reads a workspace that needs a restart, but its claim is spent: a stop posted now would
    // have no start after it. It reports the failure, and restarting is the next open's to do.
    openRead.release();
    const res = await open;
    assertEquals([res.status, res.step], ["failed", "clone"]);
    assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start"], null]);
    assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "failed");

    coder.nextAgent = readyAgent();
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready");
    assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start", "stop", "start"], null]);
  }
);

Deno.test("a claim cut off as it is taken: open answers restarting, whether or not the claim was written", async () => {
  // The budget's cut-off lands on the claim's database call. The update may have been written with
  // only its reply lost, so the answer has to keep the card polling instead of a 504 that stops it.
  for (const written of [true, false]) {
    const { clock, coder, db, deps } = await stoppingWorkspace();
    const cutOff = new AbortController();
    const budget = { deadline: clock.t + OPEN_BUDGET_MS, signal: cutOff.signal };
    const claim = db.claimRestart.bind(db);
    db.claimRestart = async (id, staleBefore) => {
      if (written) await claim(id, staleBefore);
      cutOff.abort(new DOMException("The operation timed out.", "TimeoutError"));
      throw cutOff.signal.reason;
    };
    const res = await withinBudget(budget, () => openWorkspace({ ...deps, budget }, ALEX, { assignment_id: 41 }));
    assertEquals([res.status, db.rows[0].restart_phase], ["restarting", written ? "stopping" : null]);
    db.claimRestart = claim;

    if (written) {
      // Status reads find the claim and post the start once the stop finishes.
      assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "restarting");
      coder.workspaces[0].latest_build.status = "stopped";
      assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
      assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start"], null]);
    } else {
      // Nothing was kept: the next status read says so, and the next open takes the claim.
      assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "not_started");
      coder.autoBuild = true;
      coder.workspaces[0].latest_build.status = "pending";
      assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready");
      assertEquals([buildPosts(coder), db.rows[0].restart_token], [["start"], null]);
    }
  }
});

Deno.test("ready needs a connected agent: a lost agent is failed, and open restarts it", async () => {
  for (const status of ["disconnected", "timeout"]) {
    const { coder, deps } = setup();
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    signInAndLink(coder, ALEX);
    coder.nextAgent = readyAgent();
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "ready");

    // The reviewer's fixture: build running, lifecycle ready, app healthy, agent gone.
    const agent = coder.workspaces[0].latest_build.resources[0].agents![0];
    agent.status = status;
    const res = await workspaceStatus(deps, ALEX, { assignment_id: 41 });
    assertEquals(res.status, "failed");
    assertEquals(res.agent, { lifecycle_state: "ready", status });
    assert(!res.redirect_url!.includes("code-server"), "no editor link");
    assertEquals(coder.posts(/\/builds$/).length, 0);

    coder.autoBuild = true;
    const reopened = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(
      coder.posts(/\/builds$/).map((c) => c.body),
      [{ transition: "stop" }, { transition: "start", template_version_id: TEMPLATE.active_version_id }]
    );
    assertEquals(reopened.status, "ready");
  }

  // Still connecting: starting, not ready.
  const { coder, deps } = setup();
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  signInAndLink(coder, ALEX);
  coder.nextAgent = readyAgent("connecting");
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals([res.status, res.step], ["starting", "build"]);
});

Deno.test("database calls end with the budget: no PostgREST retry after the cut-off, or on a 503", async () => {
  // The supabase-js client workspace-open makes, over a fetch that never answers or always answers 503.
  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  let busyCalls = 0;
  const busy: typeof fetch = async () => {
    busyCalls++;
    return new Response(JSON.stringify({ message: "schema cache not loaded" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  };
  for (const [what, base] of [
    ["no answer", hang],
    ["503", busy]
  ] as const) {
    const budget = startBudget(3_000);
    const db = supabaseWorkspaceDb(budgetClient("http://supabase.invalid", "service-key", budget, {}, base));
    const t0 = Date.now();
    await assertRejects(() => db.getWorkspaceRow(ALEX.userId, 501, CODER_URL));
    const elapsed = Date.now() - t0;
    assert(elapsed < 3_000, `${what}: failed after ${elapsed} ms`);
  }
  assertEquals(busyCalls, 1, "a 503 isn't retried");
});

// ---- git credentials ------------------------------------------------------

const ALEX_FILE = "/home/coder/.git-credentials-cs3500--hw1-alex";
const SECRET = "git_credentials_repo_501";

async function runningWorkspace() {
  const t = setup();
  t.coder.noProviders = true;
  await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
  t.coder.users.find((u) => u.email === coderEmail(ALEX.userId))!.subject = ALEX.userId;
  const res = await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "starting");
  return { ...t, coderUserId: res.coder_user_id! };
}

function stop(ws: CoderWorkspace) {
  ws.latest_build = { ...ws.latest_build, transition: "stop", status: "stopped", resources: [] };
}

function storedToken(coder: FakeCoder, coderUserId: string): string {
  const value = coder.secrets[coderUserId]?.[SECRET]?.value ?? "";
  const m = value.match(/^https:\/\/x:([0-9a-f]+)@git\.example\.com\n$/);
  assert(m, `unexpected credentials line: ${JSON.stringify(value)}`);
  return m[1];
}

Deno.test("credentials: no Forgejo linking; the student signs in to Coder and nothing else", async () => {
  const { coder, deps } = setup();
  coder.noProviders = true;
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "needs_linking");
  assertEquals(res.message, "Sign in to Coder, then open the workspace again.");
  assertEquals(res.authenticate_url, `${CODER_URL}/api/v2/users/oidc/callback?redirect=%2F`);
  assertEquals(
    linkUrl(CODER_URL, "github"),
    `${CODER_URL}/api/v2/users/oidc/callback?redirect=%2Fexternal-auth%2Fgithub%2Fcallback`
  );
});

// ---- GitHub repositories --------------------------------------------------

/** Phase 2's template: one optional GitHub provider, so an unlinked account blocks nothing. */
function githubProvider(coder: FakeCoder) {
  coder.provider = { id: "github", type: "github", display_name: "GitHub", optional: true };
}

Deno.test("github: a repository on GitHub clones from github.com and mints no Forgejo token", async () => {
  const { coder, db, deps, forgejo } = setup();
  githubProvider(coder);
  await openWorkspace(deps, ALEX, { assignment_id: 42 });
  signInAndLink(coder, ALEX);
  const res = await openWorkspace(deps, ALEX, { assignment_id: 42 });
  assertEquals(res.status, "starting");
  const created = coder.workspaces[0] as CoderWorkspace & { repo_url: string };
  assertEquals(created.repo_url, "https://github.com/cs3500-gh/hw2-alex.git");
  assertEquals(db.rows[0].repo_url, "https://github.com/cs3500-gh/hw2-alex.git");
  // No token to mint, and no ledger row to revoke later.
  assertEquals(forgejo.tokens["alex.kim"] ?? [], []);
  assertEquals(db.recordedTokens, []);
  // Only the commit email, since the owner's Coder email is a placeholder (#1222).
  const secrets = coder.secrets[res.coder_user_id!];
  assertEquals(Object.keys(secrets), ["git_email"]);
  assertEquals(secrets.git_email, { value: `${ALEX.email}\n`, file_path: "/home/coder/.git-email" });
  assertEquals(
    coder.keys.every((k) => k.deleted),
    true
  );
});

Deno.test("github: a linked GitHub account commits as its no-reply address", async () => {
  const { coder, deps } = setup();
  githubProvider(coder);
  const linked: Caller = { ...ALEX, githubUserId: "583231", githubUsername: "alexkim" };
  await openWorkspace(deps, linked, { assignment_id: 42 });
  signInAndLink(coder, linked);
  const res = await openWorkspace(deps, linked, { assignment_id: 42 });
  assertEquals(res.status, "starting");
  assertEquals(coder.secrets[res.coder_user_id!].git_email, {
    value: "583231+alexkim@users.noreply.github.com\n",
    file_path: "/home/coder/.git-email"
  });
});

Deno.test("github: a commit email key that couldn't be deleted doesn't block the next open's", async () => {
  const { coder, deps } = setup();
  githubProvider(coder);
  await openWorkspace(deps, ALEX, { assignment_id: 42 });
  signInAndLink(coder, ALEX);
  coder.failKeyDelete = true;
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 42 })).status, "starting");
  stop(coder.workspaces[0]);
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 42 })).status, "starting");
  const names = coder.keys.map((k) => k.name);
  assertEquals(names.length, 2, "the second open minted its own key instead of taking a 409");
  assertEquals(new Set(names).size, 2, names.join(", "));
  assert(
    names.every((n) => n.startsWith("pawtograder-secret-write-email-")),
    names.join(", ")
  );
});

Deno.test(
  "github: a commit email write that stalls builds nothing, and the open answers 504 within budget",
  async () => {
    const t = setup();
    const { coder } = t;
    githubProvider(coder);
    await openWorkspace(t.deps, ALEX, { assignment_id: 42 });
    signInAndLink(coder, ALEX);
    const stall = stallUntilCutOff(
      coder.fetch,
      (method, path) => method === "POST" && path === "/api/v2/users/me/secrets"
    );
    // A 10 s budget: its signal fires at 8 s.
    const deps = onRealTime(t, 10_000, stall.fetch);
    const t0 = Date.now();
    const err = await assertRejects(() =>
      withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 42 }))
    );
    const elapsed = Date.now() - t0;
    assertEquals(stall.stalled(), 1);
    assert(elapsed >= 7_500 && elapsed < 10_000, `answered after ${elapsed} ms`);
    assertEquals((err as UserVisibleError).status, 504);
    assertEquals(coder.workspaces.length, 0, "no workspace starts with the placeholder email");
  }
);

Deno.test("github: an expired key list that stalls is cut off, and the email is still written", async () => {
  const t = setup();
  const { coder } = t;
  githubProvider(coder);
  await openWorkspace(t.deps, ALEX, { assignment_id: 42 });
  signInAndLink(coder, ALEX);
  const stall = stallUntilCutOff(coder.fetch, isKeyList);
  const deps = onRealTime(t, STALL_BUDGET_MS, stall.fetch);
  const t0 = Date.now();
  const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 42 }));
  const elapsed = Date.now() - t0;
  assertEquals(stall.stalled(), 1);
  assert(
    elapsed >= STALL_CUTOFF_MS - 500 && elapsed < STALL_CUTOFF_MS + 4_000,
    `cleanup was cut off, and the open answered after ${elapsed} ms`
  );
  assertEquals(res.status, "starting");
  assertEquals(coder.workspaces.length, 1);
  assertEquals(coder.secrets[res.coder_user_id!].git_email, {
    value: `${ALEX.email}\n`,
    file_path: "/home/coder/.git-email"
  });
});

Deno.test("github: a commit email that can't be written is credentials_unavailable, and nothing is built", async () => {
  const { coder, reported, deps } = setup();
  githubProvider(coder);
  await openWorkspace(deps, ALEX, { assignment_id: 42 });
  signInAndLink(coder, ALEX);
  coder.failSecretWrite = true;
  const res = await openWorkspace(deps, ALEX, { assignment_id: 42 });
  assertEquals(res.status, "credentials_unavailable");
  assertEquals(coder.workspaces.length, 0);
  assertEquals(reported.length, 1);
  assert(
    coder.keys.every((k) => k.deleted),
    "the short-lived key is deleted"
  );
});

Deno.test("github: an unlinked optional provider stops a GitHub workspace, not a Forgejo one", async () => {
  const { coder, deps } = setup();
  githubProvider(coder);
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.findUser("alex-kim-1a2b3c4d5e6f")!.subject = ALEX.userId;
  // Signed in to Coder, GitHub not linked.
  const forgejoRes = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(forgejoRes.status, "starting");
  const githubRes = await openWorkspace(deps, ALEX, { assignment_id: 42 });
  assertEquals(githubRes.status, "needs_linking");
  assertEquals(githubRes.authenticate_url, linkUrl(CODER_URL, "github"));
  assertEquals(githubRes.message, "Link your GitHub account in Coder, then open the workspace again.");
  assertEquals(coder.workspaces.length, 1, "only the Forgejo workspace was created");
});

Deno.test("github: without Coder's GitHub provider a GitHub repository is refused and nothing is created", async () => {
  for (const confirmed of [true, false]) {
    const { coder, db, deps } = setup();
    deps.github = null;
    db.enrollments[0].github_org_confirmed = confirmed;
    const err = await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 42 }), IllegalArgumentError);
    assertEquals(err.details, "This deployment can't open GitHub repositories in a workspace");
    assertEquals(coder.calls.length, 0, `nothing reaches Coder (org confirmed: ${confirmed})`);
    assertEquals(db.rows.length, 0);
  }
  // Forgejo repositories still open.
  const { coder, deps } = setup();
  deps.github = null;
  coder.noProviders = true;
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.findUser("alex-kim-1a2b3c4d5e6f")!.subject = ALEX.userId;
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
});

Deno.test("githubConfig: null unless the chart set CODER_GITHUB_AUTH_ID", () => {
  const saved = { id: Deno.env.get("CODER_GITHUB_AUTH_ID"), url: Deno.env.get("GITHUB_URL") };
  try {
    Deno.env.delete("CODER_GITHUB_AUTH_ID");
    Deno.env.delete("GITHUB_URL");
    assertEquals(githubConfig(), null);
    Deno.env.set("CODER_GITHUB_AUTH_ID", "");
    assertEquals(githubConfig(), null);
    Deno.env.set("CODER_GITHUB_AUTH_ID", "gh");
    assertEquals(githubConfig(), { url: "https://github.com", externalAuthId: "gh" });
    Deno.env.set("GITHUB_URL", "https://github.example.edu/");
    assertEquals(githubConfig(), { url: "https://github.example.edu", externalAuthId: "gh" });
  } finally {
    for (const [name, value] of [
      ["CODER_GITHUB_AUTH_ID", saved.id],
      ["GITHUB_URL", saved.url]
    ] as const) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("no Forgejo: a GitHub repository opens, and a Forgejo one is refused with a 503", async () => {
  const { coder, db, deps } = setup();
  deps.forgejo = null;
  githubProvider(coder);
  await openWorkspace(deps, ALEX, { assignment_id: 42 });
  signInAndLink(coder, ALEX);
  const res = await openWorkspace(deps, ALEX, { assignment_id: 42 });
  assertEquals(res.status, "starting");
  assertEquals(coder.workspaces.length, 1);
  assertEquals(Object.keys(coder.secrets[res.coder_user_id!]), ["git_email"]);

  const posts = coder.calls.filter((c) => c.method === "POST").length;
  const rows = db.rows.length;
  const err = await assertRejects(() => openWorkspace(deps, ALEX, { assignment_id: 41 }), UserVisibleError);
  assertEquals(
    [err.message, (err as UserVisibleError).status],
    ["Forgejo workspaces are not set up on this deployment", 503]
  );
  assertEquals(coder.calls.filter((c) => c.method === "POST").length, posts, "nothing is created");
  assertEquals(db.rows.length, rows);
});

Deno.test("github: an unaccepted organization invitation is refused before Coder is called", async () => {
  const { coder, db, deps } = setup();
  githubProvider(coder);
  db.enrollments[0].github_org_confirmed = false;
  const res = await openWorkspace(deps, ALEX, { assignment_id: 42 });
  assertEquals(res.status, "needs_org_invite");
  assert(res.message!.includes("GitHub organization invitation"), res.message);
  assertEquals(coder.calls.length, 0);
  assertEquals(db.rows.length, 0);
  // A status read is refused the same way.
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 42 })).status, "needs_org_invite");
});

Deno.test("credentials: the create stores a repository-scoped student token as the student's secret", async () => {
  const { coder, db, forgejo, coderUserId } = await runningWorkspace();
  assertEquals(coder.workspaces.length, 1);
  const secret = coder.secrets[coderUserId][SECRET];
  assertEquals(secret.file_path, ALEX_FILE);
  assertEquals(coder.secrets[coderUserId].git_email, { value: `${ALEX.email}\n`, file_path: "/home/coder/.git-email" });
  const token = storedToken(coder, coderUserId);
  const live = forgejo.live("alex.kim", token)!;
  assertEquals(live.repo, "cs3500/hw1-alex");
  assert(live.name.startsWith("pawtograder-coder-501-"), live.name);
  assertEquals(db.recordedTokens, [{ user_id: ALEX.userId, repository_id: 501, instance_url: FORGEJO_URL }]);
  assertEquals(coder.keys.length, 1);
  assertEquals([coder.keys[0].userId, coder.keys[0].deleted], [coderUserId, true]);
  assert(coder.keys[0].name.startsWith("pawtograder-secret-write-501"), coder.keys[0].name);
  const order = coder.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
  assert(
    order.indexOf("POST /users/me/secrets") < order.indexOf(`POST /users/${coderUserId}/workspaces`),
    order.join("\n")
  );
});

Deno.test(
  "credentials: a running workspace is left alone; a stopped one gets a new token before its start",
  async () => {
    const { clock, coder, forgejo, deps, coderUserId } = await runningWorkspace();
    const first = storedToken(coder, coderUserId);
    coder.workspaces[0].latest_build.resources[0].agents![0].lifecycle_state = "ready";
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(forgejo.calls.filter((c) => c.method === "POST").length, 1, "no mint for a running workspace");

    stop(coder.workspaces[0]);
    clock.t += 60 * 60_000;
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
    const second = storedToken(coder, coderUserId);
    assert(second !== first);
    assert(forgejo.live("alex.kim", second));
    assertEquals(forgejo.live("alex.kim", first), null, "the replaced token, an hour old, is revoked");
    assertEquals(buildPosts(coder), ["start"]);
  }
);

Deno.test("credentials: two opens of one stopped workspace at once never leave it a revoked token", async () => {
  const { coder, forgejo, deps, coderUserId } = await runningWorkspace();
  stop(coder.workspaces[0]);
  await Promise.all([
    openWorkspace(deps, ALEX, { assignment_id: 41 }),
    openWorkspace(deps, ALEX, { assignment_id: 41 })
  ]);
  assertEquals(buildPosts(coder), ["start"]);
  assert(forgejo.live("alex.kim", storedToken(coder, coderUserId)), "the stored token works");
});

Deno.test("credentials: a status read that finishes a restart stores a token before the start", async () => {
  const { coder, forgejo, deps } = await stoppedRestart();
  const mints = forgejo.calls.filter((c) => c.method === "POST").length;
  assertEquals((await workspaceStatus(deps, ALEX, { assignment_id: 41 })).status, "starting");
  assertEquals(forgejo.calls.filter((c) => c.method === "POST").length, mints + 1);
  const order = coder.calls.map((c) => `${c.method} ${c.path}`);
  assert(
    order.lastIndexOf("PATCH /users/me/secrets/git_credentials_repo_501") <
      order.lastIndexOf(`POST /workspaces/${coder.workspaces[0].id}/builds`)
  );
});

Deno.test("credentials: no Forgejo account yet: credentials_unavailable, and nothing is built", async () => {
  const { coder, db, deps } = setup();
  coder.noProviders = true;
  delete db.forgejoLogins[ALEX.userId];
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.users.find((u) => u.email === coderEmail(ALEX.userId))!.subject = ALEX.userId;
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "credentials_unavailable");
  assertEquals(coder.workspaces.length, 0);
  assertEquals(coder.keys.length, 0);
});

Deno.test("credentials: a failed mint or secret write is reported, builds nothing, and leaves no key", async () => {
  for (const fail of ["mint", "secret"] as const) {
    const { coder, forgejo, reported, deps } = setup();
    coder.noProviders = true;
    await openWorkspace(deps, ALEX, { assignment_id: 41 });
    coder.users.find((u) => u.email === coderEmail(ALEX.userId))!.subject = ALEX.userId;
    if (fail === "mint") forgejo.failMint = true;
    else coder.failSecretWrite = true;
    const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
    assertEquals(res.status, "credentials_unavailable", fail);
    assertEquals(coder.workspaces.length, 0, fail);
    assertEquals(reported.length, 1, fail);
    assert(
      coder.keys.every((k) => k.deleted),
      fail
    );
    const text = JSON.stringify(res) + String(reported[0]);
    for (const t of Object.values(forgejo.tokens).flat()) assert(!text.includes(t.sha1), fail);
    for (const k of coder.keys) assert(!text.includes(k.key), fail);
  }
});

Deno.test("credentials: a key that couldn't be deleted doesn't stop the start, and goes once expired", async () => {
  const { clock, coder, deps, coderUserId } = await (async () => {
    const t = setup();
    t.coder.noProviders = true;
    t.coder.failKeyDelete = true;
    await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
    t.coder.users.find((u) => u.email === coderEmail(ALEX.userId))!.subject = ALEX.userId;
    const res = await openWorkspace(t.deps, ALEX, { assignment_id: 41 });
    assertEquals(res.status, "starting");
    return { ...t, coderUserId: res.coder_user_id! };
  })();
  assertEquals(coder.keys.filter((k) => !k.deleted).length, 1);
  coder.failKeyDelete = false;
  stop(coder.workspaces[0]);
  clock.t += 2 * 60_000;
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(coder.keys.filter((k) => !k.deleted).length, 0, "the expired leftover and the new key are both gone");
  assert(storedToken(coder, coderUserId));
});

Deno.test("credentials: each open's key has its own name, so a live key never blocks the next open", async () => {
  const { coder, deps, coderUserId } = await runningWorkspace();
  coder.failKeyDelete = true;
  stop(coder.workspaces[0]);
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
  stop(coder.workspaces[0]);
  // The first key is still live and undeleted; a fixed name per repository would get Coder's 409.
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
  const names = coder.keys.filter((k) => k.userId === coderUserId).map((k) => k.name);
  assertEquals(new Set(names).size, names.length, names.join(", "));
  assert(
    names.every((n) => n.startsWith("pawtograder-secret-write-501-")),
    names.join(", ")
  );
});

/** A second Forgejo assignment, 43, with Alex's repository 504 on it. */
function addSecondRepository(db: FakeDb) {
  db.assignments.push({ id: 43, class_id: 7, git_provider: "forgejo" });
  db.repos.push({ ...repo(504, "prof-alex", null, "cs3500/hw2-alex"), assignment_id: 43 });
}

function tokenIn(coder: FakeCoder, coderUserId: string, secret: string): string {
  const m = (coder.secrets[coderUserId]?.[secret]?.value ?? "").match(/^https:\/\/x:([0-9a-f]+)@/);
  assert(m, `no credentials in ${secret}`);
  return m[1];
}

Deno.test(
  "credentials: a repository no open has re-minted for IDLE_TOKEN_MS loses its token and secret at the next open of another",
  async () => {
    const { clock, coder, db, forgejo, deps, coderUserId } = await runningWorkspace();
    addSecondRepository(db);
    const hw1 = storedToken(coder, coderUserId);

    clock.t += IDLE_TOKEN_MS - 60_000;
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 43 })).status, "starting");
    assert(forgejo.live("alex.kim", hw1), "hw1 was opened less than IDLE_TOKEN_MS ago");
    assertEquals(storedToken(coder, coderUserId), hw1);
    const hw2 = tokenIn(coder, coderUserId, "git_credentials_repo_504");

    const hw2Workspace = coder.workspaces.find((w) => w.id !== coder.workspaces[0].id)!;
    stop(hw2Workspace);
    clock.t += 60 * 60_000;
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 43 })).status, "starting");
    assertEquals(forgejo.live("alex.kim", hw1), null, "hw1's token is revoked");
    assertEquals(coder.secrets[coderUserId][SECRET], undefined, "hw1's secret is deleted");
    const hw2Again = tokenIn(coder, coderUserId, "git_credentials_repo_504");
    assert(forgejo.live("alex.kim", hw2Again), "the opened repository keeps its new token");
    assertEquals(forgejo.live("alex.kim", hw2), null, "and its replaced one goes as before");
    assert(coder.secrets[coderUserId].git_email);

    // Opening hw1 again gives it a new token and secret.
    stop(coder.workspaces[0]);
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 41 })).status, "starting");
    assert(forgejo.live("alex.kim", storedToken(coder, coderUserId)));
    assert(forgejo.live("alex.kim", hw2Again), "hw2 was opened an hour ago");
  }
);

Deno.test(
  "credentials: the secret of a repository whose token the reconciler revoked is deleted, past the grace window",
  async () => {
    const { clock, coder, db, forgejo, deps, coderUserId } = await runningWorkspace();
    addSecondRepository(db);
    // What revokeDroppedTokens does to hw1's tokens.
    forgejo.tokens["alex.kim"] = forgejo.tokens["alex.kim"].filter((t) => !t.name.startsWith("pawtograder-coder-501-"));

    // Written moments ago: it may hold a concurrent open's new token that the token list missed.
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 43 })).status, "starting");
    assert(coder.secrets[coderUserId][SECRET], "a secret written inside the grace window is kept");

    const hw2Workspace = coder.workspaces.find((w) => w.id !== coder.workspaces[0].id)!;
    stop(hw2Workspace);
    clock.t += REPLACED_TOKEN_GRACE_MS;
    assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 43 })).status, "starting");
    assertEquals(coder.secrets[coderUserId][SECRET], undefined);
    assert(coder.secrets[coderUserId].git_credentials_repo_504);
  }
);

Deno.test("credentials: a failed cleanup of idle credentials doesn't stop the open", async () => {
  const { clock, coder, db, forgejo, deps, coderUserId } = await runningWorkspace();
  addSecondRepository(db);
  const hw1 = storedToken(coder, coderUserId);
  clock.t += IDLE_TOKEN_MS;
  const realFetch = coder.fetch;
  coder.fetch = (input, init) =>
    new URL(String(input)).pathname === "/api/v2/users/me/secrets" && (init?.method ?? "GET") === "GET"
      ? Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }))
      : realFetch(input, init);
  deps.coder = { ...deps.coder, fetch: coder.fetch };
  assertEquals((await openWorkspace(deps, ALEX, { assignment_id: 43 })).status, "starting");
  assertEquals(forgejo.live("alex.kim", hw1), null, "the token is revoked before the secret list fails");
  assert(coder.secrets[coderUserId][SECRET], "the secret is left for the next open");
  assert(coder.secrets[coderUserId].git_credentials_repo_504);
});

/** A fetch whose requests `match` picks never reach Coder: each fails only when its signal fires. */
function stallUntilCutOff(
  base: typeof fetch,
  match: (method: string, path: string) => boolean
): { fetch: typeof fetch; stalled: () => number } {
  let stalled = 0;
  return {
    stalled: () => stalled,
    fetch: async (input, init) => {
      if (match(init?.method ?? "GET", new URL(String(input)).pathname)) {
        stalled++;
        const signal = init!.signal!;
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return await base(input, init);
    }
  };
}

// A 12 s budget: its signal fires at 10 s, and cleanup is cut off at 4 s, leaving the open seconds to reach
// the stalled call first.
const STALL_BUDGET_MS = 12_000;
const STALL_CUTOFF_MS = 4_000;
const isOwnSecretList = (method: string, path: string) => method === "GET" && path === "/api/v2/users/me/secrets";
const isKeyList = (method: string, path: string) =>
  method === "GET" && /^\/api\/v2\/users\/[^/]+\/keys\/tokens$/.test(path);

for (const [what, match] of [
  ["secret list (after the credentials are written)", isOwnSecretList],
  ["expired key list (before the credentials are written)", isKeyList]
] as const) {
  Deno.test(`credentials: a create whose ${what} stalls until cut off is still built and answered`, async () => {
    const t = await runningWorkspace();
    const { coder, db, coderUserId } = t;
    addSecondRepository(db);
    const stall = stallUntilCutOff(coder.fetch, match);
    const deps = onRealTime(t, STALL_BUDGET_MS, stall.fetch);
    const t0 = Date.now();
    const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 43 }));
    const elapsed = Date.now() - t0;
    assertEquals(stall.stalled(), 1);
    assert(
      elapsed >= STALL_CUTOFF_MS - 500 && elapsed < STALL_CUTOFF_MS + 4_000,
      `cleanup was cut off, and the open answered after ${elapsed} ms`
    );
    assertEquals(res.status, "starting");
    assertEquals(coder.workspaces.length, 2, "hw2's workspace is created");
    assert(coder.secrets[coderUserId].git_credentials_repo_504, "the credentials are written before the build");
  });
}

Deno.test(
  "credentials: a stopped workspace whose cleanup stalls until cut off is started, and its claim given up",
  async () => {
    const t = await runningWorkspace();
    const { coder, db } = t;
    stop(coder.workspaces[0]);
    const posted = buildPosts(coder).length;
    const stall = stallUntilCutOff(coder.fetch, isOwnSecretList);
    const deps = onRealTime(t, STALL_BUDGET_MS, stall.fetch);
    const t0 = Date.now();
    const res = await withinBudget(deps.budget!, () => openWorkspace(deps, ALEX, { assignment_id: 41 }));
    const elapsed = Date.now() - t0;
    assertEquals(stall.stalled(), 1);
    assert(
      elapsed >= STALL_CUTOFF_MS - 500 && elapsed < STALL_CUTOFF_MS + 4_000,
      `cleanup was cut off, and the open answered after ${elapsed} ms`
    );
    assertEquals(res.status, "starting");
    assertEquals(buildPosts(coder).slice(posted), ["start"], "the start is posted");
    assertEquals([db.rows[0].restart_token, db.rows[0].restart_phase], [null, null], "the claim is given up");
  }
);

Deno.test("credentials: a commit email that can't be written stops the start, so no placeholder identity", async () => {
  const { coder, reported, deps } = setup();
  coder.noProviders = true;
  await openWorkspace(deps, ALEX, { assignment_id: 41 });
  coder.users.find((u) => u.email === coderEmail(ALEX.userId))!.subject = ALEX.userId;
  const realFetch = coder.fetch;
  coder.fetch = (input, init) =>
    new URL(String(input)).pathname.endsWith("/users/me/secrets/git_email") ||
    String(init?.body ?? "").includes('"name":"git_email"')
      ? Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }))
      : realFetch(input, init);
  deps.coder = { ...deps.coder, fetch: coder.fetch };
  const res = await openWorkspace(deps, ALEX, { assignment_id: 41 });
  assertEquals(res.status, "credentials_unavailable");
  assertEquals(coder.workspaces.length, 0, "nothing is built");
  assertEquals(reported.length, 1);
  assert(
    coder.keys.every((k) => k.deleted),
    "the short-lived key is deleted"
  );
});
