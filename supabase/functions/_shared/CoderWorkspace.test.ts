/**
 * Unit tests for workspace-open and workspace-status (#1222), against an in-memory Coder v2.37.3
 * API served through `fetch` and an in-memory WorkspaceDb.
 *
 * Covers: account creation with the subject-derived Coder email and reuse, adopting a user a lost
 * write left behind, refusing to adopt by email, the concurrent user create (409 and 500),
 * workspace create, reuse and start, the concurrent-create 409 and 500, the unlinked external auth
 * and unsigned-in paths (always asking Coder about the student, never the service token), a user
 * bound to another subject, the failing startup step with its log lines, a failed build, the
 * restart after a failed or lost agent (within open's time budget, finished by a status read when
 * the stop is slow), one start per restart however the callers interleave, answering within the
 * budget in real time when a Coder or database call hangs, no claim taken without time to use it,
 * a stale claim taken over, readiness only with a connected agent, the editor
 * URL, a group change, which repository a caller may open, the repo_url shape the template accepts,
 * a Coder user that predates the Coder email (an account conflict until staff delete it), and a
 * course without cloud-workspaces.
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
import { budgetClient, supabaseWorkspaceDb } from "./CoderWorkspaceDb.ts";
import type { CoderAgent, CoderWorkspace } from "./CoderWrapper.ts";
import { IllegalArgumentError, NotFoundError, SecurityError, UserVisibleError } from "./HandlerUtils.ts";

const CODER_URL = "https://coder.example.com";
const FORGEJO_URL = "https://git.example.com";
const OWNER_ID = "00000000-0000-0000-0000-00000000aaaa";
const ORG_ID = "00000000-0000-0000-0000-00000000000f";
const TEMPLATE = { id: "tmpl-1", active_version_id: "ver-1", default_ttl_ms: 3_600_000 };
/** The template's repo_url validation with forgejo_url = FORGEJO_URL (main.tf `repo_url_regex`). */
const REPO_URL_REGEX = /^(https:\/\/git\.example\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/;

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
  forgejoLinked = new Set<string>([OWNER_ID]);
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
      ws.latest_build = { ...ws.latest_build, status: "pending", transition: body.transition, resources: [] };
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

// ---- fake database --------------------------------------------------------

const ASSIGNMENT = { id: 41, class_id: 7, git_provider: "forgejo" };

class FakeDb implements WorkspaceDb {
  constructor(private clock: Clock) {}
  assignments = [ASSIGNMENT, { id: 42, class_id: 7, git_provider: "github" }];
  enrollments: { user_id: string; class_id: number; private_profile_id: string; disabled: boolean }[] = [
    { user_id: ALEX.userId, class_id: 7, private_profile_id: "prof-alex", disabled: false },
    { user_id: JORDAN.userId, class_id: 7, private_profile_id: "prof-jordan", disabled: false }
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
  const deps: Deps = {
    db,
    coder: { url: CODER_URL, token: "owner-token", fetch: coder.fetch },
    forgejoUrl: FORGEJO_URL,
    now: clock.now,
    sleep: clock.sleep
  };
  return { clock, coder, db, deps };
}

/** What the student's first Coder sign-in and Forgejo link do. */
function signInAndLink(coder: FakeCoder, caller: Caller) {
  const u = coder.users.find((u) => u.email === coderEmail(caller.userId))!;
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
    coder.forgejoLinked.add(legacy.id);
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
        coder.forgejoLinked.delete(u.id);
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
    "cs3500/hw1?x=1"
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
      [{ transition: "stop" }, { transition: "start" }]
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
    [{ transition: "stop" }, { transition: "start" }]
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
      // The open reaches the workspace after the read posted the start, and sees it starting.
      assertEquals([a.status, b.status], ["starting", "starting"]);
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
  // The stop finishes on the read that starts 18 s in, when too little time is left for the start.
  const base = coder.fetch;
  deps.coder.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, "");
    const build = coder.workspaces[0].latest_build;
    if (isWorkspaceRead(init?.method ?? "GET", path) && build.transition === "stop" && clock.t - t0 >= 17_000) {
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

const isStartPost = (method: string, path: string, body: string) =>
  method === "POST" && path.endsWith("/builds") && body.includes('"start"');
const isWorkspaceRead = (method: string, path: string) => method === "GET" && /^\/workspaces\/[^/]+$/.test(path);

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
    const openRead = holdFirst(coder.fetch, isWorkspaceRead);
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
    // The review's case: the read after the stop takes 21 s to come back.
    let reads = 0;
    coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 0 ? 21_000 : 0);
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
  // the row has no id, and this open's restart is cut off on the read after its stop.
  const t = await failedWorkspace();
  t.db.rows[0].coder_workspace_id = null;
  let reads = 0;
  t.coder.slow = (method, path) => (isWorkspaceRead(method, path) && reads++ === 0 ? 10_000 : 0);
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
      [{ transition: "stop" }, { transition: "start" }]
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
