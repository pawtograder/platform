// Coder API calls for workspace-open (#1222). Coder v2.37.3.
//
// CODER_API_TOKEN belongs to a Coder owner. workspace-open creates users and workspaces on students'
// behalf and reads their OIDC link, and only owners may read a link (GET /debug/{user}/debug-link).

export type CoderConfig = { url: string; token: string; fetch?: typeof fetch };

/** Null until the deployment sets both. */
export function coderConfig(env: { get(name: string): string | undefined } = Deno.env): CoderConfig | null {
  const url = env.get("CODER_URL")?.replace(/\/+$/, "");
  const token = env.get("CODER_API_TOKEN");
  if (!url || !token) return null;
  return { url, token };
}

export class CoderApiError extends Error {
  status: number;
  body: CoderResponse | null;
  constructor(what: string, status: number, body: CoderResponse | null, text: string) {
    super(`Coder ${what} failed: ${status} ${text.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** Coder's error body. */
export type CoderResponse = {
  message?: string;
  detail?: string;
  validations?: { field: string; detail: string }[];
};

export type CoderUser = {
  id: string;
  username: string;
  email: string;
  login_type: string;
  status: string;
};

export type CoderTemplate = { id: string; active_version_id: string; default_ttl_ms: number };

export type CoderScript = {
  display_name: string;
  log_source_id: string;
  status?: string;
  exit_code?: number;
};

export type CoderApp = {
  slug: string;
  url?: string;
  subdomain: boolean;
  subdomain_name?: string;
  health: string;
};

export type CoderAgent = {
  id: string;
  name: string;
  status: string;
  lifecycle_state: string;
  scripts?: CoderScript[];
  apps?: CoderApp[];
};

export type CoderWorkspace = {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  latest_build: {
    status: string;
    transition: string;
    template_version_id: string;
    job: { error?: string };
    resources: { agents?: CoderAgent[] }[];
  };
};

export type CoderExternalAuth = {
  id: string;
  display_name: string;
  authenticate_url: string;
  authenticated: boolean;
  // Coder omits the key when it's false (`json:"optional,omitempty"`).
  optional?: boolean;
};

export type CoderAgentLog = { id: number; output: string; source_id: string; level: string };

async function coder<T>(
  config: CoderConfig,
  what: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: T | null; error: CoderApiError | null }> {
  const res = await (config.fetch ?? fetch)(`${config.url}/api/v2${path}`, {
    method,
    headers: { "Coder-Session-Token": config.token, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.ok) return { status: res.status, data: parsed as T, error: null };
  return {
    status: res.status,
    data: null,
    error: new CoderApiError(what, res.status, parsed as CoderResponse | null, text)
  };
}

async function get<T>(config: CoderConfig, what: string, path: string): Promise<T> {
  const { data, error } = await coder<T>(config, what, "GET", path);
  if (error) throw error;
  return data as T;
}

/** A user by id or username, or null if there is none. */
export async function getUser(config: CoderConfig, idOrUsername: string): Promise<CoderUser | null> {
  const { status, data, error } = await coder<CoderUser>(
    config,
    "user lookup",
    "GET",
    `/users/${encodeURIComponent(idOrUsername)}`
  );
  if (status === 404) return null;
  if (error) throw error;
  return data;
}

export async function findUserByEmail(config: CoderConfig, email: string): Promise<CoderUser | null> {
  const q = new URLSearchParams({ q: `email:${email}` });
  const { users } = await get<{ users: CoderUser[] }>(config, "user search", `/users?${q}`);
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

/**
 * Creates an OIDC user with no password. The 409 for a taken username or email comes back as the
 * error, for the caller to decide what it means.
 */
export async function createOidcUser(
  config: CoderConfig,
  user: { username: string; email: string; name: string; organizationId: string }
): Promise<{ user: CoderUser | null; error: CoderApiError | null }> {
  const { data, error } = await coder<CoderUser>(config, "user create", "POST", "/users", {
    username: user.username,
    email: user.email,
    name: user.name,
    login_type: "oidc",
    organization_ids: [user.organizationId],
    user_status: "active"
  });
  return { user: data, error };
}

/**
 * The `sub` of the OIDC identity this user is bound to, or null before their first sign-in. Coder
 * sets the link on the first OIDC login that lands on the user and refuses any other subject after
 * that. The debug route is owner-only and Coder doesn't promise its shape between releases.
 */
export async function getBoundOidcSubject(config: CoderConfig, userId: string): Promise<string | null> {
  const { status, data, error } = await coder<{ id_token_claims?: { sub?: unknown } }>(
    config,
    "OIDC link lookup",
    "GET",
    `/debug/${encodeURIComponent(userId)}/debug-link`
  );
  // No link yet: Coder answers 500 "Failed to get user links." with sql.ErrNoRows as the detail.
  if (status === 500 && /no rows/.test(error?.body?.detail ?? "")) return null;
  if (error) throw error;
  const sub = data?.id_token_claims?.sub;
  if (typeof sub !== "string" || sub === "") {
    throw new Error("Coder OIDC link has no sub claim");
  }
  return sub;
}

export async function getOrganizationId(config: CoderConfig, name: string): Promise<string> {
  return (await get<{ id: string }>(config, "organization lookup", `/organizations/${encodeURIComponent(name)}`)).id;
}

export async function getTemplate(config: CoderConfig, organization: string, name: string): Promise<CoderTemplate> {
  return await get<CoderTemplate>(
    config,
    "template lookup",
    `/organizations/${encodeURIComponent(organization)}/templates/${encodeURIComponent(name)}`
  );
}

/** The template version's external auth providers, as the given user sees them. */
export async function getExternalAuth(
  config: CoderConfig,
  templateVersionId: string,
  userId: string
): Promise<CoderExternalAuth[]> {
  const q = new URLSearchParams({ user_id: userId });
  return await get<CoderExternalAuth[]>(
    config,
    "external auth lookup",
    `/templateversions/${encodeURIComponent(templateVersionId)}/external-auth?${q}`
  );
}

export async function getWorkspace(config: CoderConfig, id: string): Promise<CoderWorkspace | null> {
  const { status, data, error } = await coder<CoderWorkspace>(
    config,
    "workspace lookup",
    "GET",
    `/workspaces/${encodeURIComponent(id)}`
  );
  // 410: the workspace was deleted.
  if (status === 404 || status === 410) return null;
  if (error) throw error;
  return data;
}

export async function getWorkspaceByName(
  config: CoderConfig,
  owner: string,
  name: string
): Promise<CoderWorkspace | null> {
  const { status, data, error } = await coder<CoderWorkspace>(
    config,
    "workspace lookup",
    "GET",
    `/users/${encodeURIComponent(owner)}/workspace/${encodeURIComponent(name)}`
  );
  if (status === 404 || status === 410) return null;
  if (error) throw error;
  return data;
}

/** 409 (the name is taken) and 403 (external auth missing) come back as the error. */
export async function createWorkspace(
  config: CoderConfig,
  owner: string,
  request: {
    template_id: string;
    name: string;
    ttl_ms: number;
    rich_parameter_values: { name: string; value: string }[];
  }
): Promise<{ workspace: CoderWorkspace | null; error: CoderApiError | null }> {
  const { data, error } = await coder<CoderWorkspace>(
    config,
    "workspace create",
    "POST",
    `/users/${encodeURIComponent(owner)}/workspaces`,
    request
  );
  return { workspace: data, error };
}

/** 409 means another build is already running, which the caller can treat as started. */
export async function startWorkspace(config: CoderConfig, workspaceId: string): Promise<CoderApiError | null> {
  const { error } = await coder(
    config,
    "workspace start",
    "POST",
    `/workspaces/${encodeURIComponent(workspaceId)}/builds`,
    {
      transition: "start"
    }
  );
  return error;
}

export async function getAgentLogs(config: CoderConfig, agentId: string): Promise<CoderAgentLog[]> {
  return await get<CoderAgentLog[]>(config, "agent logs", `/workspaceagents/${encodeURIComponent(agentId)}/logs`);
}

/** The wildcard host for subdomain apps, such as `*.coder.example.com`, or "" when none is set. */
export async function getAppHost(config: CoderConfig): Promise<string> {
  return (await get<{ host: string }>(config, "app host lookup", "/applications/host")).host;
}
