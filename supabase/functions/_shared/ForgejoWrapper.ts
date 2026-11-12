// Forgejo admin API calls for the accounts (#1092) and repos (#1093) Pawtograder creates.
//
// Admin Basic auth, not an admin token: a token can't act on other users' behalf (Forgejo answers
// 401 "auth method not allowed"), which repo provisioning (#1093) needs.

export type ForgejoConfig = { url: string; authorization: string; authSourceId: number };
export type ForgejoUser = { id: number; login: string; login_name: string; source_id: number };

/**
 * Null until the deployment sets all four. FORGEJO_AUTH_SOURCE_ID is the `pawtograder` login
 * source's id from `forgejo admin auth list`; Forgejo's API doesn't list login sources.
 */
export function forgejoConfig(env: { get(name: string): string | undefined } = Deno.env): ForgejoConfig | null {
  const url = env.get("FORGEJO_URL")?.replace(/\/+$/, "");
  const username = env.get("FORGEJO_ADMIN_USERNAME");
  const password = env.get("FORGEJO_ADMIN_PASSWORD");
  const authSourceId = Number(env.get("FORGEJO_AUTH_SOURCE_ID"));
  if (!url || !username || !password || !Number.isInteger(authSourceId) || authSourceId <= 0) {
    return null;
  }
  return { url, authorization: "Basic " + btoa(`${username}:${password}`), authSourceId };
}

async function forgejo(config: ForgejoConfig, method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${config.url}/api/v1${path}`, {
    method,
    headers: { Authorization: config.authorization, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A stalled call would hold up the rest of a sequential pass until the runtime limit.
    signal: AbortSignal.timeout(15_000)
  });
}

// These errors go to Sentry, and Forgejo's response text can name the user ("e-mail already in use
// [email: a@b.edu]"). So only a known message is kept, never the text itself; the status stays.
const KNOWN_REASONS = [
  "e-mail already in use",
  "user already exists",
  "name is reserved",
  "this is not a template repo",
  "the repository with the same name already exists"
];

function reason(text: string): string {
  const lower = text.toLowerCase();
  return KNOWN_REASONS.find((known) => lower.includes(known)) ?? "unrecognized response";
}

async function failure(res: Response, what: string): Promise<Error> {
  return new Error(`Forgejo ${what} failed: ${res.status} ${reason(await res.text())}`);
}

// Forgejo caps usernames at 40 characters; 30 leaves room for a collision suffix.
export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0].toLowerCase();
  const cleaned = local
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 30)
    .replace(/[-_.]+$/g, "");
  return cleaned || "pawtograder-user";
}

/** The account bound to this Pawtograder user under the pawtograder login source, if one exists. */
export async function findAccountForUser(config: ForgejoConfig, userId: string): Promise<ForgejoUser | null> {
  const query = new URLSearchParams({ source_id: String(config.authSourceId), login_name: userId });
  const res = await forgejo(config, "GET", `/admin/users?${query}`);
  if (!res.ok) throw await failure(res, "user search");
  const users = (await res.json()) as ForgejoUser[];
  return users.find((u) => u.login_name === userId && u.source_id === config.authSourceId) ?? null;
}

/**
 * Adopts the account already bound to this user, or creates one. login_name is the Pawtograder user
 * id, which is the `sub` in Pawtograder's ID tokens, so the user's first sign-in through the
 * pawtograder login source lands on this account. The email is never used to link accounts.
 */
export async function ensureAccountForUser(
  config: ForgejoConfig,
  user: { userId: string; email: string; name: string | null }
): Promise<ForgejoUser> {
  const existing = await findAccountForUser(config, user.userId);
  if (existing) return existing;

  const base = usernameFromEmail(user.email);
  for (let attempt = 1; attempt <= 20; attempt++) {
    const username = attempt === 1 ? base : `${base}-${attempt}`;
    const res = await forgejo(config, "POST", "/admin/users", {
      username,
      email: user.email,
      full_name: user.name ?? "",
      login_name: user.userId,
      source_id: config.authSourceId,
      // Never used: the login source authenticates. Forgejo requires one anyway.
      password: crypto.randomUUID() + crypto.randomUUID(),
      must_change_password: false,
      send_notify: false,
      visibility: "private"
    });
    if (res.ok) return (await res.json()) as ForgejoUser;
    const message = await res.text();
    // A taken or reserved name gets the next suffix. "e-mail already in use" doesn't: another name won't help.
    if (res.status === 422 && /user already exists|name is reserved/i.test(message)) continue;
    throw new Error(`Forgejo user create failed: ${res.status} ${reason(message)}`);
  }
  throw new Error("No free Forgejo username after 20 attempts");
}

/**
 * The repository's API path, for a plain owner/name only. The admin can call every endpoint, so a name with
 * "..", "?" or another slash, as an instructor could type into template_repo, must never reach the URL.
 */
export function repoPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || /^\.+$/.test(p))) {
    throw new Error("Not a Forgejo owner/name");
  }
  return parts.map(encodeURIComponent).join("/");
}

/**
 * Creates the private org if it doesn't exist, and otherwise accepts it only when Pawtograder's admin is its
 * sole owner. A name someone else holds, as their own user or an org they own, is refused: every student repo
 * created there would belong to them.
 */
export async function ensureOrg(config: ForgejoConfig, org: string): Promise<void> {
  const path = `/orgs/${encodeURIComponent(org)}`;
  let found = await forgejo(config, "GET", path);
  if (found.status === 404) {
    const res = await forgejo(config, "POST", "/orgs", { username: org, visibility: "private" });
    if (res.ok) return;
    const message = await res.text();
    if (res.status !== 422 || !/user already exists/i.test(message)) {
      throw new Error(`Forgejo org create failed: ${res.status} ${reason(message)}`);
    }
    // Either another pass created the org since the lookup, or the name is a user's: /orgs doesn't find users.
    found = await forgejo(config, "GET", path);
    if (found.status === 404) throw new Error("The Forgejo org name is taken by a user");
  }
  if (!found.ok) throw await failure(found, "org lookup");
  await found.body?.cancel();

  const me = await forgejo(config, "GET", "/user");
  if (!me.ok) throw await failure(me, "admin lookup");
  const { login: admin } = (await me.json()) as { login: string };
  const teams = await forgejo(config, "GET", `${path}/teams?limit=50`);
  if (!teams.ok) throw await failure(teams, "org teams read");
  const owners = new Set<string>();
  for (const team of (await teams.json()) as { id: number; permission: string }[]) {
    if (team.permission !== "owner") continue;
    const members = await forgejo(config, "GET", `/teams/${team.id}/members?limit=50`);
    if (!members.ok) throw await failure(members, "org owners read");
    for (const m of (await members.json()) as { login: string }[]) owners.add(m.login.toLowerCase());
  }
  if (owners.size !== 1 || !owners.has(admin.toLowerCase())) {
    throw new Error("The Forgejo org has an owner other than Pawtograder's admin");
  }
}

/**
 * Generates owner/name from the template, or adopts the repo if it already exists: a pass that died
 * after creating it, or one running at the same time. The template must be marked as a template.
 */
export async function ensureRepoFromTemplate(
  config: ForgejoConfig,
  template: string,
  owner: string,
  name: string
): Promise<void> {
  const res = await forgejo(config, "POST", `/repos/${repoPath(template)}/generate`, {
    owner,
    name,
    private: true,
    git_content: true
  });
  if (res.ok || res.status === 409) return;
  throw await failure(res, "repo generate from template");
}

/** A file's text at `ref` (default branch when omitted), or null when the repo has no such file there. */
export async function readFile(
  config: ForgejoConfig,
  repository: string,
  path: string,
  ref?: string
): Promise<string | null> {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await forgejo(config, "GET", `/repos/${repoPath(repository)}/contents/${file}${query}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, "file read");
  const { content } = (await res.json()) as { content: string };
  return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

/** The same fields of a commit that GitHub's commit API gives. */
export type ForgejoCommit = {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
};

/** The commit `ref` names, which may be a short sha; the result's `sha` is the full one. */
export async function getCommit(config: ForgejoConfig, repository: string, ref: string): Promise<ForgejoCommit> {
  const res = await forgejo(config, "GET", `/repos/${repository}/git/commits/${encodeURIComponent(ref)}`);
  if (!res.ok) throw await failure(res, "commit lookup");
  return (await res.json()) as ForgejoCommit;
}

/**
 * Runs grade.yml at `sha`, as GitHub's triggerWorkflow does: tag the commit pawtograder-submit/<sha>
 * and dispatch the workflow at that tag. The tag may already exist from an earlier run.
 */
export async function startGrading(config: ForgejoConfig, repository: string, sha: string): Promise<void> {
  const tag = `pawtograder-submit/${sha}`;
  const tagged = await forgejo(config, "POST", `/repos/${repository}/tags`, {
    tag_name: tag,
    target: sha,
    message: "pawtograder submission"
  });
  if (!tagged.ok && tagged.status !== 409) throw await failure(tagged, "submission tag");
  const res = await forgejo(config, "POST", `/repos/${repository}/actions/workflows/grade.yml/dispatches`, {
    ref: tag
  });
  if (!res.ok) throw await failure(res, "workflow dispatch");
}

/** Gives login write access, then reports whether Forgejo says they have it. */
export async function grantWrite(config: ForgejoConfig, repository: string, login: string): Promise<boolean> {
  const user = encodeURIComponent(login);
  const put = await forgejo(config, "PUT", `/repos/${repoPath(repository)}/collaborators/${user}`, {
    permission: "write"
  });
  if (!put.ok) throw await failure(put, "collaborator add");
  const res = await forgejo(config, "GET", `/repos/${repoPath(repository)}/collaborators/${user}/permission`);
  if (!res.ok) throw await failure(res, "collaborator permission read");
  const { permission } = (await res.json()) as { permission: string };
  return permission === "write" || permission === "admin";
}
