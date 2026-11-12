// What workspace-open and workspace-status do (#1222), with the database and Coder passed in so the
// tests can run against fakes. Template contract: #1221 (template `kubernetes` in org `default`,
// parameter `repo_url`, external auth `forgejo`).
//
// Binding the Coder user to the Pawtograder login. Coder v2.37.3 binds an OIDC user by
// `user_links.linked_id` (issuer + subject), and only its login handler writes that column. The API
// that creates users can't set it, so a user's first OIDC login finds them by email and binds that
// subject. We never let a real, transferable email decide that: each Coder user gets
// `<Pawtograder user id>@coder.pawtograder.invalid`, and Coder reads the email from the `coder_email`
// claim, which the access token hook sets to the same address for the token's subject (migration
// 20261109150000, chart CODER_OIDC_EMAIL_FIELD). Every later login is matched by subject. Before a
// workspace is created or started we still read the bound subject back and require it to be the
// caller's, and a user who hasn't signed in to Coder yet gets linkUrl, which signs them in first.

import type { WorkspaceOpenRequest, WorkspaceOpenResponse, WorkspaceStep } from "./FunctionTypes.d.ts";
import {
  type CoderAgent,
  type CoderConfig,
  type CoderUser,
  type CoderWorkspace,
  createOidcUser,
  createWorkspace,
  findUserByEmail,
  getAgentLogs,
  getAppHost,
  getBoundOidcSubject,
  getExternalAuth,
  getOrganizationId,
  getTemplate,
  getUser,
  getWorkspace,
  getWorkspaceByName,
  postBuild
} from "./CoderWrapper.ts";
import { IllegalArgumentError, NotFoundError, SecurityError, UserVisibleError } from "./HandlerUtils.ts";

export const CODER_ORGANIZATION = "default";
export const CODER_TEMPLATE = "kubernetes";
/** Must match the access token hook's `coder_email` and the chart's CODER_OIDC_EMAIL_DOMAIN. */
export const CODER_EMAIL_DOMAIN = "coder.pawtograder.invalid";
const LOG_LINES = 20;
/**
 * How long workspace-open may take, from the start of the request. Kong cuts the request at 60 s
 * (the functions route sets no read_timeout, charts/pawtograder/templates/kong-config.yaml). A
 * restart whose stop outlasts this answers "restarting", and a status read posts the start.
 */
export const OPEN_BUDGET_MS = 20_000;
/** The same for workspace-status, which posts at most a restart's start. */
export const STATUS_BUDGET_MS = 20_000;
/** Every Coder and database call is cut off this long before the deadline, to leave time to answer. */
const RESPONSE_RESERVE_MS = 2_000;
const RESTART_POLL_MS = 2_000;
/**
 * A restart claim is taken only with this much of the budget left: time for its build request to
 * reach Coder and for the answer. A claim taken and then cut off would hold the restart up.
 */
const CLAIM_MIN_LEFT_MS = 5_000;
/**
 * A restart claim older than this has no live holder, since every holder answers within its 20 s
 * budget; the margin covers clocks that differ between function instances. Its restart may then be
 * taken over: by an open, or by a status read once the workspace is stopped.
 */
export const RESTART_CLAIM_MS = 60_000;
const BUILD_IN_PROGRESS = new Set(["pending", "starting", "stopping", "canceling", "deleting"]);

export type Caller = { userId: string; email: string; name: string | null };

export type RepositoryRow = {
  id: number;
  assignment_id: number;
  class_id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
  repository: string;
  git_provider: string;
};

export type WorkspaceRow = {
  id: number;
  coder_user_id: string;
  coder_workspace_name: string;
  coder_workspace_id: string | null;
  superseded_at: string | null;
  restart_started_at: string | null;
  restart_phase: "stopping" | "starting" | null;
  restart_token: string | null;
};

export interface WorkspaceDb {
  getAssignment(assignmentId: number): Promise<{ id: number; class_id: number; git_provider: string } | null>;
  /** The caller's role in the class, if they have one. */
  getEnrollment(userId: string, classId: number): Promise<{ private_profile_id: string; disabled: boolean } | null>;
  getGroupId(assignmentId: number, profileId: string): Promise<number | null>;
  getRepository(repositoryId: number): Promise<RepositoryRow | null>;
  /** The group's repository when groupId is set, otherwise the profile's own. */
  findRepository(assignmentId: number, profileId: string, groupId: number | null): Promise<RepositoryRow | null>;
  getCoderAccount(
    userId: string,
    instanceUrl: string
  ): Promise<{ coder_user_id: string; coder_username: string } | null>;
  saveCoderAccount(row: {
    user_id: string;
    instance_url: string;
    coder_user_id: string;
    coder_username: string;
  }): Promise<void>;
  /** Inserts the row unless one exists for (user, repository, instance), and returns the stored row. */
  reserveWorkspace(row: {
    class_id: number;
    assignment_id: number;
    repository_id: number;
    user_id: string;
    profile_id: string;
    instance_url: string;
    coder_user_id: string;
    coder_workspace_name: string;
    repo_url: string;
  }): Promise<WorkspaceRow>;
  /**
   * Sets superseded_at on the user's other rows for the assignment (a group change left them on
   * another repository) and clears it on this one, so the cleanup job deletes only the old ones.
   */
  markCurrentWorkspace(row: {
    id: number;
    user_id: string;
    assignment_id: number;
    instance_url: string;
  }): Promise<void>;
  getWorkspaceRow(userId: string, repositoryId: number, instanceUrl: string): Promise<WorkspaceRow | null>;
  updateWorkspaceRow(id: number, patch: { coder_workspace_id?: string | null; coder_user_id?: string }): Promise<void>;
  /**
   * Takes the restart claim in phase `stopping` with a new token, unless a claim newer than
   * staleBefore holds it (in either phase). Returns the token if this call won, null if not.
   */
  claimRestart(id: number, staleBefore: string): Promise<string | null>;
  /**
   * Moves the claim to `starting` with a new token, if `token` still holds it. Every move makes a new
   * token, so this is the claim in the phase the caller read. One conditional update, so one caller
   * wins and posts the start. Null if not.
   */
  takeRestartStart(id: number, token: string): Promise<string | null>;
  /** Clears the claim if `token` still holds it. */
  releaseRestart(id: number, token: string): Promise<void>;
  deletionDate(workspaceRowId: number): Promise<string | null>;
}

export type Deps = {
  db: WorkspaceDb;
  coder: CoderConfig;
  forgejoUrl: string;
  /** The request's budget; `db` and `coder` make their calls through budgetFetch with it. */
  budget?: Budget;
  /** Tests pass a fake clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** When the request has to have answered, and the signal that cuts its calls off before that. */
export type Budget = { deadline: number; signal: AbortSignal };

/** A budget of `ms` from now. Its signal fires RESPONSE_RESERVE_MS before the deadline. */
export function startBudget(ms: number): Budget {
  return { deadline: Date.now() + ms, signal: AbortSignal.timeout(ms - RESPONSE_RESERVE_MS) };
}

/** `fetch`, with every request aborted when the budget's signal fires. */
export function budgetFetch(budget: Budget, base: typeof fetch = fetch): typeof fetch {
  return (input, init) =>
    base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal });
}

/** Runs a request's work. A call the budget cut off, anywhere but a restart, is a 504 to retry. */
export async function withinBudget<T>(budget: Budget, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (budget.signal.aborted)
      throw new UserVisibleError("Coder or Pawtograder didn't answer in time. Try again.", 504);
    throw e;
  }
}

function outOfTime(deps: Deps): boolean {
  return deps.budget?.signal.aborted ?? false;
}

/** The Coder email for a Pawtograder user. Only a token for that user carries it. */
export function coderEmail(userId: string): string {
  return `${userId.toLowerCase()}@${CODER_EMAIL_DOMAIN}`;
}

/**
 * Coder usernames are letters, digits and single hyphens, at most 32 characters. The suffix is the
 * start of the Pawtograder user id, so the name is the same on every call and two students with the
 * same local part don't collide.
 */
export function coderUsername(email: string, userId: string): string {
  const local = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 19)
    .replace(/-+$/, "");
  const suffix = userId.replace(/-/g, "").toLowerCase().slice(0, 12);
  return `${local || "user"}-${suffix}`;
}

/**
 * One workspace per student per repository, so a student who moves to another group gets a new
 * workspace for the new repository. At most 24 characters.
 */
export function workspaceName(repositoryId: number): string {
  return `repo-${repositoryId}`;
}

/**
 * Where to send a student who has to link their Forgejo account: Coder's OIDC sign-in, which returns
 * to the provider's link callback. Coder's own authenticate_url (`/external-auth/<id>`) is a page with
 * a button that needs a Coder session first. The callback with no code sends the student straight on
 * to Forgejo's authorize page. Coder keeps only the path of `redirect` (coderd/httpmw/oauth2.go,
 * v2.37.3), so the trip ends on Coder, not back on Pawtograder.
 */
export function linkUrl(coderUrl: string, providerId: string): string {
  const redirect = `/external-auth/${encodeURIComponent(providerId)}/callback`;
  return `${coderUrl}/api/v2/users/oidc/callback?${new URLSearchParams({ redirect })}`;
}

/** The owner and repository names the template's repo_url validation accepts (#1221). */
const CLONE_PATH = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/;

/**
 * The template's repo_url, `<FORGEJO_URL>/<owner>/<repo>.git`. Coder refuses any other shape with a
 * 400, so a repository whose name doesn't fit is refused before anything is created.
 */
export function cloneUrl(forgejoUrl: string, repository: string): string {
  const m = repository.match(CLONE_PATH);
  if (!m) throw new IllegalArgumentError("This repository can't be opened in a workspace");
  return `${forgejoUrl}/${m[1]}/${m[2]}.git`;
}

/** The repository the caller may open a workspace on, or a SecurityError. */
export async function resolveRepository(
  db: WorkspaceDb,
  caller: Caller,
  request: WorkspaceOpenRequest
): Promise<{ repo: RepositoryRow; profileId: string; classId: number }> {
  if (!Number.isInteger(request.assignment_id) || request.assignment_id <= 0) {
    throw new IllegalArgumentError("assignment_id must be a positive integer");
  }
  if (request.repository_id !== undefined && (!Number.isInteger(request.repository_id) || request.repository_id <= 0)) {
    throw new IllegalArgumentError("repository_id must be a positive integer");
  }
  const assignment = await db.getAssignment(request.assignment_id);
  if (!assignment) throw new NotFoundError("Assignment not found");
  const enrollment = await db.getEnrollment(caller.userId, assignment.class_id);
  if (!enrollment || enrollment.disabled) throw new SecurityError("You are not enrolled in this course");
  if (assignment.git_provider !== "forgejo") {
    throw new IllegalArgumentError("This assignment's repositories are not on Forgejo");
  }
  const profileId = enrollment.private_profile_id;
  const groupId = await db.getGroupId(assignment.id, profileId);

  let repo: RepositoryRow | null;
  if (request.repository_id !== undefined) {
    repo = await db.getRepository(request.repository_id);
    const mine =
      repo !== null &&
      repo.assignment_id === assignment.id &&
      (repo.profile_id === profileId || (groupId !== null && repo.assignment_group_id === groupId));
    if (!mine) throw new SecurityError("This repository is not yours");
  } else {
    repo = await db.findRepository(assignment.id, profileId, groupId);
    if (!repo) throw new NotFoundError("You don't have a repository for this assignment yet");
  }
  if (repo!.git_provider !== "forgejo") {
    throw new IllegalArgumentError("This repository is not on Forgejo");
  }
  return { repo: repo!, profileId, classId: assignment.class_id };
}

/** A Coder user the caller can't sign in to and that isn't theirs to adopt. Staff have to remove it. */
export class CoderAccountConflict extends Error {
  constructor(readonly user: { id?: string; username: string }) {
    super(`Coder user ${user.username} isn't linked to the caller's Pawtograder login`);
  }
}

function accountConflict(user: { id?: string; username: string }): WorkspaceOpenResponse {
  return {
    status: "account_conflict",
    message: `Your Coder account "${user.username}" isn't linked to your Pawtograder login, so you can't sign in to it. Ask course staff to remove it in Coder, then open the workspace again.`,
    coder_user_id: user.id
  };
}

/**
 * The caller's Coder user, created if missing. A second call finds the stored row. When the create
 * fails (409 for a taken username or email, or a 500 when two creates race past Coder's existence
 * check, coderd/users.go:532-540 and :636-641), an existing user is adopted only if it is bound to
 * the caller's subject, or is unbound with the caller's Coder email. Any other user in the way is a
 * CoderAccountConflict.
 */
export async function ensureCoderUser(deps: Deps, caller: Caller): Promise<CoderUser> {
  const { db, coder } = deps;
  const stored = await db.getCoderAccount(caller.userId, coder.url);
  if (stored) {
    // By username: Coder still answers a deleted user by id (GetUserByID has no `deleted` filter),
    // and staff delete a user to clear an account conflict.
    const user = await getUser(coder, stored.coder_username);
    if (user?.id === stored.coder_user_id) return user;
  }

  const username = coderUsername(caller.email, caller.userId);
  const organizationId = await getOrganizationId(coder, CODER_ORGANIZATION);
  const created = await createOidcUser(coder, {
    username,
    email: coderEmail(caller.userId),
    name: caller.name ?? "",
    organizationId
  });
  let user = created.user;
  if (created.error) {
    user = await adoptExistingUser(deps, caller, username);
    if (!user) {
      if (created.error.status === 409) throw new CoderAccountConflict({ username });
      throw created.error;
    }
  }
  await db.saveCoderAccount({
    user_id: caller.userId,
    instance_url: coder.url,
    coder_user_id: user!.id,
    coder_username: user!.username
  });
  return user!;
}

/** The user a failed create left, if the caller may have it; null if there is none. */
async function adoptExistingUser(deps: Deps, caller: Caller, username: string): Promise<CoderUser | null> {
  const email = coderEmail(caller.userId);
  const byName = await getUser(deps.coder, username);
  const byEmail = byName?.email.toLowerCase() === email ? byName : await findUserByEmail(deps.coder, email);
  for (const user of [byName, byEmail]) {
    if (!user || user.login_type !== "oidc") continue;
    const subject = await getBoundOidcSubject(deps.coder, user.id);
    if (subject === caller.userId) return user;
    // A concurrent call made it a moment ago, or an earlier call's row write failed. Only the
    // caller's own token carries this email, so their first sign-in is the one that binds it.
    if (subject === null && user.email.toLowerCase() === email) return user;
    throw new CoderAccountConflict(user);
  }
  return null;
}

function firstAgent(ws: CoderWorkspace): CoderAgent | null {
  return ws.latest_build.resources.flatMap((r) => r.agents ?? [])[0] ?? null;
}

function stepForScript(displayName: string): WorkspaceStep {
  if (displayName === "Git Clone") return "clone";
  if (displayName === "Startup Script") return "editor";
  return "build";
}

function workspacePage(coder: CoderConfig, ws: CoderWorkspace): string {
  return `${coder.url}/@${encodeURIComponent(ws.owner_name)}/${encodeURIComponent(ws.name)}`;
}

async function editorUrl(coder: CoderConfig, ws: CoderWorkspace, agent: CoderAgent): Promise<string> {
  const app = agent.apps?.find((a) => a.slug === "code-server");
  if (!app) return workspacePage(coder, ws);
  // The app's own URL carries ?folder=/home/coder/<repo>.
  const query = app.url ? new URL(app.url).search : "";
  const host = app.subdomain && app.subdomain_name ? await getAppHost(coder) : "";
  if (host) {
    return `${new URL(coder.url).protocol}//${host.replace("*", app.subdomain_name!)}/${query}`;
  }
  return `${workspacePage(coder, ws)}.${encodeURIComponent(agent.name)}/apps/${app.slug}/${query}`;
}

/**
 * A running workspace whose agent failed to start or lost its connection. A start build alone
 * doesn't help: the build is already running. workspace-open stops and starts it.
 */
export function needsRestart(ws: CoderWorkspace): boolean {
  const build = ws.latest_build;
  const agent = firstAgent(ws);
  if (build.transition !== "start" || build.status !== "running" || !agent) return false;
  return (
    agent.lifecycle_state === "start_error" ||
    agent.lifecycle_state === "start_timeout" ||
    agent.status === "disconnected" ||
    agent.status === "timeout"
  );
}

/**
 * Maps Coder's build and agent state onto #1170's steps, with the failing script's last log lines.
 * `restarting` says a restart claim is held: a workspace-open is stopping the workspace, or its stop
 * has finished and the start is being posted. That reads `restarting` until a start build exists.
 */
export async function describeWorkspace(
  coder: CoderConfig,
  ws: CoderWorkspace,
  restarting = false
): Promise<WorkspaceOpenResponse> {
  const build = ws.latest_build;
  const agent = firstAgent(ws);
  const base: WorkspaceOpenResponse = {
    status: "starting",
    workspace_id: ws.id,
    workspace_name: ws.name,
    coder_user_id: ws.owner_id,
    redirect_url: workspacePage(coder, ws),
    build: { status: build.status, transition: build.transition, error: build.job?.error || null },
    agent: agent ? { lifecycle_state: agent.lifecycle_state, status: agent.status } : null
  };

  if (
    restarting &&
    (build.transition === "stop" ? !["failed", "canceled", "canceling"].includes(build.status) : needsRestart(ws))
  ) {
    return { ...base, status: "restarting", step: "build" };
  }
  if (build.transition !== "start" || ["stopping", "stopped", "deleting", "deleted"].includes(build.status)) {
    return { ...base, status: "not_started" };
  }
  if (build.status === "failed" || build.status === "canceled" || build.status === "canceling") {
    const message = build.job?.error || "The workspace build failed.";
    return {
      ...base,
      status: "failed",
      step: "build",
      message,
      failure: { step: "build", script: null, exit_code: null, log_lines: [message] }
    };
  }
  if (build.status !== "running" || !agent) return { ...base, step: "build" };

  const scripts = agent.scripts ?? [];
  if (agent.lifecycle_state === "start_error" || agent.lifecycle_state === "start_timeout") {
    const failing =
      scripts.find((s) => s.status && s.status !== "ok") ??
      (agent.lifecycle_state === "start_timeout" ? scripts.find((s) => !s.status) : undefined);
    const step = failing ? stepForScript(failing.display_name) : "build";
    const logs = failing ? await getAgentLogs(coder, agent.id) : [];
    const output = logs.filter((l) => l.source_id === failing?.log_source_id).map((l) => l.output);
    const log_lines = output.slice(-LOG_LINES);
    // The template's clone script exits 1 on every failure; its last line says why (#1221).
    const reason =
      failing?.display_name === "Git Clone" ? output.findLast((l) => l.startsWith("Git Clone failed:")) : undefined;
    const what = failing ? `"${failing.display_name}"` : "A startup step";
    const message =
      reason ??
      (agent.lifecycle_state === "start_timeout"
        ? `${what} did not finish in time.`
        : `${what} failed${failing?.exit_code !== undefined ? ` with exit code ${failing.exit_code}` : ""}.`);
    return {
      ...base,
      status: "failed",
      step,
      message,
      failure: { step, script: failing?.display_name ?? null, exit_code: failing?.exit_code ?? null, log_lines }
    };
  }
  // Lifecycle records how startup went, not whether the agent is still there: a crashed pod keeps
  // `ready`. A lost or never-connected agent is failed, and the next open restarts it.
  if (agent.status === "disconnected" || agent.status === "timeout") {
    const message =
      agent.status === "timeout"
        ? "The workspace did not connect in time. Open it again to restart it."
        : "The workspace lost its connection. Open it again to restart it.";
    return {
      ...base,
      status: "failed",
      step: "build",
      message,
      failure: { step: "build", script: null, exit_code: null, log_lines: [] }
    };
  }
  if (agent.status !== "connected") return { ...base, step: "build" };

  switch (agent.lifecycle_state) {
    case "created":
      return { ...base, step: "build" };
    case "starting": {
      const clone = scripts.find((s) => s.display_name === "Git Clone");
      return { ...base, step: clone && !clone.status ? "clone" : "editor" };
    }
    case "ready": {
      const app = agent.apps?.find((a) => a.slug === "code-server");
      if (app?.health === "initializing") return { ...base, step: "editor" };
      if (app?.health === "unhealthy") {
        const message = "VS Code did not start in the workspace.";
        return {
          ...base,
          status: "failed",
          step: "editor",
          message,
          failure: { step: "editor", script: null, exit_code: null, log_lines: [] }
        };
      }
      return { ...base, status: "ready", redirect_url: await editorUrl(coder, ws, agent) };
    }
    default:
      // shutting_down, shutdown_timeout, shutdown_error, off.
      return { ...base, status: "not_started" };
  }
}

async function withDeletionDate(
  deps: Deps,
  rowId: number,
  response: WorkspaceOpenResponse
): Promise<WorkspaceOpenResponse> {
  try {
    return { ...response, deletion_date: await deps.db.deletionDate(rowId) };
  } catch (e) {
    // The date is a detail; the next status read has it.
    if (outOfTime(deps)) return response;
    throw e;
  }
}

function clock(deps: Deps): () => number {
  return deps.now ?? Date.now;
}

function restartClaimed(deps: Deps, row: WorkspaceRow): boolean {
  return row.restart_started_at !== null && Date.parse(row.restart_started_at) > clock(deps)() - RESTART_CLAIM_MS;
}

/**
 * A restart is under way: its claim is fresh, or its stop is Coder's to finish. A stop can outlast
 * the claim (a pod held by a finalizer), and the first read after it posts the start.
 */
function restartUnderWay(deps: Deps, row: WorkspaceRow, ws: CoderWorkspace): boolean {
  return restartClaimed(deps, row) || (row.restart_token !== null && ws.latest_build.transition === "stop");
}

async function recordWorkspaceId(db: WorkspaceDb, row: WorkspaceRow, ws: CoderWorkspace): Promise<WorkspaceRow> {
  if (row.coder_workspace_id === ws.id) return row;
  await db.updateWorkspaceRow(row.id, { coder_workspace_id: ws.id });
  return { ...row, coder_workspace_id: ws.id };
}

function isStopped(ws: CoderWorkspace): boolean {
  return ws.latest_build.transition === "stop" && ws.latest_build.status === "stopped";
}

/**
 * A `starting` claim whose start build exists. While a claim is `starting` only its holder posts a
 * start, so the build is the holder's, which didn't get to give the claim up (it ran out of time or
 * died after posting). Gives it up, so the workspace reads as it is.
 */
async function settleRestart(deps: Deps, row: WorkspaceRow, ws: CoderWorkspace): Promise<WorkspaceRow> {
  if (row.restart_phase !== "starting" || ws.latest_build.transition !== "start") return row;
  await deps.db.releaseRestart(row.id, row.restart_token!);
  return { ...row, restart_started_at: null, restart_phase: null, restart_token: null };
}

/**
 * Posts the start of a restart whose stop has finished, if this call wins the claim's move from the
 * state `token` holds to `starting`. Whoever loses posts nothing: while the claim is `starting`, its
 * holder is the only caller that may. The claim is given up once the start is posted. A failed start
 * leaves the workspace stopped, which reads not_started, and the next open starts it. Returns
 * restarting: true when another call posts the start, or this one has or had too little time.
 */
async function startRestart(
  deps: Deps,
  rowId: number,
  token: string,
  ws: CoderWorkspace,
  deadline: number
): Promise<{ ws: CoderWorkspace; restarting: boolean }> {
  const { db, coder } = deps;
  // The claim stays as it is for a call with more time.
  if (deadline - clock(deps)() < CLAIM_MIN_LEFT_MS) return { ws, restarting: true };
  try {
    const starting = await db.takeRestartStart(rowId, token);
    if (!starting) return { ws, restarting: true };
    const error = await postBuild(coder, ws.id, "start");
    await db.releaseRestart(rowId, starting);
    if (error && error.status !== 409) throw error;
    return { ws: (await getWorkspace(coder, ws.id)) ?? ws, restarting: false };
  } catch (e) {
    // The claim stays. If the start reached Coder, the next read sees its build and settles it.
    if (outOfTime(deps)) return { ws, restarting: true };
    throw e;
  }
}

/**
 * The start of a restart whose stop has finished: the open that stopped it answered first, or its
 * holder is gone. A fresh `starting` claim has its poster. A stale one's holder answered long ago
 * (RESTART_CLAIM_MS), and its start never reached Coder, or the workspace wouldn't read stopped.
 * Returns restarting: true when another call posts the start.
 */
async function finishRestart(
  deps: Deps,
  row: WorkspaceRow,
  ws: CoderWorkspace,
  deadline: number
): Promise<{ ws: CoderWorkspace; restarting: boolean }> {
  if (row.restart_phase === "starting" && restartClaimed(deps, row)) return { ws, restarting: true };
  return await startRestart(deps, row.id, row.restart_token!, ws, deadline);
}

/**
 * Stops the workspace and, if the stop finishes in time, starts it again. The home volume outlives
 * the stop (#1221's PVC has no count), so the clone and any work on it are kept. Only one call
 * restarts a workspace at a time: the row's restart claim decides which. Returns the workspace and
 * whether the restart is still under way without a start build (another call holds the claim, or
 * time ran short; the claim then stays `stopping`, and a status read posts the start).
 */
async function restartWorkspace(
  deps: Deps,
  row: WorkspaceRow,
  ws: CoderWorkspace,
  deadline: number
): Promise<{ ws: CoderWorkspace; restarting: boolean }> {
  const { db, coder } = deps;
  const now = clock(deps);
  // Too little time to post the stop: the workspace stays as it is for the next open.
  if (deadline - now() < CLAIM_MIN_LEFT_MS) return { ws, restarting: true };
  const token = await db.claimRestart(row.id, new Date(now() - RESTART_CLAIM_MS).toISOString());
  if (!token) return { ws, restarting: true };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    const stopError = await postBuild(coder, ws.id, "stop");
    if (stopError && stopError.status !== 409) {
      await db.releaseRestart(row.id, token);
      throw stopError;
    }
    for (;;) {
      ws = (await getWorkspace(coder, ws.id)) ?? ws;
      // A 409 means another build was already active, so this may not be a stop. A stop that failed
      // or a build that isn't a stop is reported as it is.
      const stopping = ws.latest_build.transition === "stop" && BUILD_IN_PROGRESS.has(ws.latest_build.status);
      if (!isStopped(ws) && !stopping) {
        await db.releaseRestart(row.id, token);
        return { ws, restarting: false };
      }
      // Checked before the start too, which needs time of its own.
      if (now() + RESTART_POLL_MS > deadline - RESPONSE_RESERVE_MS) return { ws, restarting: true };
      if (isStopped(ws)) break;
      await sleep(RESTART_POLL_MS);
    }
  } catch (e) {
    // The claim stays `stopping`, and a status read starts the workspace once the stop finishes.
    if (outOfTime(deps)) return { ws, restarting: true };
    throw e;
  }
  return await startRestart(deps, row.id, token, ws, deadline);
}

/**
 * Creates the caller's Coder user and workspace if they're missing, starts the workspace if it's
 * stopped, restarts it if its agent failed, and says where to send the student.
 */
export async function openWorkspace(
  deps: Deps,
  caller: Caller,
  request: WorkspaceOpenRequest
): Promise<WorkspaceOpenResponse> {
  const { db, coder } = deps;
  const deadline = deps.budget?.deadline ?? clock(deps)() + OPEN_BUDGET_MS;
  const { repo, profileId, classId } = await resolveRepository(db, caller, request);
  const repoUrl = cloneUrl(deps.forgejoUrl, repo.repository);
  let user: CoderUser;
  try {
    user = await ensureCoderUser(deps, caller);
  } catch (e) {
    if (e instanceof CoderAccountConflict) return accountConflict(e.user);
    throw e;
  }

  // Coder binds the subject on the student's first sign-in, which the link URL starts with.
  const template = await getTemplate(coder, CODER_ORGANIZATION, CODER_TEMPLATE);
  const subject = await getBoundOidcSubject(coder, user.id);
  if (subject !== null && subject !== caller.userId) {
    throw new SecurityError("Your Coder account is bound to a different Pawtograder login");
  }
  if (subject === null && user.email.toLowerCase() !== coderEmail(caller.userId)) {
    // Made with a real email, before Coder sign-ins used the Coder email, or by hand. Coder finds a
    // first sign-in by the Coder email, so the student can never sign in to it, and Coder's API
    // can't change a user's email (coderd/users.go:938-945 keeps it; SCIM changes only `active`).
    return accountConflict(user);
  }
  const missing = (await getExternalAuth(coder, template.active_version_id, user.id)).find(
    (e) => !e.optional && !e.authenticated
  );
  if (subject === null || missing) {
    const authenticate_url = linkUrl(coder.url, missing?.id ?? "forgejo");
    return {
      status: "needs_linking",
      message: `Link your ${missing?.display_name ?? "Forgejo"} account in Coder, then open the workspace again.`,
      authenticate_url,
      redirect_url: authenticate_url,
      coder_user_id: user.id
    };
  }

  const name = workspaceName(repo.id);
  let row = await db.reserveWorkspace({
    class_id: classId,
    assignment_id: repo.assignment_id,
    repository_id: repo.id,
    user_id: caller.userId,
    profile_id: profileId,
    instance_url: coder.url,
    coder_user_id: user.id,
    coder_workspace_name: name,
    repo_url: repoUrl
  });
  await db.markCurrentWorkspace({
    id: row.id,
    user_id: caller.userId,
    assignment_id: repo.assignment_id,
    instance_url: coder.url
  });
  if (row.coder_user_id !== user.id) {
    // The Coder user was deleted and made again. Coder won't delete a user who has workspaces.
    await db.updateWorkspaceRow(row.id, { coder_user_id: user.id, coder_workspace_id: null });
    row = { ...row, coder_user_id: user.id, coder_workspace_id: null };
  }

  let restarting = false;
  // The id is recorded before anything the budget may cut off: status reads find the workspace by it.
  let ws = await getWorkspaceByName(coder, user.id, name);
  if (ws) {
    row = await recordWorkspaceId(db, row, ws);
    row = await settleRestart(deps, row, ws);
  }
  if (!ws) {
    const created = await createWorkspace(coder, user.id, {
      template_id: template.id,
      name,
      // Coder copies the TTL into a workspace only at create.
      ttl_ms: template.default_ttl_ms,
      rich_parameter_values: [{ name: "repo_url", value: repoUrl }]
    });
    if (created.error?.status === 403 && created.error.body?.validations?.some((v) => v.field === "external_auth")) {
      // The link went away between the check and the create.
      const ext = (await getExternalAuth(coder, template.active_version_id, user.id)).find(
        (e) => !e.optional && !e.authenticated
      );
      const authenticate_url = linkUrl(coder.url, ext?.id ?? "forgejo");
      return { status: "needs_linking", authenticate_url, redirect_url: authenticate_url, coder_user_id: user.id };
    } else if (created.error) {
      // A concurrent call created it first. Coder answers 409 when its name check sees that
      // workspace, and 500 when both requests pass the check and its unique index refuses the
      // second insert (coderd/workspaces.go:621-623 has a TODO about it).
      ws = await getWorkspaceByName(coder, user.id, name);
      if (!ws) throw created.error;
    } else {
      ws = created.workspace;
    }
    if (!ws) throw new Error(`Coder workspace ${name} was neither created nor found`);
    row = await recordWorkspaceId(db, row, ws);
  } else if (needsRestart(ws)) {
    // Retry after a startup failure, such as a clone that timed out, or a lost agent.
    ({ ws, restarting } = await restartWorkspace(deps, row, ws, deadline));
  } else if (isStopped(ws) && row.restart_token) {
    // A restart whose stop has finished: an earlier open's, or one whose holder is gone. Taken
    // through the claim like a status read does, so the two never both post its start.
    ({ ws, restarting } = await finishRestart(deps, row, ws, deadline));
  } else if (isStopped(ws) || ws.latest_build.status === "failed" || ws.latest_build.status === "canceled") {
    // Stopped after an hour unused, or a build that failed (Retry). An abandoned claim goes too.
    const error = await postBuild(coder, ws.id, "start");
    if (row.restart_token) await db.releaseRestart(row.id, row.restart_token);
    if (error && error.status !== 409) throw error;
    ws = (await getWorkspace(coder, ws.id)) ?? ws;
  } else {
    restarting = restartUnderWay(deps, row, ws);
  }

  // Out of time in a restart: answer with what's known, and leave the rest to status reads.
  if (outOfTime(deps)) return await describeWorkspace(coder, ws, restarting);
  return await withDeletionDate(deps, row.id, await describeWorkspace(coder, ws, restarting));
}

/**
 * The caller's workspace for the repository they would open. Never creates, stops or restarts
 * anything, and starts a workspace only to finish a restart that workspace-open began.
 */
export async function workspaceStatus(
  deps: Deps,
  caller: Caller,
  request: WorkspaceOpenRequest
): Promise<WorkspaceOpenResponse> {
  const { db, coder } = deps;
  const deadline = deps.budget?.deadline ?? clock(deps)() + STATUS_BUDGET_MS;
  const { repo } = await resolveRepository(db, caller, request);
  let row = await db.getWorkspaceRow(caller.userId, repo.id, coder.url);
  if (!row?.coder_workspace_id) return { status: "not_started" };
  let ws = await getWorkspace(coder, row.coder_workspace_id);
  if (!ws) return await withDeletionDate(deps, row.id, { status: "not_started" });
  row = await settleRestart(deps, row, ws);
  let restarting = restartUnderWay(deps, row, ws);
  if (row.restart_token && isStopped(ws)) {
    // workspace-open stopped the workspace to restart it and answered before the stop finished, or
    // the call that held the claim is gone. Nothing else would start it, so this is the one build a
    // status read posts. A stale claim on a workspace that isn't stopped is left to the next open.
    ({ ws, restarting } = await finishRestart(deps, row, ws, deadline));
  }
  return await withDeletionDate(deps, row.id, await describeWorkspace(coder, ws, restarting));
}
