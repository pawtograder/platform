// What workspace-open and workspace-status do (#1222), with the database and Coder passed in so the
// tests can run against fakes. Template contract: #1221 (template `kubernetes` in org `default`,
// parameter `repo_url`, external auth `forgejo`).
//
// Binding the Coder user to the Pawtograder login. Coder v2.37.3 binds an OIDC user by
// `user_links.linked_id` (issuer + subject), and only its login handler writes that column. The API
// that creates users can't set it. So the first OIDC login that lands on the user we create finds it
// by email and binds that subject; every later login is matched by subject, and a different subject
// with the same email is refused ("Account already linked"). Before a workspace is created or
// started, we read the bound subject back and require it to be the caller's Pawtograder user id. A
// user who hasn't signed in to Coder yet gets the link page, which signs them in first.

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
  startWorkspace
} from "./CoderWrapper.ts";
import { IllegalArgumentError, NotFoundError, SecurityError, UserVisibleError } from "./HandlerUtils.ts";

export const CODER_ORGANIZATION = "default";
export const CODER_TEMPLATE = "kubernetes";
const LOG_LINES = 20;

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
};

export interface WorkspaceDb {
  getAssignment(assignmentId: number): Promise<{ id: number; class_id: number; git_provider: string } | null>;
  /** The caller's role in the class, if they have one. */
  getEnrollment(userId: string, classId: number): Promise<{ private_profile_id: string; disabled: boolean } | null>;
  getGroupId(assignmentId: number, profileId: string): Promise<number | null>;
  getRepository(repositoryId: number): Promise<RepositoryRow | null>;
  /** The group's repository when groupId is set, otherwise the profile's own. */
  findRepository(assignmentId: number, profileId: string, groupId: number | null): Promise<RepositoryRow | null>;
  getCoderAccount(userId: string, instanceUrl: string): Promise<{ coder_user_id: string } | null>;
  saveCoderAccount(row: {
    user_id: string;
    instance_url: string;
    coder_user_id: string;
    coder_username: string;
  }): Promise<void>;
  /** Inserts the row unless one exists for (user, assignment, instance), and returns the stored row. */
  reserveWorkspace(row: {
    class_id: number;
    assignment_id: number;
    user_id: string;
    profile_id: string;
    instance_url: string;
    coder_user_id: string;
    coder_workspace_name: string;
    repo_url: string;
  }): Promise<WorkspaceRow>;
  getWorkspaceRow(userId: string, assignmentId: number, instanceUrl: string): Promise<WorkspaceRow | null>;
  updateWorkspaceRow(id: number, patch: { coder_workspace_id?: string | null; coder_user_id?: string }): Promise<void>;
  deletionDate(workspaceRowId: number): Promise<string | null>;
}

export type Deps = { db: WorkspaceDb; coder: CoderConfig; forgejoUrl: string };

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

/** One workspace per student per assignment. At most 30 characters. */
export function workspaceName(assignmentId: number): string {
  return `assignment-${assignmentId}`;
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

function conflict(): UserVisibleError {
  return new UserVisibleError(
    "A Coder account with your email already exists and isn't linked to your Pawtograder login. Ask course staff to remove it.",
    409
  );
}

/**
 * The caller's Coder user, created if missing. A second call finds the stored row. If the row was
 * lost after the user was created, the create answers 409 and the user is adopted only if it is
 * bound to the caller's subject, or is our deterministic username, unbound, with the caller's email.
 */
export async function ensureCoderUser(deps: Deps, caller: Caller): Promise<CoderUser> {
  const { db, coder } = deps;
  const stored = await db.getCoderAccount(caller.userId, coder.url);
  if (stored) {
    const user = await getUser(coder, stored.coder_user_id);
    if (user) return user;
  }

  const username = coderUsername(caller.email, caller.userId);
  const organizationId = await getOrganizationId(coder, CODER_ORGANIZATION);
  const created = await createOidcUser(coder, {
    username,
    email: caller.email,
    name: caller.name ?? "",
    organizationId
  });
  let user = created.user;
  if (created.error) {
    if (created.error.status !== 409) throw created.error;
    user = await adoptExistingUser(deps, caller, username);
  }
  await db.saveCoderAccount({
    user_id: caller.userId,
    instance_url: coder.url,
    coder_user_id: user!.id,
    coder_username: user!.username
  });
  return user!;
}

async function adoptExistingUser(deps: Deps, caller: Caller, username: string): Promise<CoderUser> {
  const byName = await getUser(deps.coder, username);
  if (byName && byName.login_type === "oidc") {
    const subject = await getBoundOidcSubject(deps.coder, byName.id);
    if (subject === caller.userId) return byName;
    // A concurrent call made it a moment ago, or an earlier call's row write failed.
    if (subject === null && byName.email.toLowerCase() === caller.email.toLowerCase()) return byName;
    throw conflict();
  }
  const byEmail = await findUserByEmail(deps.coder, caller.email);
  if (byEmail && byEmail.login_type === "oidc") {
    if ((await getBoundOidcSubject(deps.coder, byEmail.id)) === caller.userId) return byEmail;
  }
  throw conflict();
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

/** Maps Coder's build and agent state onto #1170's steps, with the failing script's last log lines. */
export async function describeWorkspace(coder: CoderConfig, ws: CoderWorkspace): Promise<WorkspaceOpenResponse> {
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
  switch (agent.lifecycle_state) {
    case "created":
      return { ...base, step: "build" };
    case "starting": {
      const clone = scripts.find((s) => s.display_name === "Git Clone");
      return { ...base, step: clone && !clone.status ? "clone" : "editor" };
    }
    case "start_error":
    case "start_timeout": {
      const failing =
        scripts.find((s) => s.status && s.status !== "ok") ??
        (agent.lifecycle_state === "start_timeout" ? scripts.find((s) => !s.status) : undefined);
      const step = failing ? stepForScript(failing.display_name) : "build";
      const logs = failing ? await getAgentLogs(coder, agent.id) : [];
      const log_lines = logs
        .filter((l) => l.source_id === failing?.log_source_id)
        .map((l) => l.output)
        .slice(-LOG_LINES);
      const what = failing ? `"${failing.display_name}"` : "A startup step";
      const message =
        agent.lifecycle_state === "start_timeout"
          ? `${what} did not finish in time.`
          : `${what} failed${failing?.exit_code !== undefined ? ` with exit code ${failing.exit_code}` : ""}.`;
      return {
        ...base,
        status: "failed",
        step,
        message,
        failure: { step, script: failing?.display_name ?? null, exit_code: failing?.exit_code ?? null, log_lines }
      };
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
  db: WorkspaceDb,
  rowId: number,
  response: WorkspaceOpenResponse
): Promise<WorkspaceOpenResponse> {
  return { ...response, deletion_date: await db.deletionDate(rowId) };
}

/**
 * Creates the caller's Coder user and workspace if they're missing, starts the workspace if it's
 * stopped, and says where to send the student.
 */
export async function openWorkspace(
  deps: Deps,
  caller: Caller,
  request: WorkspaceOpenRequest
): Promise<WorkspaceOpenResponse> {
  const { db, coder } = deps;
  const { repo, profileId, classId } = await resolveRepository(db, caller, request);
  const user = await ensureCoderUser(deps, caller);

  // Coder binds the subject on the student's first sign-in, which the link page asks for.
  const template = await getTemplate(coder, CODER_ORGANIZATION, CODER_TEMPLATE);
  const subject = await getBoundOidcSubject(coder, user.id);
  if (subject !== null && subject !== caller.userId) {
    throw new SecurityError("Your Coder account is bound to a different Pawtograder login");
  }
  const missing = (await getExternalAuth(coder, template.active_version_id, user.id)).find(
    (e) => !e.optional && !e.authenticated
  );
  if (subject === null || missing) {
    const authenticate_url = missing?.authenticate_url ?? `${coder.url}/external-auth/forgejo`;
    return {
      status: "needs_linking",
      message: `Link your ${missing?.display_name ?? "Forgejo"} account in Coder, then open the workspace again.`,
      authenticate_url,
      redirect_url: authenticate_url,
      coder_user_id: user.id
    };
  }

  const name = workspaceName(repo.assignment_id);
  let row = await db.reserveWorkspace({
    class_id: classId,
    assignment_id: repo.assignment_id,
    user_id: caller.userId,
    profile_id: profileId,
    instance_url: coder.url,
    coder_user_id: user.id,
    coder_workspace_name: name,
    repo_url: `${deps.forgejoUrl}/${repo.repository}.git`
  });
  if (row.coder_user_id !== user.id) {
    // The Coder user was deleted and made again. Coder won't delete a user who has workspaces.
    await db.updateWorkspaceRow(row.id, { coder_user_id: user.id, coder_workspace_id: null });
    row = { ...row, coder_user_id: user.id, coder_workspace_id: null };
  }

  let ws = await getWorkspaceByName(coder, user.id, name);
  if (!ws) {
    const created = await createWorkspace(coder, user.id, {
      template_id: template.id,
      name,
      // Coder copies the TTL into a workspace only at create.
      ttl_ms: template.default_ttl_ms,
      rich_parameter_values: [{ name: "repo_url", value: `${deps.forgejoUrl}/${repo.repository}.git` }]
    });
    if (created.error?.status === 409) {
      // A concurrent call created it first.
      ws = await getWorkspaceByName(coder, user.id, name);
    } else if (
      created.error?.status === 403 &&
      created.error.body?.validations?.some((v) => v.field === "external_auth")
    ) {
      // The link went away between the check and the create.
      const ext = (await getExternalAuth(coder, template.active_version_id, user.id)).find(
        (e) => !e.optional && !e.authenticated
      );
      const authenticate_url = ext?.authenticate_url ?? `${coder.url}/external-auth/forgejo`;
      return { status: "needs_linking", authenticate_url, redirect_url: authenticate_url, coder_user_id: user.id };
    } else if (created.error) {
      throw created.error;
    } else {
      ws = created.workspace;
    }
    if (!ws) throw new Error(`Coder workspace ${name} was neither created nor found`);
  } else if (
    (ws.latest_build.transition === "stop" && ws.latest_build.status === "stopped") ||
    ws.latest_build.status === "failed" ||
    ws.latest_build.status === "canceled"
  ) {
    // Stopped after an hour unused, or a build that failed (Retry).
    const error = await startWorkspace(coder, ws.id);
    if (error && error.status !== 409) throw error;
    ws = (await getWorkspace(coder, ws.id)) ?? ws;
  }

  if (row.coder_workspace_id !== ws.id) {
    await db.updateWorkspaceRow(row.id, { coder_workspace_id: ws.id });
  }
  return await withDeletionDate(db, row.id, await describeWorkspace(coder, ws));
}

/** The caller's workspace for the assignment, read only. Never creates or starts anything. */
export async function workspaceStatus(
  deps: Deps,
  caller: Caller,
  request: WorkspaceOpenRequest
): Promise<WorkspaceOpenResponse> {
  const { db, coder } = deps;
  const { repo } = await resolveRepository(db, caller, request);
  const row = await db.getWorkspaceRow(caller.userId, repo.assignment_id, coder.url);
  if (!row?.coder_workspace_id) return { status: "not_started" };
  const ws = await getWorkspace(coder, row.coder_workspace_id);
  if (!ws) return await withDeletionDate(db, row.id, { status: "not_started" });
  return await withDeletionDate(db, row.id, await describeWorkspace(coder, ws));
}
