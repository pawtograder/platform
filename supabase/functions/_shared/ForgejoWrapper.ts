// Forgejo admin API calls for the accounts Pawtograder creates (#1092).
//
// Admin Basic auth, not an admin token: a token can't act on other users' behalf (Forgejo answers
// 401 "auth method not allowed"), which repo provisioning (#1093) needs.

import { redactSecret } from "./SentryScrub.ts";

export type ForgejoConfig = { url: string; authorization: string; authSourceId: number; fetch?: typeof fetch };
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
  return await (config.fetch ?? fetch)(`${config.url}/api/v1${path}`, {
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
  "the repository with the same name already exists",
  "access token name has been used already",
  "user does not exist",
  "repository does not exist"
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

const CODER_TOKEN_PREFIX = "pawtograder-coder-";
/** Younger tokens than this may belong to a concurrent open that hasn't stored its token yet. */
export const REPLACED_TOKEN_GRACE_MS = 10 * 60_000;

function repoTokenPrefix(repositoryId: number): string {
  return `${CODER_TOKEN_PREFIX}${repositoryId}-`;
}

/** Unique per mint, since Forgejo 400s a duplicate name; the mint time orders a repository's tokens. */
export function coderTokenName(repositoryId: number, mintedAt: number): string {
  return `${repoTokenPrefix(repositoryId)}${mintedAt}-${crypto.randomUUID().slice(0, 8)}`;
}

function tokenMintedAt(name: string, repositoryId: number): number | null {
  const prefix = repoTokenPrefix(repositoryId);
  if (!name.startsWith(prefix)) return null;
  const at = Number(name.slice(prefix.length).split("-")[0]);
  return Number.isSafeInteger(at) ? at : null;
}

function ownerAndName(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) throw new Error("Forgejo token mint failed: repository is not owner/name");
  return { owner, name };
}

export type RepoToken = { name: string; token: string };

/**
 * Student-owned so forgejo-repo-webhook sees a submission, not handout sync. Leaves older tokens:
 * two opens at once must not revoke each other's before it is stored (revokeReplacedTokens, after).
 */
export async function mintRepoToken(
  config: ForgejoConfig,
  login: string,
  repository: string,
  repositoryId: number,
  now: number = Date.now()
): Promise<RepoToken> {
  const { owner, name } = ownerAndName(repository);
  const tokenName = coderTokenName(repositoryId, now);
  const res = await forgejo(config, "POST", `/users/${encodeURIComponent(login)}/tokens`, {
    name: tokenName,
    scopes: ["write:repository"],
    repositories: [{ owner, name }]
  });
  if (!res.ok) throw await failure(res, "token mint");
  // Not res.json(): its SyntaxError quotes the body, which holds the token.
  let sha1: unknown;
  try {
    sha1 = (JSON.parse(await res.text()) as { sha1?: unknown })?.sha1;
  } catch {
    sha1 = undefined;
  }
  if (typeof sha1 !== "string" || !sha1) throw new Error("Forgejo token mint failed: the response has no token");
  redactSecret(sha1);
  return { name: tokenName, token: sha1 };
}

/** Deletes the repository's tokens minted REPLACED_TOKEN_GRACE_MS or more before `now`, except `keep`. */
export async function revokeReplacedTokens(
  config: ForgejoConfig,
  login: string,
  repositoryId: number,
  keep: string,
  now: number = Date.now()
): Promise<number> {
  const stale = (await listCoderTokenNames(config, login)).filter((n) => {
    const at = tokenMintedAt(n, repositoryId);
    return n !== keep && at !== null && at <= now - REPLACED_TOKEN_GRACE_MS;
  });
  for (const name of stale) await deleteToken(config, login, name);
  return stale.length;
}

/** Deletes every token minted for the repository. A user that is already gone has none. */
export async function revokeRepoToken(config: ForgejoConfig, login: string, repositoryId: number): Promise<number> {
  const names = (await listCoderTokenNames(config, login)).filter((n) => n.startsWith(repoTokenPrefix(repositoryId)));
  for (const name of names) await deleteToken(config, login, name);
  return names.length;
}

async function deleteToken(config: ForgejoConfig, login: string, tokenName: string): Promise<void> {
  const path = `/users/${encodeURIComponent(login)}/tokens/${encodeURIComponent(tokenName)}`;
  const res = await forgejo(config, "DELETE", path);
  if (res.ok || res.status === 404) {
    await res.body?.cancel();
    return;
  }
  throw await failure(res, "token revoke");
}

const TOKEN_PAGE_SIZE = 50;

/** Names of the user's workspace tokens; none when the user is gone. Tokens they made are left out. */
async function listCoderTokenNames(config: ForgejoConfig, login: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ page: String(page), limit: String(TOKEN_PAGE_SIZE) });
    const res = await forgejo(config, "GET", `/users/${encodeURIComponent(login)}/tokens?${query}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return [];
    }
    if (!res.ok) throw await failure(res, "token list");
    const tokens = (await res.json()) as { name: string }[];
    names.push(...tokens.map((t) => t.name).filter((n) => n.startsWith(CODER_TOKEN_PREFIX)));
    if (tokens.length < TOKEN_PAGE_SIZE) break;
  }
  return names;
}

export async function revokeAllCoderTokens(config: ForgejoConfig, login: string): Promise<number> {
  const names = await listCoderTokenNames(config, login);
  for (const name of names) await deleteToken(config, login, name);
  return names.length;
}
