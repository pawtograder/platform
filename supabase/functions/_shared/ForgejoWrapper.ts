// Admin Basic auth, not an admin token: a token cannot mint other users' tokens (401 auth method not allowed).
import { UserVisibleError } from "./HandlerUtils.ts";

export type ForgejoUser = { id: number; login: string; login_name: string; source_id: number; email: string };

export function forgejoUrl(): string {
  const url = Deno.env.get("FORGEJO_URL");
  if (!url) {
    throw new UserVisibleError("Forgejo is not configured on this deployment (FORGEJO_URL is unset)");
  }
  return url.replace(/\/+$/, "");
}

function adminAuthHeader(): string {
  const username = Deno.env.get("FORGEJO_ADMIN_USERNAME");
  const password = Deno.env.get("FORGEJO_ADMIN_PASSWORD");
  if (!username || !password) {
    throw new UserVisibleError("Forgejo admin credentials are not configured on this deployment");
  }
  return "Basic " + btoa(`${username}:${password}`);
}

async function forgejo<T>(
  method: string,
  path: string,
  body?: unknown,
  okStatuses: number[] = [200, 201, 204]
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${forgejoUrl()}/api/v1${path}`, {
    method,
    headers: {
      Authorization: adminAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : null;
  if (!okStatuses.includes(res.status)) {
    const message = (data as { message?: string } | null)?.message ?? text;
    throw new Error(`Forgejo ${method} ${path} returned ${res.status}: ${message}`);
  }
  return { status: res.status, data };
}

// Forgejo caps usernames at 40 chars; keep 30 to leave room for a collision suffix.
export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0].toLowerCase();
  const cleaned = local
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 30)
    .replace(/[-_.]+$/g, "");
  return cleaned || "student";
}

export async function getUser(login: string): Promise<ForgejoUser | null> {
  const { status, data } = await forgejo<ForgejoUser>(
    "GET",
    `/users/${encodeURIComponent(login)}`,
    undefined,
    [200, 404]
  );
  return status === 404 ? null : data;
}

export async function createUserForPawtograderUser(params: {
  userId: string;
  email: string;
  fullName: string | null;
}): Promise<ForgejoUser> {
  const base = usernameFromEmail(params.email);
  const sourceId = Number(Deno.env.get("FORGEJO_AUTH_SOURCE_ID") ?? "0");
  for (let attempt = 0; attempt < 20; attempt++) {
    const username = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (await getUser(username)) {
      continue;
    }
    const password = crypto.randomUUID() + crypto.randomUUID();
    const { status, data } = await forgejo<ForgejoUser>(
      "POST",
      "/admin/users",
      {
        username,
        email: params.email,
        full_name: params.fullName ?? "",
        login_name: params.userId,
        source_id: sourceId,
        password,
        must_change_password: false,
        send_notify: false,
        visibility: "private"
      },
      [201, 422]
    );
    if (status === 201 && data) {
      return data;
    }
    // 422 here is a race with another create of the same name; try the next suffix.
  }
  throw new Error(`Could not find a free Forgejo username for ${params.email}`);
}

export async function ensureOrg(org: string, fullName: string): Promise<void> {
  const { status } = await forgejo("GET", `/orgs/${encodeURIComponent(org)}`, undefined, [200, 404]);
  if (status === 404) {
    await forgejo("POST", "/orgs", { username: org, full_name: fullName, visibility: "private" });
  }
}

type Team = { id: number; name: string };

export async function ensureTeam(org: string, name: "students" | "staff", permission: "read" | "write"): Promise<Team> {
  const { data } = await forgejo<{ data: Team[] }>(
    "GET",
    `/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(name)}`
  );
  const existing = data?.data.find((t) => t.name === name);
  if (existing) {
    return existing;
  }
  const created = await forgejo<Team>("POST", `/orgs/${encodeURIComponent(org)}/teams`, {
    name,
    permission,
    includes_all_repositories: name === "staff",
    can_create_org_repo: false,
    units: ["repo.code", "repo.issues", "repo.pulls", "repo.releases", "repo.wiki", "repo.actions"]
  });
  return created.data!;
}

export async function addTeamMember(teamId: number, login: string): Promise<void> {
  await forgejo("PUT", `/teams/${teamId}/members/${encodeURIComponent(login)}`);
}

// 409 means the repo already exists; adopt it rather than replace student work.
export async function generateRepoFromTemplate(template: string, org: string, name: string): Promise<void> {
  const [templateOwner, templateRepo] = template.split("/");
  await forgejo(
    "POST",
    `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(templateRepo)}/generate`,
    { owner: org, name, private: true, git_content: true },
    [201, 409]
  );
}

export async function addCollaborator(repo: string, login: string, permission: "read" | "write"): Promise<void> {
  await forgejo("PUT", `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { permission });
}

export async function getPermission(repo: string, login: string): Promise<string> {
  const { data } = await forgejo<{ permission: string }>(
    "GET",
    `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`
  );
  return data?.permission ?? "none";
}

type AccessToken = { id: number; name: string; sha1: string };

// Forgejo token names are unique per user, so delete-then-create is the rotation.
export async function rotateUserToken(login: string, tokenName: string, scopes: string[]): Promise<string> {
  const user = encodeURIComponent(login);
  const { data: tokens } = await forgejo<AccessToken[]>("GET", `/users/${user}/tokens`);
  for (const token of tokens ?? []) {
    if (token.name === tokenName) {
      await forgejo("DELETE", `/users/${user}/tokens/${token.id}`);
    }
  }
  const { data } = await forgejo<AccessToken>("POST", `/users/${user}/tokens`, { name: tokenName, scopes });
  if (!data?.sha1) {
    throw new Error(`Forgejo did not return a token for ${login}`);
  }
  return data.sha1;
}
