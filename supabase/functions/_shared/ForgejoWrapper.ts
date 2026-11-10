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

// These errors go to Sentry, and Forgejo names the offending value in brackets
// ("e-mail already in use [email: a@b.edu]"), so only the message without them is kept.
function reason(text: string): string {
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // Not JSON: use the text as it came.
  }
  return message.replace(/\s*\[[^\]]*\]/g, "").slice(0, 200);
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
  throw new Error(`No free Forgejo username for ${base}`);
}

/** Creates the private org if it doesn't exist. Repo creation (#1093) owns these orgs. */
export async function ensureOrg(config: ForgejoConfig, org: string): Promise<void> {
  const found = await forgejo(config, "GET", `/orgs/${encodeURIComponent(org)}`);
  if (found.ok) return;
  if (found.status !== 404) throw await failure(found, "org lookup");
  const res = await forgejo(config, "POST", "/orgs", { username: org, visibility: "private" });
  if (res.ok) return;
  const message = await res.text();
  // Another pass created it between the lookup and the create.
  if (res.status === 422 && /user already exists/i.test(message)) return;
  throw new Error(`Forgejo org create failed: ${res.status} ${message.slice(0, 300)}`);
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
  const res = await forgejo(config, "POST", `/repos/${template}/generate`, {
    owner,
    name,
    private: true,
    git_content: true
  });
  if (res.ok || res.status === 409) return;
  throw await failure(res, `generate ${owner}/${name} from ${template}`);
}

/** Gives login write access, then reports whether Forgejo says they have it. */
export async function grantWrite(config: ForgejoConfig, repository: string, login: string): Promise<boolean> {
  const user = encodeURIComponent(login);
  const put = await forgejo(config, "PUT", `/repos/${repository}/collaborators/${user}`, { permission: "write" });
  if (!put.ok) throw await failure(put, `add ${login} to ${repository}`);
  const res = await forgejo(config, "GET", `/repos/${repository}/collaborators/${user}/permission`);
  if (!res.ok) throw await failure(res, `permission read for ${login} on ${repository}`);
  const { permission } = (await res.json()) as { permission: string };
  return permission === "write" || permission === "admin";
}
