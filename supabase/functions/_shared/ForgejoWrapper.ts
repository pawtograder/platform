// Forgejo admin API calls for the accounts (#1092) and repos (#1093) Pawtograder creates, and for grading (#1110).
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

/** Forgejo 400s a duplicate token name. */
export function coderTokenName(repositoryId: number, mintedAt: number): string {
  return `${repoTokenPrefix(repositoryId)}${mintedAt}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Forgejo tokens don't expire. A repository whose newest token is this old hasn't been opened in that time, so its
 * tokens are revoked: by the next open of another repository (revokeIdleTokens), or by the reconciler for a student
 * who doesn't open one again. Must match the interval in forgejo_repo_tokens_to_revoke.
 */
export const IDLE_TOKEN_MS = 14 * 24 * 60 * 60_000;

const CODER_TOKEN_NAME = /^pawtograder-coder-(\d+)-(\d+)-/;

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

/**
 * Deletes this repository's tokens minted at or before `mintedBefore`. A token minted later came from a re-mint
 * after the caller's revocation claim (the student was re-enabled), so it isn't the one being revoked. Names
 * without a readable mint time are deleted: they can't be shown to be newer.
 */
export async function revokeRepoToken(
  config: ForgejoConfig,
  login: string,
  repositoryId: number,
  mintedBefore: number = Date.now()
): Promise<number> {
  const names = (await listCoderTokenNames(config, login)).filter((n) => {
    if (!n.startsWith(repoTokenPrefix(repositoryId))) return false;
    const at = tokenMintedAt(n, repositoryId);
    return at === null || at <= mintedBefore;
  });
  for (const name of names) await deleteToken(config, login, name);
  return names.length;
}

/**
 * Revokes the tokens of every repository other than `keep` whose newest token was minted IDLE_TOKEN_MS or more
 * before `now`. Returns the ids of the repositories that still have a token. A name without a readable repository
 * and mint time is left alone.
 */
export async function revokeIdleTokens(
  config: ForgejoConfig,
  login: string,
  keep: number,
  now: number = Date.now()
): Promise<Set<number>> {
  const byRepository = new Map<number, { name: string; at: number }[]>();
  for (const name of await listCoderTokenNames(config, login)) {
    const m = name.match(CODER_TOKEN_NAME);
    if (!m || !Number.isSafeInteger(Number(m[1])) || !Number.isSafeInteger(Number(m[2]))) continue;
    const id = Number(m[1]);
    const list = byRepository.get(id) ?? [];
    list.push({ name, at: Number(m[2]) });
    byRepository.set(id, list);
  }
  const live = new Set<number>();
  for (const [id, tokens] of byRepository) {
    if (id === keep || Math.max(...tokens.map((t) => t.at)) > now - IDLE_TOKEN_MS) {
      live.add(id);
      continue;
    }
    for (const t of tokens) await deleteToken(config, login, t.name);
  }
  return live;
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

/** One page size per attempt: a retry moves the page boundaries, so a tie that split one page from the next doesn't. */
const TOKEN_PAGE_SIZES = [50, 49, 47];

/**
 * The list is paged by offset, so a token deleted between two page reads (by another open or a reconciler pass)
 * moves the unread ones forward and the next page can miss one. Forgejo lists tokens newest first
 * (ListAccessTokensOptions.ToOrders), so a mint only pushes the unread ones back, and only a deletion can pull
 * one forward. The order is by created_unix alone, in seconds, so two tokens with the same one can come back in
 * either order, and each page query picks its own. A scan that may have missed one is read again, and a list
 * that can't be read whole is an error: callers keep their claim or leave the work to the next open.
 */
async function listCoderTokenNames(config: ForgejoConfig, login: string): Promise<string[]> {
  for (const pageSize of TOKEN_PAGE_SIZES) {
    const names = await scanCoderTokenNames(config, login, pageSize);
    if (names) return names;
  }
  throw new Error("Forgejo token list failed: it kept changing while it was read");
}

type TokenPage = { count: string | null; names: string[] } | "missing";

async function readTokenPage(config: ForgejoConfig, login: string, page: number, limit: number): Promise<TokenPage> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  const res = await forgejo(config, "GET", `/users/${encodeURIComponent(login)}/tokens?${query}`);
  if (res.status === 404) {
    await res.body?.cancel();
    return "missing";
  }
  if (!res.ok) throw await failure(res, "token list");
  const tokens = (await res.json()) as { name: string }[];
  return { count: res.headers.get("X-Total-Count"), names: tokens.map((t) => t.name) };
}

const sameNames = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Null when the list may not have been read whole. A list that fits on one page is one query, so it is whole.
 * A longer one is checked three ways:
 * - Each later page's X-Total-Count must match page 1's. That count was read after page 1's rows, so it catches
 *   a deletion from then on.
 * - Page 1 is read again at the end and must hold the same names. A mint lands on page 1, newest first, and so
 *   does any deletion before page 1's count that could move a token past the end of page 1. With no mint, the
 *   counts see every other deletion, so the list held the same `count` tokens throughout.
 * - So the scan must have seen `count` different names. Fewer means two pages ordered tied tokens differently,
 *   repeating one and leaving out another.
 */
async function scanCoderTokenNames(config: ForgejoConfig, login: string, pageSize: number): Promise<string[] | null> {
  const first = await readTokenPage(config, login, 1, pageSize);
  if (first === "missing") return [];
  const names = new Set<string>(first.names);
  if (first.names.length >= pageSize) {
    for (let page = 2; ; page++) {
      const next = await readTokenPage(config, login, page, pageSize);
      if (next === "missing" || next.count !== first.count) return null;
      for (const name of next.names) names.add(name);
      if (next.names.length < pageSize) break;
    }
    const again = await readTokenPage(config, login, 1, pageSize);
    if (again === "missing" || again.count !== first.count || !sameNames(again.names, first.names)) return null;
    if (first.count !== null && names.size !== Number(first.count)) return null;
  }
  return [...names].filter((name) => name.startsWith(CODER_TOKEN_PREFIX));
}

export async function revokeAllCoderTokens(config: ForgejoConfig, login: string): Promise<number> {
  const names = await listCoderTokenNames(config, login);
  for (const name of names) await deleteToken(config, login, name);
  return names.length;
}

/** A submission archive larger than the caller's limit. `bytesRead` is how far the download got. */
export class ArchiveTooLargeError extends Error {
  constructor(readonly bytesRead: number) {
    super(`Forgejo archive is over the size limit (read ${bytesRead} bytes)`);
  }
}

/**
 * The repo at `sha` as a zip with one top-level directory, the same shape as GitHub's zipball, for
 * grading (#1110). Forgejo 15.0.9 held a request for an unknown commit open for minutes, hence the
 * timeout. Throws ArchiveTooLargeError, without assembling what it read, once the archive passes maxBytes.
 */
export async function downloadArchive(
  config: ForgejoConfig,
  repository: string,
  sha: string,
  maxBytes: number,
  timeoutMs = 60_000
): Promise<Uint8Array> {
  const res = await fetch(`${config.url}/api/v1/repos/${repoPath(repository)}/archive/${encodeURIComponent(sha)}.zip`, {
    headers: { Authorization: config.authorization },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw await failure(res, "archive download");
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ArchiveTooLargeError(total);
    }
    chunks.push(value);
  }
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
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

/**
 * Sets up a handout as a private template repo on main, and returns main's head sha. A file with
 * `content` is added, and one with null content is removed. A retry, or a handout staff made by hand, is
 * adopted: an existing repo is made private and a template, and a file already there is kept, since
 * staff may have edited it. An adopted repo with no commits gets a README, and one whose default branch
 * isn't main is refused.
 */
export async function ensureHandoutRepo(
  config: ForgejoConfig,
  repository: string,
  files: { path: string; content: string | null }[]
): Promise<string> {
  const path = repoPath(repository);
  const [org, name] = repository.split("/");
  await ensureOrg(config, org);
  const writes = [...files];
  const created = await forgejo(config, "POST", `/orgs/${encodeURIComponent(org)}/repos`, {
    name,
    private: true,
    auto_init: true,
    default_branch: "main",
    template: true
  });
  if (created.status === 409) {
    await created.body?.cancel();
    // Student repos are generated from the handout, which Forgejo allows only from a template.
    const marked = await forgejo(config, "PATCH", `/repos/${path}`, { template: true, private: true });
    if (!marked.ok) throw await failure(marked, "repo template update");
    const adopted = (await marked.json()) as { empty: boolean; default_branch: string };
    // An empty repo has no main until its first file, which Forgejo then commits to main.
    if (adopted.empty) writes.unshift({ path: "README.md", content: `# ${name}\n` });
    else if (adopted.default_branch !== "main")
      throw new Error("The existing handout repo's default branch isn't main");
  } else if (!created.ok) {
    throw await failure(created, "repo create");
  } else {
    await created.body?.cancel();
  }
  for (const file of writes) {
    const contents = `/repos/${path}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    if (file.content === null) {
      const found = await forgejo(config, "GET", `${contents}?ref=main`);
      if (found.status === 404) {
        await found.body?.cancel();
        continue;
      }
      if (!found.ok) throw await failure(found, "file read");
      const { sha } = (await found.json()) as { sha: string };
      const deleted = await forgejo(config, "DELETE", contents, {
        sha,
        message: `Remove ${file.path}`,
        branch: "main"
      });
      if (!deleted.ok) throw await failure(deleted, "file delete");
      await deleted.body?.cancel();
      continue;
    }
    const bytes = new TextEncoder().encode(file.content);
    const res = await forgejo(config, "POST", contents, {
      content: btoa(String.fromCharCode(...bytes)),
      message: `Add ${file.path}`,
      branch: "main"
    });
    if (res.ok) {
      await res.body?.cancel();
      continue;
    }
    const message = await res.text();
    if (res.status !== 422 || !/file already exists/i.test(message)) {
      throw new Error(`Forgejo file create failed: ${res.status} ${reason(message)}`);
    }
  }
  return (await getCommit(config, repository, "main")).sha;
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
  const res = await forgejo(config, "GET", `/repos/${repoPath(repository)}/git/commits/${encodeURIComponent(ref)}`);
  if (!res.ok) throw await failure(res, "commit lookup");
  return (await res.json()) as ForgejoCommit;
}

/**
 * Runs grade.yml at `sha`, as GitHub's triggerWorkflow does: tag the commit pawtograder-submit/<sha>
 * and dispatch the workflow at that tag.
 */
export async function startGrading(config: ForgejoConfig, repository: string, sha: string): Promise<void> {
  const tag = `pawtograder-submit/${sha}`;
  await tagCommit(config, repository, tag, sha);
  const res = await forgejo(config, "POST", `/repos/${repoPath(repository)}/actions/workflows/grade.yml/dispatches`, {
    ref: tag
  });
  if (!res.ok) throw await failure(res, "workflow dispatch");
}

/**
 * Points `tag` at `sha`. An existing tag at `sha` is reused. One at another commit is replaced, since a
 * student with write access can push the tag first, and a dispatch at it would then build their commit.
 * Forgejo's tag routes take the name unencoded, slash included (checked on 15.0.9).
 */
async function tagCommit(config: ForgejoConfig, repository: string, tag: string, sha: string): Promise<void> {
  const tags = `/repos/${repoPath(repository)}/tags`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = await forgejo(config, "POST", tags, {
      tag_name: tag,
      target: sha,
      message: "pawtograder submission"
    });
    if (created.ok) return;
    if (created.status !== 409) throw await failure(created, "submission tag");
    const existing = await forgejo(config, "GET", `${tags}/${tag}`);
    if (!existing.ok) throw await failure(existing, "submission tag lookup");
    const { commit } = (await existing.json()) as { commit?: { sha?: string } };
    if (commit?.sha?.toLowerCase() === sha.toLowerCase()) return;
    const deleted = await forgejo(config, "DELETE", `${tags}/${tag}`);
    if (!deleted.ok && deleted.status !== 404) throw await failure(deleted, "submission tag delete");
  }
  throw new Error("The submission tag points at another commit, and was pushed again after Pawtograder replaced it");
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
