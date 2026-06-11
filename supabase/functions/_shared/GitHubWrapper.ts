import { decode, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { bottleneckRedisOptions } from "./Redis.ts";
import { createAppAuth } from "npm:@octokit/auth-app";
import { throttling } from "npm:@octokit/plugin-throttling";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import { App, Endpoints, Octokit, RequestError } from "npm:octokit";
import * as Sentry from "npm:@sentry/deno";
import { SecurityError } from "./HandlerUtils.ts";

// Structured error used to signal Octokit secondary rate limit back to callers
export class SecondaryRateLimitError extends Error {
  retryAfter?: number;
  scopeKey?: string;
  constructor(retryAfter?: number, scopeKey?: string) {
    super("SecondaryRateLimit");
    this.name = "SecondaryRateLimitError";
    this.retryAfter = retryAfter;
    this.scopeKey = scopeKey;
  }
}

export class PrimaryRateLimitError extends Error {
  retryAfter?: number;
  scopeKey?: string;
  constructor(retryAfter?: number, scopeKey?: string) {
    super("PrimaryRateLimit");
    this.name = "PrimaryRateLimitError";
    this.retryAfter = retryAfter;
    this.scopeKey = scopeKey;
  }
}

import { Buffer } from "node:buffer";
import { Database } from "./SupabaseTypes.d.ts";

import { createHash } from "node:crypto";
import { FileListing } from "./FunctionTypes.d.ts";
import { UserVisibleError } from "./HandlerUtils.ts";

const adminsThatShouldNotBeListedAsAdmins = ["smaran-teja", "jonathantarun", "ricksva", "jondenman", "tsrats"];
/**
 * Retry utility with exponential backoff for GitHub API calls
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  scope?: Sentry.Scope
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();

      // Log successful retry if this wasn't the first attempt
      if (attempt > 0) {
        scope?.setContext("retry_success", {
          attempt,
          total_attempts: attempt + 1,
          operation: "github_api_retry"
        });
        Sentry.addBreadcrumb({
          message: `GitHub API retry succeeded on attempt ${attempt + 1}`,
          level: "info",
          data: { attempt, total_attempts: attempt + 1 }
        });
      }

      return result;
    } catch (error: unknown) {
      lastError = error as Error;

      // Check if this is an error we should retry (404 or "Git Repository is empty")
      const is404 = error instanceof RequestError && error.status === 404;
      const isGitRepoEmpty = error instanceof Error && error.message?.toLowerCase().includes("git repository is empty");
      const shouldRetry = is404 || isGitRepoEmpty;

      if (!shouldRetry || attempt === maxRetries) {
        // Don't retry for non-retryable errors or if we've exhausted retries
        if (attempt > 0) {
          scope?.setContext("retry_failed", {
            final_attempt: attempt + 1,
            total_attempts: attempt + 1,
            error_status: error instanceof RequestError ? error.status : "unknown",
            error_message: error instanceof Error ? error.message : String(error),
            operation: "github_api_retry"
          });
          Sentry.captureException(error, {
            tags: {
              operation: "github_api_retry_failed",
              attempts: attempt + 1,
              error_type: is404 ? "404_not_found" : isGitRepoEmpty ? "git_repo_empty" : "other"
            }
          });
        }
        throw error;
      }

      // Calculate delay with exponential backoff
      const delayMs = baseDelayMs * Math.pow(2, attempt);

      scope?.setContext("retry_attempt", {
        attempt: attempt + 1,
        next_delay_ms: delayMs,
        error_status: error instanceof RequestError ? error.status : "unknown",
        error_reason: is404 ? "404" : "git_repo_empty",
        operation: "github_api_retry"
      });

      Sentry.addBreadcrumb({
        message: `GitHub API ${is404 ? "404" : "Git Repository is empty"} error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
        level: "warning",
        data: {
          attempt: attempt + 1,
          delay_ms: delayMs,
          error_status: error instanceof RequestError ? error.status : "unknown",
          error_reason: is404 ? "404" : "git_repo_empty",
          error_message: error instanceof Error ? error.message : String(error)
        }
      });

      console.log(
        `GitHub API ${is404 ? "404" : "Git Repository is empty"} error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1}):`,
        error instanceof Error ? error.message : String(error)
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError!;
}

const createContentLimiters = new Map<string, Bottleneck>();

function buildRedisBottleneck(
  id: string,
  opts: { reservoir: number; maxConcurrent: number; reservoirRefreshAmount: number; reservoirRefreshInterval: number },
  clearDatastore: boolean
): Bottleneck {
  // bottleneckRedisOptions picks ioredis (REDIS_URL) or the Upstash
  // adapter (UPSTASH_REDIS_REST_*) automatically. Callers of this
  // helper currently assume at least one is configured — the
  // getCreateContentLimiter path is only invoked when Redis-backed
  // limiting is desired, so falling through to "no Redis" would defeat
  // the purpose. Throw to surface mis-configuration loudly.
  const redisOpts = bottleneckRedisOptions();
  if (!redisOpts) {
    throw new Error("buildRedisBottleneck called without REDIS_URL or UPSTASH_REDIS_REST_URL+TOKEN");
  }
  return new Bottleneck({
    id,
    ...opts,
    timeout: 600000,
    clearDatastore,
    ...redisOpts
  });
}

function withSettingsKeyRecovery(
  limiter: Bottleneck,
  id: string,
  opts: { reservoir: number; maxConcurrent: number; reservoirRefreshAmount: number; reservoirRefreshInterval: number },
  cache: Map<string, Bottleneck>,
  cacheKey: string
): void {
  limiter.on("error", (err: Error) => {
    if (!String(err).includes("SETTINGS_KEY_NOT_FOUND")) {
      console.error(`[rate-limiter] ${id}:`, err);
      return;
    }
    if (cache.get(cacheKey) !== limiter) {
      return;
    }
    console.warn(`[rate-limiter] Settings keys missing for ${id}, reinitializing`);
    const rotateMessage = `[${id}] SETTINGS_KEY_ROTATED after SETTINGS_KEY_NOT_FOUND; retry via getCreateContentLimiter`;
    const fresh = buildRedisBottleneck(id, opts, true);
    withSettingsKeyRecovery(fresh, id, opts, cache, cacheKey);
    cache.set(cacheKey, fresh);
    void limiter
      .stop({
        dropWaitingJobs: true,
        dropErrorMessage: rotateMessage,
        enqueueErrorMessage: rotateMessage
      })
      .then(() => {
        limiter.disconnect();
      })
      .catch((e: unknown) => {
        console.error(`[rate-limiter] stop/disconnect after SETTINGS_KEY rotation failed for ${id}:`, e);
        try {
          limiter.disconnect();
        } catch {
          /* ignore */
        }
      });
  });
}

/**
 * GitHub limits the number of content-creating requests per organization per-minute and per-hour
 * This includes repository creation and organization invitations (same rate limit bucket)
 * @param org GitHub organization
 * @returns Bottleneck limiter instance
 */
export function getCreateContentLimiter(org: string): Bottleneck {
  const key = org || "unknown";
  const existing = createContentLimiters.get(key);
  if (existing) return existing;
  const id = `create_content:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`;
  const opts = { reservoir: 40, maxConcurrent: 40, reservoirRefreshAmount: 40, reservoirRefreshInterval: 60_000 };
  let limiter: Bottleneck;
  // Use the shared Redis store whenever ANY backend is configured — REDIS_URL
  // first, then Upstash — which is exactly what bottleneckRedisOptions() (and
  // buildRedisBottleneck below) already encode. Gating on UPSTASH_* SPECIFICALLY
  // made this fall back to a LOCAL per-isolate limiter on REDIS_URL-only
  // deployments, so each of the N edge replicas independently granted the full
  // 40/min content quota → real GitHub secondary-rate-limit risk under load.
  if (bottleneckRedisOptions()) {
    limiter = buildRedisBottleneck(id, opts, false);
    withSettingsKeyRecovery(limiter, id, opts, createContentLimiters, key);
  } else {
    console.log("No Redis backend (REDIS_URL or UPSTASH_*) found, using local create-content limiter");
    Sentry.captureMessage("No Redis backend (REDIS_URL or UPSTASH_*) found, using local create-content limiter");
    limiter = new Bottleneck({ id, ...opts });
  }
  createContentLimiters.set(key, limiter);
  return limiter;
}

export type ListCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"];
export type GetCommitResponse = Endpoints["GET /repos/{owner}/{repo}/commits/{ref}"]["response"];
export type GitHubOIDCToken = {
  jti: string;
  sub: string;
  aud: string;
  ref: string;
  sha: string;
  repository: string;
  repository_owner: string;
  repository_owner_id: string;
  run_id: string;
  run_number: string;
  run_attempt: string;
  repository_visibility: string;
  repository_id: string;
  actor_id: string;
  actor: string;
  workflow: string;
  head_ref: string;
  base_ref: string;
  event_name: string;
  ref_protected: string;
  ref_type: string;
  workflow_ref: string;
  workflow_sha: string;
  job_workflow_ref: string;
  job_workflow_sha: string;
  runner_environment: string;
  enterprise_id: string;
  enterprise: string;
  iss: string;
  nbf: number;
  exp: number;
  iat: number;
};

const app = new App({
  authStrategy: createAppAuth,
  appId: Deno.env.get("GITHUB_APP_ID") || -1,
  privateKey: Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "",
  oauth: {
    clientId: Deno.env.get("GITHUB_OAUTH_CLIENT_ID") || "",
    clientSecret: Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET") || ""
  },
  webhooks: {
    secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret"
  }
});
const installations: {
  orgName: string;
  id: number;
  octokit: Octokit;
}[] = [];
const MyOctokit = Octokit.plugin(throttling);

export async function getOctoKitAndInstallationID(repoOrOrgName: string, scope?: Sentry.Scope) {
  const org = repoOrOrgName.includes("/") ? repoOrOrgName.split("/")[0] : repoOrOrgName;
  const octokit = await getOctoKit(repoOrOrgName, scope);
  const installationId = installations.find((i) => i.orgName === org)?.id;
  return { octokit, installationId };
}
export async function getOctoKit(repoOrOrgName: string, scope?: Sentry.Scope) {
  const org = repoOrOrgName.includes("/") ? repoOrOrgName.split("/")[0] : repoOrOrgName;
  scope?.addBreadcrumb({
    message: `Getting Octokit for ${org}`,
    category: "github",
    level: "info"
  });
  if (installations.length === 0) {
    let connection: Bottleneck.IORedisConnection | undefined;
    // Back the GitHub API throttle with the shared Redis whenever ANY backend is
    // configured (REDIS_URL first, then Upstash), via the same env-based factory
    // the rest of the app uses. Previously this only built a connection when
    // UPSTASH_* was set; on a REDIS_URL-only deployment `connection` stayed
    // undefined, so @octokit/plugin-throttling fell back to a LOCAL per-isolate
    // limiter — the GitHub rate limit was NOT coordinated across the (12-20)
    // edge replicas, and no `b_pawtograder-production_*` state landed in the
    // shared Redis for the metrics function to read. (The old UPSTASH_* branch
    // also referenced an unimported `Redis` identifier, so it would have thrown
    // a ReferenceError if ever taken.)
    const throttleRedisOpts = bottleneckRedisOptions();
    if (throttleRedisOpts) {
      connection = new Bottleneck.IORedisConnection({
        clientOptions: throttleRedisOpts.clientOptions,
        Redis: throttleRedisOpts.Redis
      });
      try {
        // Log connection lifecycle for verification
        connection.ready
          .then(() => {
            console.log("IORedisConnection ready for GitHub throttling");
          })
          .catch((e: unknown) => {
            console.error("IORedisConnection failed to initialize", e);
          });
        connection.on("error", (err: Error) => console.error(err));
      } catch (e) {
        console.error("Failed to attach IORedisConnection logging", e);
      }
    }
    const _installations = await app.octokit.request("GET /app/installations");
    _installations.data.forEach((i) => {
      const orgLogin = i.account?.login || "";
      installations.push({
        orgName: orgLogin,
        id: i.id,
        octokit: new MyOctokit({
          authStrategy: createAppAuth,
          auth: {
            appId: Deno.env.get("GITHUB_APP_ID") || -1,
            privateKey: Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "",
            installationId: i.id
          },
          throttle: {
            connection,
            id: "pawtograder-production",
            Bottleneck,
            onRateLimit: (retryAfter: number) => {
              Sentry.captureMessage("PrimaryRateLimit detected for request, not retrying (worker will backoff)", scope);
              // Do not retry here; let the request fail with RequestError so worker can handle
              return false;
            },
            onSecondaryRateLimit: (retryAfter: number) => {
              Sentry.captureMessage("SecondaryRateLimit detected for request, not retrying", scope);
              // Do not retry here; let the request fail with RequestError so worker can detect & requeue
              return false;
            }
          }
        })
      });
    });
  }
  const ret = installations.find((i) => i.orgName === org)?.octokit;
  if (ret) {
    return ret;
  }
  return undefined;
}
/**
 * List the GitHub orgs the App is currently installed on, plus the URL an admin
 * can use to install it on a new org. Authenticated as the App itself (not an
 * installation). Used by the create-class admin form to offer a dropdown of
 * valid orgs instead of a free-text box.
 */
export async function listAppInstallations(scope?: Sentry.Scope): Promise<{
  orgs: { login: string; installationId: number }[];
  installUrl: string;
}> {
  scope?.setTag("github_operation", "list_app_installations");
  const installationsResp = await app.octokit.request("GET /app/installations", { per_page: 100 });
  const orgs = installationsResp.data
    .map((i) => ({ login: i.account?.login ?? "", installationId: i.id }))
    .filter((o) => o.login !== "")
    .sort((a, b) => a.login.localeCompare(b.login));

  let installUrl = "https://github.com/settings/installations";
  try {
    const appResp = await app.octokit.request("GET /app");
    if (appResp.data?.slug) {
      installUrl = `https://github.com/apps/${appResp.data.slug}/installations/new`;
    }
  } catch (e) {
    scope?.addBreadcrumb({ message: "Failed to resolve GitHub App slug", category: "github", level: "warning" });
    console.error("Failed to resolve GitHub App slug for install URL", e);
  }

  return { orgs, installUrl };
}

export async function resolveRef(action_repository: string, action_ref: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "resolve_ref");
  scope?.setTag("repository", action_repository);
  scope?.setTag("ref", action_ref);

  const octokit = await getOctoKit(action_repository, scope);
  if (!octokit) {
    throw new Error(`Resolve ref failed: No octokit found for ${action_repository}`);
  }
  async function getRefOrUndefined(ref: string) {
    if (!octokit) {
      return undefined;
    }
    try {
      scope?.setTag("github_operation", "get_ref_or_undefined");
      scope?.setTag("ref", ref);
      const heads = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: action_repository.split("/")[0],
        repo: action_repository.split("/")[1],
        ref
      });
      return heads.data.object.sha;
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }
  if (action_ref.startsWith("heads/") || action_ref.startsWith("tags/")) {
    return await getRefOrUndefined(action_ref);
  } else if (action_ref === "main") {
    return await getRefOrUndefined("heads/main");
  } else {
    const ret2 = await getRefOrUndefined(`tags/${action_ref}`);
    if (ret2) {
      return ret2;
    }
    const ret = await getRefOrUndefined(`heads/${action_ref}`);
    if (ret) {
      return ret;
    }
  }
  throw new UserVisibleError(`Ref not found: ${action_ref} in ${action_repository}`);
}
/**
 * Rebase a storage signed URL from the internal SUPABASE_URL origin onto the
 * public API origin.
 *
 * Edge functions talk to storage through the in-cluster Kong service
 * (SUPABASE_URL=http://pawtograder-kong:8000), so signed URLs come back with
 * that host — which the external grading runner (GitHub Actions) can't resolve
 * ("getaddrinfo ENOTFOUND pawtograder-kong"). The signature covers only the
 * object path + expiry, not the host, so we can safely swap the origin to
 * SUPABASE_PUBLIC_URL (e.g. https://api.staging.pawtograder.net) before handing
 * the link to an external consumer. No-op when SUPABASE_PUBLIC_URL is unset
 * (e.g. supabase.com hosting, where SUPABASE_URL is already public).
 */
export function toPublicSupabaseUrl(url: string): string {
  const publicBase = Deno.env.get("SUPABASE_PUBLIC_URL");
  const internalBase = Deno.env.get("SUPABASE_URL");
  if (!publicBase || !internalBase || !url.startsWith(internalBase)) return url;
  return publicBase.replace(/\/+$/, "") + url.slice(internalBase.length);
}

export async function getRepoTarballURL(repo: string, sha?: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "get_tarball_url");
  scope?.setTag("repository", repo);
  if (sha) scope?.setTag("sha", sha);

  const octokit = await getOctoKit(repo, scope);
  if (!octokit) {
    throw new Error(`Get repo tarball URL failed: No octokit found for ${repo}`);
  }
  let resolved_sha: string;
  if (sha) {
    resolved_sha = sha;
  } else {
    scope?.setTag("github_operation", "get_ref_or_undefined");
    scope?.setTag("ref", "heads/main");
    const head = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: repo.split("/")[0],
      repo: repo.split("/")[1]
    });
    resolved_sha = head.data.object.sha;
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  // Check cache for existing signed URL (less than 55 minutes old)
  const { data: cachedLink } = await adminSupabase
    .from("grader_links_cache")
    .select("signed_url, created_at")
    .eq("repo", repo)
    .eq("sha", resolved_sha)
    .single();

  if (cachedLink) {
    const linkAge = Date.now() - new Date(cachedLink.created_at).getTime();
    const fiftyFiveMinutes = 55 * 60 * 1000;

    if (linkAge < fiftyFiveMinutes) {
      scope?.setTag("cache_hit", "true");
      return {
        download_link: toPublicSupabaseUrl(cachedLink.signed_url),
        sha: resolved_sha
      };
    }
  }

  scope?.setTag("cache_hit", "false");

  // Check if the grader exists in supabase storage
  const { data, error: firstError } = await adminSupabase.storage
    .from("graders")
    .createSignedUrl(`${repo}/${resolved_sha}/archive.tgz`, 3600); // 1 hour

  let signedUrl: string;

  if (firstError) {
    // If the grader doesn't exist, create it
    const grader = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner: repo.split("/")[0],
      repo: repo.split("/")[1],
      ref: resolved_sha
    });
    // Upload the grader to supabase storage
    // TODO do some garbage collection in this bucket, especially for regression tests
    const { error: saveGraderError } = await adminSupabase.storage
      .from("graders")
      .upload(`${repo}/${resolved_sha}/archive.tgz`, grader.data as ArrayBuffer);
    if (saveGraderError) {
      if (saveGraderError.message === "The resource already exists") {
        // This is fine, just continue
      } else {
        throw new Error(`Failed to save grader: ${saveGraderError.message}`);
      }
    }
    // Return the grader
    const { data: secondAttempt, error: secondError } = await adminSupabase.storage
      .from("graders")
      .createSignedUrl(`${repo}/${resolved_sha}/archive.tgz`, 3600); // 1 hour
    if (secondError || !secondAttempt) {
      throw new Error(`Failed to retrieve grader: ${secondError.message}`);
    }
    signedUrl = secondAttempt.signedUrl;
  } else {
    signedUrl = data.signedUrl;
  }

  // Cache the signed URL (optimistic concurrency control - ignore unique constraint violations)
  await adminSupabase.from("grader_links_cache").upsert(
    {
      repo,
      sha: resolved_sha,
      signed_url: signedUrl,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour from now
    },
    {
      onConflict: "repo,sha"
    }
  );
  // Ignore errors from cache update (optimistic concurrency)

  return {
    download_link: toPublicSupabaseUrl(signedUrl),
    sha: resolved_sha
  };
}
export async function cloneRepository(repoName: string, ref: string, scope?: Sentry.Scope) {
  const octokit = await getOctoKit(repoName, scope);
  if (!octokit) {
    throw new Error(`Clone repository failed: No octokit found for ${repoName}`);
  }
  const tarball = await octokit.request("GET /repos/{owner}/{repo}/zipball/{ref}", {
    owner: repoName.split("/")[0],
    repo: repoName.split("/")[1],
    ref
  });
  //Extract the tarball
  if (tarball.data) {
    return Buffer.from(tarball.data as ArrayBuffer);
  } else {
    throw new Error("Failed to fetch tarball");
  }
}

export async function addPushWebhook(
  repoName: string,
  type: "grader_solution" | "template_repo",
  scope?: Sentry.Scope
) {
  scope?.setTag("github_operation", "add_webhook");
  scope?.setTag("repository", repoName);
  scope?.setTag("webhook_type", type);

  const octokit = await getOctoKit(repoName, scope);
  if (!octokit) {
    throw new Error(`Add push webhook failed: No octokit found for ${repoName}`);
  }
  let baseURL = Deno.env.get("SUPABASE_URL")!;
  if (baseURL.includes("kong")) {
    baseURL = "https://khoury-classroom-dev.ngrok.pizza";
  }
  const webhook = await octokit.request("POST /repos/{owner}/{repo}/hooks", {
    owner: repoName.split("/")[0],
    repo: repoName.split("/")[1],
    name: "web",
    config: {
      url: `${baseURL}/functions/v1/github-repo-webhook?type=${type}`,
      content_type: "json",
      secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret"
    },
    events: ["push"]
  });
  console.log("webhook added", webhook.data);
}
export async function removePushWebhook(repoName: string, webhookId: number, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "remove_webhook");
  scope?.setTag("repository", repoName);
  scope?.setTag("webhook_id", webhookId.toString());

  const octokit = await getOctoKit(repoName, scope);
  if (!octokit) {
    throw new Error(`Remove push webhook failed: No octokit found for ${repoName}`);
  }
  const webhook = await octokit.request("DELETE /repos/{owner}/{repo}/hooks/{hook_id}", {
    owner: repoName.split("/")[0],
    repo: repoName.split("/")[1],
    hook_id: webhookId
  });
  console.log("webhook removed", webhook.data);
}

export async function updateAutograderWorkflowHash(repoName: string) {
  const file = (await getFileFromRepo(repoName, ".github/workflows/grade.yml")) as { content: string };
  const hash = createHash("sha256");
  if (!file.content) {
    throw new Error("File not found");
  }
  console.log("Updating autograder workflow hash for", repoName);
  hash.update(file.content);
  const hashStr = hash.digest("hex");
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  console.log("updating autograder workflow hash", hashStr, repoName);
  const { data: assignments } = await adminSupabase.from("assignments").select("id").eq("template_repo", repoName);
  if (!assignments) {
    throw new Error("Assignment not found");
  }
  const { data, error } = await adminSupabase
    .from("autograder")
    .update({
      workflow_sha: hashStr
    })
    .in(
      "id",
      assignments.map((a) => a.id)
    );
  if (error) {
    console.error(error);
    throw new Error("Failed to update autograder workflow hash");
  }
  return hash;
}
export async function repoHasFileAtRef(
  repoName: string,
  path: string,
  ref: string,
  scope?: Sentry.Scope
): Promise<boolean> {
  scope?.setTag("github_operation", "check_file_at_ref");
  scope?.setTag("repository", repoName);
  scope?.setTag("file_path", path);
  scope?.setTag("ref", ref);
  const octokit = await getOctoKit(repoName, scope);
  if (!octokit) {
    throw new Error(`Check file at ref failed: No octokit found for ${repoName}`);
  }
  try {
    await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: repoName.split("/")[0],
      repo: repoName.split("/")[1],
      path,
      ref
    });
    return true;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

export async function getFileFromRepo(repoName: string, path: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "get_file");
  scope?.setTag("repository", repoName);
  scope?.setTag("file_path", path);

  console.log("getting file from repo", repoName, path);
  const octokit = await getOctoKit(repoName, scope);
  if (!octokit) {
    throw new Error(`Get file from repo failed: No octokit found for ${repoName}`);
  }
  console.log("octokit acquired");
  const file = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: repoName.split("/")[0],
    repo: repoName.split("/")[1],
    path
  });
  if ("content" in file.data) {
    const base64Content = file.data.content;
    const content = Buffer.from(base64Content, "base64").toString("utf-8");
    const sha =
      "sha" in file.data && typeof (file.data as { sha?: string }).sha === "string"
        ? (file.data as { sha: string }).sha
        : undefined;
    return { content, sha };
  } else {
    throw new Error("File is not a file");
  }
}

async function getJwks() {
  const jwks = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks");
  const jwksData = await jwks.json();
  return jwksData;
}

export async function validateOIDCToken(token: string): Promise<GitHubOIDCToken> {
  const decoded = decode(token);
  const { kid } = decoded[0] as { kid: string };
  const jwks = await getJwks();
  const publicKey = jwks.keys.find((key: any) => key.kid === kid);
  if (!publicKey) {
    throw new Error("No public key found");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    true,
    ["verify"]
  );
  const verified = await verify(token, key, {
    expLeeway: 3600 // 1 hour
  });
  return verified as GitHubOIDCToken;
}

// E2E testing constants and helper
export const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";
// Read END_TO_END_SECRET strictly - no fallback to prevent security bypass
const END_TO_END_SECRET = Deno.env.get("END_TO_END_SECRET");
// Explicit opt-in flag for E2E testing
const E2E_ENABLE = Deno.env.get("E2E_ENABLE") === "true";

/**
 * Validates an OIDC token, or allows E2E test tokens that use the special prefix.
 * For E2E runs, we don't validate the signature but check that the secret matches.
 *
 * SECURITY: E2E bypass is only enabled if both E2E_ENABLE=true and END_TO_END_SECRET
 * are explicitly set. This prevents accidental use in production.
 */
export async function validateOIDCTokenOrAllowE2E(token: string): Promise<GitHubOIDCToken> {
  const decoded = decode(token);
  const payload = decoded[1] as GitHubOIDCToken;
  if (payload.repository.startsWith(END_TO_END_REPO_PREFIX)) {
    // Fail closed: require explicit opt-in and secret configuration
    if (!E2E_ENABLE) {
      console.error(
        "E2E token detected but E2E_ENABLE is not set to 'true'. " +
          "E2E bypass is disabled for security. Set E2E_ENABLE=true and END_TO_END_SECRET to enable."
      );
      throw new SecurityError(
        "E2E testing is not enabled. E2E bypass requires explicit opt-in via E2E_ENABLE=true and END_TO_END_SECRET environment variables."
      );
    }
    if (!END_TO_END_SECRET || END_TO_END_SECRET.trim() === "") {
      console.error(
        "E2E token detected but END_TO_END_SECRET is missing or empty. " +
          "E2E bypass requires a non-empty secret to prevent unauthorized access."
      );
      throw new SecurityError(
        "E2E testing secret is not configured. END_TO_END_SECRET must be set to a non-empty value to enable E2E bypass."
      );
    }

    const header = decoded[0] as {
      alg: string;
      typ: string;
      kid: string;
    };
    if (header.kid !== END_TO_END_SECRET) {
      throw new SecurityError("E2E repo provided, but secret is incorrect");
    }
    return payload;
  }
  return await validateOIDCToken(token);
}

export async function getRepos(org: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "get_repos");
  scope?.setTag("org", org);

  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const repos = await octokit.paginate("GET /orgs/{org}/repos", {
    org,
    per_page: 100
  });
  return repos;
}

export async function createRepo(
  org: string,
  repoName: string,
  template_repo: string,
  { is_template_repo }: { is_template_repo?: boolean } = {},
  scope?: Sentry.Scope
): Promise<string> {
  scope?.setTag("github_operation", "create_repo");
  scope?.setTag("org", org);
  scope?.setTag("repo_name", repoName);
  scope?.setTag("template_repo", template_repo);
  scope?.setTag("is_template", is_template_repo?.toString() || "false");

  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new UserVisibleError("No GitHub installation found for organization " + org);
  }
  const owner = template_repo.split("/")[0];
  const repo = template_repo.split("/")[1];

  try {
    scope?.setTag("github_operation", "create_repo_request");
    scope?.setTag("template_repo", template_repo);
    scope?.setTag("template_owner", owner);
    scope?.setTag("repo_name", repoName);
    scope?.setTag("org", org);
    console.log("Creating repo", template_repo, owner, repoName, org);
    const resp = await retryWithBackoff(
      () =>
        octokit.request("POST /repos/{template_owner}/{template_repo}/generate", {
          template_repo: repo,
          template_owner: owner,
          owner: org,
          name: repoName,
          private: true
        }),
      2, // maxRetries
      5000, // baseDelayMs
      scope
    );
    console.log(JSON.stringify(resp.headers, null, 2));
    scope?.setTag("github_operation", "create_repo_request_done");
    // Enable squash merging; set template flag when applicable
    scope?.setTag("github_operation", "patch_repo_settings");
    await retryWithBackoff(
      () =>
        octokit.request("PATCH /repos/{owner}/{repo}", {
          owner: org,
          repo: repoName,
          allow_squash_merge: true,
          is_template: is_template_repo ? true : false
        }),
      3, // maxRetries
      1000, // baseDelayMs
      scope
    );
    // Enable GitHub Actions (workaround for GitHub bug where Actions isn't always enabled on template-generated repos)
    scope?.setTag("github_operation", "enable_actions");
    try {
      await retryWithBackoff(
        () =>
          octokit.request("PUT /repos/{owner}/{repo}/actions/permissions", {
            owner: org,
            repo: repoName,
            enabled: true,
            allowed_actions: "all"
          }),
        3,
        1000,
        scope
      );
    } catch (actionsErr) {
      console.error("Error enabling GitHub Actions", actionsErr);
      scope?.setTag("enable_actions_failed", "true");
      Sentry.captureException(actionsErr, scope);
    }
    //Get the head SHA
    scope?.setTag("github_operation", "get_head_sha");
    scope?.setTag("ref", "heads/main");
    const heads = await retryWithBackoff(
      () =>
        octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
          owner: org,
          repo: repoName
        }),
      5, // maxRetries
      3000, // baseDelayMs
      scope
    );
    scope?.setTag("head_sha", heads.data.object.sha);

    // Create branch protection ruleset to prevent force pushes
    scope?.setTag("github_operation", "create_branch_protection_ruleset");
    try {
      await createBranchProtectionRuleset(org, repoName, scope);
    } catch (rulesetError) {
      // Log but don't fail repo creation if ruleset creation fails
      console.error("Error creating branch protection ruleset", rulesetError);
      scope?.setTag("ruleset_creation_failed", "true");
      Sentry.captureException(rulesetError, scope);
    }

    return heads.data.object.sha as string;
  } catch (e) {
    console.error("Error creating repo", e);
    if (e instanceof RequestError) {
      if (e.message.includes("Name already exists on this account")) {
        // Repo already exists, get the head SHA
        scope?.setTag("repo_already_exists", "true");
        scope?.setTag("github_operation", "get_existing_repo_head_sha");
        const heads = await retryWithBackoff(
          () =>
            octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
              owner: org,
              repo: repoName
            }),
          3, // maxRetries
          1000, // baseDelayMs
          scope
        );
        scope?.setTag("head_sha", heads.data.object.sha);
        // Match settings we apply on fresh creates (e.g. squash merge).
        try {
          await retryWithBackoff(
            () =>
              octokit.request("PATCH /repos/{owner}/{repo}", {
                owner: org,
                repo: repoName,
                allow_squash_merge: true,
                is_template: is_template_repo ? true : false
              }),
            3,
            1000,
            scope
          );
        } catch (patchErr) {
          console.error("Error patching repo settings for pre-existing repo", patchErr);
          scope?.setTag("patch_existing_repo_settings_failed", "true");
          Sentry.captureException(patchErr, scope);
        }
        // Enable GitHub Actions (workaround for GitHub bug where Actions isn't always enabled on template-generated repos)
        scope?.setTag("github_operation", "enable_actions");
        try {
          await retryWithBackoff(
            () =>
              octokit.request("PUT /repos/{owner}/{repo}/actions/permissions", {
                owner: org,
                repo: repoName,
                enabled: true,
                allowed_actions: "all"
              }),
            3,
            1000,
            scope
          );
        } catch (actionsErr) {
          console.error("Error enabling GitHub Actions for pre-existing repo", actionsErr);
          scope?.setTag("enable_actions_failed", "true");
          Sentry.captureException(actionsErr, scope);
        }
        return heads.data.object.sha as string;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
}

/**
 * Checks if a RequestError indicates a duplicate ruleset (by ID/name or "already exists" message)
 */
function checkIfDuplicateRulesetError(e: RequestError): boolean {
  // Check error message for duplicate indicators
  const message = e.message?.toLowerCase() || "";
  if (message.includes("already exists") || message.includes("duplicate") || message.includes("name already")) {
    return true;
  }

  // Check response.errors array for duplicate indicators
  const errors = e.response?.data?.errors;
  if (Array.isArray(errors)) {
    for (const error of errors) {
      const errorMessage =
        typeof error === "string" ? error.toLowerCase() : (error?.message || error?.field || "").toLowerCase();

      if (
        errorMessage.includes("already exists") ||
        errorMessage.includes("duplicate") ||
        errorMessage.includes("name already") ||
        errorMessage.includes("id already")
      ) {
        return true;
      }
    }
  }

  // Check response.data.message for duplicate indicators
  const responseMessage = e.response?.data?.message?.toLowerCase() || "";
  if (
    responseMessage.includes("already exists") ||
    responseMessage.includes("duplicate") ||
    responseMessage.includes("name already")
  ) {
    return true;
  }

  return false;
}

/**
 * Creates a branch protection ruleset to prevent force pushes on the default branch
 * Uses GitHub's repository rulesets API (newer approach)
 */
export async function createBranchProtectionRuleset(
  org: string,
  repoName: string,
  scope?: Sentry.Scope
): Promise<void> {
  scope?.setTag("github_operation", "create_branch_protection_ruleset");
  scope?.setTag("org", org);
  scope?.setTag("repo_name", repoName);

  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new UserVisibleError("No GitHub installation found for organization " + org);
  }

  try {
    await retryWithBackoff(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/rulesets", {
          owner: org,
          repo: repoName,
          name: "Protect main branch",
          target: "branch",
          enforcement: "active",
          bypass_actors: [],
          conditions: {
            ref_name: {
              include: ["~DEFAULT_BRANCH"],
              exclude: []
            }
          },
          rules: [
            {
              type: "non_fast_forward"
            }
          ]
        }),
      3, // maxRetries
      1000, // baseDelayMs
      scope
    );
    scope?.setTag("ruleset_created", "true");
  } catch (e) {
    if (e instanceof RequestError) {
      // Only suppress if this is explicitly a duplicate ruleset error
      if (e.status === 422 || e.status === 409) {
        const isDuplicateRuleset = checkIfDuplicateRulesetError(e);
        if (isDuplicateRuleset) {
          scope?.setTag("ruleset_already_exists", "true");
          console.log(`Branch protection ruleset may already exist for ${org}/${repoName}`);
          return;
        }
        // If it's 422/409 but not a duplicate error, rethrow so callers can handle it
      }

      // Free GitHub accounts can't enable branch protection on private repositories.
      // GitHub returns "Upgrade to GitHub Pro or make this repository public to enable
      // this feature." — there's no way for the platform to satisfy this from server
      // side, so swallow it: the repo is created and usable, just without the ruleset.
      const message = (e.message || "").toLowerCase();
      if (
        message.includes("upgrade to github pro") ||
        message.includes("upgrade your github plan") ||
        message.includes("upgrade your account")
      ) {
        scope?.setTag("ruleset_unsupported_by_plan", "true");
        console.log(`Branch protection ruleset not supported by GitHub plan for ${org}/${repoName} — skipping`);
        return;
      }
    }
    throw e;
  }
}
async function listFilesInRepoDirectory(
  octokit: Octokit,
  orgName: string,
  repoName: string,
  path: string
): Promise<FileListing[]> {
  const files = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: orgName,
    repo: repoName,
    path,
    mediaType: {
      format: "raw"
    },
    per_page: 100
  });
  if (Array.isArray(files.data)) {
    const ret = await Promise.all(
      files.data.map(async (file): Promise<FileListing[]> => {
        if (file.type === "dir") {
          return await listFilesInRepoDirectory(octokit, orgName, repoName, file.path);
        }
        if (file.type === "file") {
          return [
            {
              name: file.name,
              path: file.path,
              size: file.size,
              sha: file.sha
            }
          ];
        } else {
          return [];
        }
      })
    );
    return ret.flat();
  }
  throw new UserVisibleError(`Failed to list files in repo directory: not an array, in ${repoName} at ${path}`);
}
export async function listFilesInRepo(org: string, repo: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "list_files");
  scope?.setTag("org", org);
  scope?.setTag("repo", repo);

  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  return await listFilesInRepoDirectory(octokit, org, repo, "");
}

function isGitHubNotFoundError(error: unknown): boolean {
  return (
    (error instanceof RequestError && error.status === 404) ||
    (error instanceof Error && error.message.includes("Not Found"))
  );
}

export async function archiveRepoAndLock(org: string, repo: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "archive_repo");
  scope?.setTag("org", org);
  scope?.setTag("repo", repo);

  if (repo.includes("/")) {
    const [owner, repoName] = repo.split("/");
    org = owner;
    repo = repoName;
  }
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  console.log(`archiving repo ${org}/${repo}`);
  //Remove all direct access to the repo
  let collaborators: Endpoints["GET /repos/{owner}/{repo}/collaborators"]["response"];
  try {
    collaborators = await octokit.request("GET /repos/{owner}/{repo}/collaborators", {
      owner: org,
      repo,
      per_page: 100
    });
  } catch (error) {
    if (isGitHubNotFoundError(error)) {
      console.log(`repo ${org}/${repo} not found while archiving; treating as already archived`);
      return;
    }
    throw error;
  }
  for (const collaborator of collaborators.data) {
    console.log("removing collaborator", collaborator.login);
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
        owner: org,
        repo,
        username: collaborator.login
      });
    } catch (error) {
      if (isGitHubNotFoundError(error)) {
        console.log(`repo ${org}/${repo} or collaborator ${collaborator.login} not found while archiving; continuing`);
        continue;
      }
      throw error;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newName = `archived-${timestamp}-${repo}`;
  console.log("renaming repo to", newName);
  //Rename the repo
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}", {
      owner: org,
      repo,
      name: newName
    });
  } catch (error) {
    if (isGitHubNotFoundError(error)) {
      console.log(`repo ${org}/${repo} not found while renaming; treating as already archived`);
      return;
    }
    throw error;
  }
}
/**
 * Syncs the staff team for a course.
 *
 * @param org The organization name.
 * @param courseSlug The course slug.
 * @param githubUsernamesFetcher A function that fetches the list of GitHub usernames for the staff team.
 *     This function should be idempotent, and should not throw an error if the team already exists (or not).
 *     The intended members are fetched AFTER fetching the current members of the team to avoid race conditions.
 */
export async function syncStaffTeam(
  org: string,
  courseSlug: string,
  githubUsernamesFetcher: () => Promise<string[]>,
  scope?: Sentry.Scope
) {
  await syncTeam(`${courseSlug}-staff`, org, githubUsernamesFetcher, scope);
}
/**
 * Syncs the student team for a course.
 *
 * @param org The organization name.
 * @param courseSlug The course slug.
 * @param githubUsernamesFetcher A function that fetches the list of GitHub usernames for the student team.
 *     This function should be idempotent, and should not throw an error if the team already exists (or not).
 *     The intended members are fetched AFTER fetching the current members of the team to avoid race conditions.
 */
export async function syncStudentTeam(
  org: string,
  courseSlug: string,
  githubUsernamesFetcher: () => Promise<string[]>,
  scope?: Sentry.Scope
) {
  await syncTeam(`${courseSlug}-students`, org, githubUsernamesFetcher, scope);
}
/**
 * Syncs a team for a course.
 *
 * This function is used to sync the members of a team for a course.
 * It is used to ensure that the team has the correct members, and to add and remove members as needed.
 *
 * @param team_slug The slug of the team to sync.
 * @param org The organization name.
 * @param githubUsernamesFetcher A function that fetches the list of GitHub usernames for the team.
 *     This function should be idempotent, and should not throw an error if the team already exists (or not).
 *     The intended members are fetched AFTER fetching the current members of the team to avoid race conditions.
 */
export async function syncTeam(
  team_slug: string,
  org: string,
  githubUsernamesFetcher: () => Promise<string[]>,
  scope?: Sentry.Scope
) {
  scope?.setTag("github_operation", "sync_team");
  scope?.setTag("org", org);
  scope?.setTag("team_slug", team_slug);

  if (!org || !team_slug) {
    console.warn("Invalid org or team_slug", org, team_slug);
    return;
  }
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    console.warn("No octokit found for organization " + org);
    return;
  }
  let team_id: number;
  try {
    const team = await octokit.request("GET /orgs/{org}/teams/{team_slug}", {
      org,
      team_slug
    });
    team_id = team.data.id;
    console.log(`Found team ${team_slug} with id ${team_id}`);
  } catch (e) {
    if (e instanceof RequestError && e.message.includes("Not Found")) {
      // Team doesn't exist, create it
      const newTeam = await octokit.request("POST /orgs/{org}/teams", {
        org,
        name: team_slug
      });
      team_id = newTeam.data.id;
      console.log(`Created team ${team_slug} with id ${team_id}`);
    } else {
      throw e;
    }
  }
  let members: Endpoints["GET /orgs/{org}/teams/{team_slug}/members"]["response"]["data"][] = [];
  try {
    const data = await octokit.paginate("GET /orgs/{org}/teams/{team_slug}/members", {
      org,
      team_slug,
      per_page: 100
    });
    members = data;
  } catch (e) {
    if (e instanceof RequestError && e.message.includes("Not Found")) {
      console.log(`Team ${team_slug} not found`);
      console.log(e);
      //This seems to happen when there are no members in the team?
      members = [];
    } else {
      throw e;
    }
  }
  const githubUsernames = (await githubUsernamesFetcher()).map((u) => u.toLowerCase());
  const existingMembers = members.map((m) => m.login.toLowerCase());
  const newMembers = githubUsernames.filter((u) => u && !existingMembers.includes(u));
  const removeMembers = existingMembers.filter((u) => u && !githubUsernames.includes(u));
  console.log(`Class team: ${team_slug} intended members: ${githubUsernames.join(", ")}`);
  console.log(`Existing members in team ${team_slug}: ${members.map((m) => m.login).join(", ")}`);
  console.log(`New members to add: ${newMembers.join(", ")}`);
  console.log(`Members to remove: ${removeMembers.join(", ")}`);
  for (const username of newMembers) {
    try {
      await octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
        org,
        team_slug,
        username,
        role: "member"
      });
    } catch (e) {
      const newScope = scope?.clone();
      newScope?.setTag("github_operation_error", "failed_to_add_member");
      newScope?.setTag("username", username);
      console.log("Error adding member", username);
      console.error(e);
      Sentry.captureException(e, newScope);
    }
  }
  for (const username of removeMembers) {
    const newScope = scope?.clone();
    newScope?.setTag("username", username);
    Sentry.captureMessage(`Removing member from team ${team_slug}`, newScope);
    await octokit.request("DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug,
      username
    });
  }
}
async function getTeamAndCreateIfNeeded(org: string, team_slug: string, octokit: Octokit) {
  try {
    const team = await octokit.request("GET /orgs/{org}/teams/{team_slug}", {
      org,
      team_slug
    });
    return team;
  } catch (e) {
    console.log(`Team ${team_slug} not found, creating it`);
    if (e instanceof RequestError && e.message.includes("Not Found")) {
      // Team doesn't exist, create it
      const newTeam = await octokit.request("POST /orgs/{org}/teams", {
        org,
        name: team_slug
      });
      return newTeam;
    }
    throw e;
  }
}

export async function reinviteToOrgTeam(org: string, team_slug: string, githubUsername: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "reinvite_to_team");
  scope?.setTag("org", org);
  scope?.setTag("team_slug", team_slug);
  scope?.setTag("github_username", githubUsername);
  scope?.addBreadcrumb({
    category: "github",
    message: `Reinviting user ${githubUsername} to team ${team_slug} in org ${org}`,
    level: "info"
  });

  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const team = await getTeamAndCreateIfNeeded(org, team_slug, octokit);
  const user = await octokit.request("GET /users/{username}", {
    username: githubUsername
  });
  const userID = user.data.id;
  const teamID = team.data.id;
  scope?.addBreadcrumb({
    category: "github",
    message: `Team ${team_slug} has id ${teamID}`,
    level: "info"
  });

  // Check if user is already in the team
  try {
    scope?.addBreadcrumb({
      category: "github",
      message: `Checking if user ${githubUsername} is already in team ${team_slug}...`,
      level: "info"
    });
    const teamMembers = await octokit.paginate("GET /orgs/{org}/teams/{team_slug}/members", {
      org,
      team_slug,
      per_page: 100 // Optimize for large teams
    });
    scope?.addBreadcrumb({
      category: "github",
      message: `Found ${teamMembers.length} members in team ${team_slug}`,
      level: "info"
    });

    const isUserInTeam = teamMembers.some((member) => member.login === githubUsername);
    if (isUserInTeam) {
      scope?.addBreadcrumb({
        category: "github",
        message: `User ${githubUsername} is already in team ${team_slug}`,
        level: "info"
      });
      return false;
    }
    scope?.addBreadcrumb({
      category: "github",
      message: `User ${githubUsername} is not in team ${team_slug}, proceeding with invitation`,
      level: "info"
    });
  } catch (error) {
    console.log(`Error checking team membership: ${error}`);
    // Continue with invitation if we can't check membership
  }

  // Proactively check whether the user is already an active member of the org.
  // GitHub's POST /orgs/{org}/invitations endpoint only works for non-members; for users that are
  // already in the org (e.g. invited via another class in the same org and accepted), we must add
  // them to the team directly with PUT /orgs/{org}/teams/{team_slug}/memberships/{username}.
  // Relying on the POST error message is fragile (it varies between "this org" and "this organization"),
  // so we check membership state explicitly first.
  let isAlreadyActiveOrgMember = false;
  try {
    const orgMembership = await octokit.request("GET /orgs/{org}/memberships/{username}", {
      org,
      username: githubUsername
    });
    const state = (orgMembership.data as { state?: string } | undefined)?.state;
    if (orgMembership.status === 200 && state === "active") {
      isAlreadyActiveOrgMember = true;
    }
    scope?.addBreadcrumb({
      category: "github",
      message: `Org membership state for ${githubUsername} in ${org}: ${state ?? "unknown"}`,
      level: "info"
    });
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 404) {
      scope?.addBreadcrumb({
        category: "github",
        message: `User ${githubUsername} is not a member of ${org} (404), will send invitation`,
        level: "info"
      });
    } else {
      scope?.addBreadcrumb({
        category: "github",
        message: `Error checking org membership for ${githubUsername} in ${org}: ${e}`,
        level: "warning"
      });
    }
  }

  if (isAlreadyActiveOrgMember) {
    scope?.addBreadcrumb({
      category: "github",
      message: `User ${githubUsername} is already in org ${org}; adding directly to team ${team_slug}`,
      level: "info"
    });
    await octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug,
      username: githubUsername,
      role: "member"
    });
    await markUserRoleOrgConfirmedForTeam({ github_username: githubUsername, org, team_slug });
    return false;
  }

  try {
    const limiter = getCreateContentLimiter(org);
    const resp = await limiter.schedule(() =>
      octokit.request("POST /orgs/{org}/invitations", {
        org,
        role: "direct_member",
        invitee_id: userID,
        team_ids: [teamID]
      })
    );
    scope?.addBreadcrumb({
      category: "github",
      message: `Invitation response: ${JSON.stringify(resp.data)}`,
      level: "info"
    });
    return true;
  } catch (err) {
    scope?.addBreadcrumb({
      category: "github",
      message: `Org invitation failed, inspecting error message...`,
      level: "info"
    });
    const errWithShape = err as {
      message?: unknown;
      response?: { data?: { errors?: Array<{ message?: unknown; code?: unknown; field?: unknown }> } };
    };
    const collectedMessages: string[] = [];
    if (typeof errWithShape.message === "string") {
      collectedMessages.push(errWithShape.message);
    }
    const responseErrors = errWithShape.response?.data?.errors;
    if (Array.isArray(responseErrors)) {
      for (const e of responseErrors) {
        if (typeof e?.message === "string") {
          collectedMessages.push(e.message);
        }
      }
    }
    const combinedMessage = collectedMessages.join("; ") || JSON.stringify(err);
    scope?.addBreadcrumb({
      category: "github",
      message: `Invitation error message: ${combinedMessage}`,
      level: "info"
    });
    // Detect "user is already in the organization" via either a structured "already_exists" error on
    // the invitee_id field, or a permissive text match (GitHub's wording varies between
    // "this org" and "this organization").
    const structurallyAlreadyMember =
      Array.isArray(responseErrors) &&
      responseErrors.some(
        (e) =>
          (e?.code === "already_exists" || e?.code === "unprocessable") &&
          (e?.field === "invitee_id" || e?.field === "data")
      );
    const textuallyAlreadyMember = /already.*(part|member).*(org|organization)/i.test(combinedMessage);
    if (structurallyAlreadyMember || textuallyAlreadyMember) {
      scope?.addBreadcrumb({
        category: "github",
        message: `User ${githubUsername} appears to already be in org ${org}; adding to team ${team_slug}`,
        level: "info"
      });
      //Add them to the team directly...
      await octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
        org,
        team_slug,
        username: githubUsername,
        role: "member"
      });
      //...and mark the corresponding class's user_role as org-confirmed.
      await markUserRoleOrgConfirmedForTeam({ github_username: githubUsername, org, team_slug });
      return false;
    }
    throw err;
  }
}
const staffTeamCache = new Map<string, Promise<string[]>>();
const orgMembershipCache = new Map<string, Promise<Endpoints["GET /orgs/{org}/members"]["response"]["data"][]>>();
async function getTeamMembers(org: string, team_slug: string, octokit: Octokit): Promise<string[]> {
  try {
    const team = await octokit.paginate("GET /orgs/{org}/teams/{team_slug}/members", {
      org,
      team_slug
    });
    return team.map((m) => m.login.toLowerCase());
  } catch (e) {
    // If it's a 404 error from GitHub, add a breadcrumb and return empty array
    if (e && typeof e === "object" && "status" in e && (e as { status?: number }).status === 404) {
      Sentry.addBreadcrumb({
        category: "github.api",
        message: `404 Not Found when fetching team members for org: ${org}, team_slug: ${team_slug}`,
        level: "info"
      });
      return [];
    }
    throw e;
  }
}
async function getOrgMembers(
  org: string,
  octokit: Octokit
): Promise<Endpoints["GET /orgs/{org}/members"]["response"]["data"][]> {
  const members = await octokit.paginate("GET /orgs/{org}/members", {
    org
  });
  return members;
}
async function updateGitHubUsernameForUser(
  oldUsername: string,
  octokit: Octokit,
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope?: Sentry.Scope
): Promise<{ oldUsername: string; newUsername: string | null }> {
  // Find the github user id from the public.users table for the given github username
  const { data: userData, error: userError } = await adminSupabase
    .from("users")
    .select("github_user_id, user_id")
    .eq("github_username", oldUsername)
    .single();

  if (userError || !userData?.github_user_id) {
    // User not found or no github_user_id, skip
    return { oldUsername, newUsername: null };
  }

  try {
    // Get the current github user name from that id
    const gitHubUser = await octokit.request("GET /user/{account_id}", {
      account_id: Number(userData.github_user_id),
      headers: {
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (gitHubUser.status === 200 && gitHubUser.data.login) {
      const newUsername = gitHubUser.data.login.toLowerCase();

      // Update our users record with that new username
      const { error: updateError } = await adminSupabase
        .from("users")
        .update({
          github_username: newUsername,
          last_github_user_sync: new Date().toISOString()
        })
        .eq("user_id", userData.user_id);

      if (updateError) {
        scope?.addBreadcrumb({
          category: "github",
          message: `Failed to update username for user ${userData.user_id}: ${updateError.message}`,
          level: "error"
        });
        console.log(`Failed to update username for user ${userData.user_id}: ${updateError.message}`);
        return { oldUsername, newUsername: null };
      } else if (newUsername !== oldUsername) {
        scope?.addBreadcrumb({
          category: "github",
          message: `Updated GitHub username from ${oldUsername} to ${newUsername} for user ${userData.user_id}`,
          level: "info"
        });
        console.log(`Updated GitHub username from ${oldUsername} to ${newUsername} for user ${userData.user_id}`);
        return { oldUsername, newUsername };
      }
    }
  } catch (error) {
    scope?.addBreadcrumb({
      category: "github",
      message: `Error fetching GitHub user for user_id ${userData.user_id}: ${error}`,
      level: "error"
    });
    console.log(`Error fetching GitHub user for user_id ${userData.user_id}:`, error);
  }

  return { oldUsername, newUsername: null };
}
export async function syncRepoPermissions(
  org: string,
  repo: string,
  courseSlug: string,
  githubUsernamesMixedCase: string[],
  _scope?: Sentry.Scope
): Promise<{ madeChanges: boolean }> {
  let madeChanges = false;
  const scope = _scope?.clone();
  const githubUsernames = githubUsernamesMixedCase.map((u) => u.toLowerCase());
  scope?.setTag("github_operation", "sync_repo_permissions");
  scope?.setTag("org", org);
  scope?.setTag("repo", repo);
  scope?.setTag("course_slug", courseSlug);
  scope?.setTag("user_count", githubUsernames.length.toString());

  if (repo.includes("/")) {
    const [owner, repoName] = repo.split("/");
    org = owner;
    repo = repoName;
  }
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const team_slug = `${courseSlug}-staff`;
  if (!staffTeamCache.has(org + "-" + courseSlug)) {
    staffTeamCache.set(
      org + "-" + courseSlug,
      getTeamMembers(org, team_slug, octokit).catch((err) => {
        staffTeamCache.delete(org + "-" + courseSlug);
        throw err;
      })
    );
  }
  const staffTeamUsernames = await staffTeamCache.get(org + "-" + courseSlug);
  if (!orgMembershipCache.has(org)) {
    orgMembershipCache.set(
      org,
      getOrgMembers(org, octokit).catch((err) => {
        orgMembershipCache.delete(org);
        throw err;
      })
    );
  }
  const orgMembers = await orgMembershipCache.get(org);
  const allOrgMembers = orgMembers?.map((u) => u.login.toLowerCase());
  const existingAccess = await retryWithBackoff(
    () =>
      octokit.paginate("GET /repos/{owner}/{repo}/collaborators", {
        owner: org,
        repo,
        per_page: 100
      }),
    5,
    3000,
    scope
  );
  const existingUsernames = existingAccess
    .filter((c) => c.role_name === "admin" || c.role_name === "write" || c.role_name === "maintain")
    .map((c) => c.login.toLowerCase());
  scope?.addBreadcrumb({
    category: "github",
    message: `${org}/${repo} existing collaborators: ${existingUsernames.join(", ")}`,
    level: "info"
  });
  // console.log(`${org}/${repo} existing collaborators: ${existingUsernames.join(", ")}`);
  //Check if staff team has access to the repo, if not, add it
  const teamsWithAccess = await octokit.paginate("GET /repos/{owner}/{repo}/teams", {
    owner: org,
    repo
  });
  if (!teamsWithAccess.length || !teamsWithAccess.some((t) => t.slug === team_slug)) {
    madeChanges = true;
    await octokit.request("PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
      org,
      team_slug,
      owner: org,
      repo,
      permission: "maintain"
    });
  }
  const desiredUsersNotInCachedOrg = githubUsernames.filter((u) => !allOrgMembers?.includes(u));
  console.log(`${org}/${repo} desired users not in cached org members: ${desiredUsersNotInCachedOrg.join(", ")}`);
  //The API for PUT /repos/{owner}/{repo}/collaborators/{username} REQUIRES the username, can't be user id.
  //So, if a student changes their username, we won't be able to sync their repo permissions here because
  //we have the old username on file. But, we can find those becuase they won't be in the org members list.

  // For users not in cached org members, verify their membership individually with fresh API calls.
  // This handles the race condition where a user joins the org after the cache was populated.
  const verifiedOrgMembers = new Set(allOrgMembers?.map((u) => u.toLowerCase()) || []);

  if (desiredUsersNotInCachedOrg.length > 0) {
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    // Create a bottleneck limiter to run no more than 20 at once
    const limiter = new Bottleneck({
      maxConcurrent: 20
    });

    // For each user not in cached org, check if they're actually in the org now (fresh API call)
    // and also handle potential username changes
    const verificationResults = await Promise.all(
      desiredUsersNotInCachedOrg.map((username) =>
        limiter.schedule(async () => {
          // First, try to verify current membership with fresh API call
          try {
            await octokit.request("GET /orgs/{org}/members/{username}", {
              org,
              username
            });
            // User IS in org - they were just not in the stale cache
            scope?.addBreadcrumb({
              category: "github",
              message: `${username} verified as org member (was not in cache)`,
              level: "info"
            });
            return { username, isInOrg: true, newUsername: null };
          } catch (membershipError: unknown) {
            const err = membershipError as { status?: number };
            if (err.status === 404 || err.status === 302) {
              // User is NOT in org - might be a username change
              const result = await updateGitHubUsernameForUser(username, octokit, adminSupabase, scope);
              if (result.newUsername) {
                // Username changed - verify new username is in org
                try {
                  await octokit.request("GET /orgs/{org}/members/{username}", {
                    org,
                    username: result.newUsername
                  });
                  return { username, isInOrg: true, newUsername: result.newUsername };
                } catch {
                  return { username, isInOrg: false, newUsername: result.newUsername };
                }
              }
              return { username, isInOrg: false, newUsername: null };
            }
            throw membershipError;
          }
        })
      )
    );

    // Update githubUsernames array with new usernames and track verified members
    for (const { username, isInOrg, newUsername } of verificationResults) {
      if (newUsername) {
        const index = githubUsernames.indexOf(username);
        if (index !== -1) {
          githubUsernames[index] = newUsername;
        }
        if (isInOrg) {
          verifiedOrgMembers.add(newUsername.toLowerCase());
        }
      } else if (isInOrg) {
        verifiedOrgMembers.add(username.toLowerCase());
      }
    }
  }

  const newAccess = githubUsernames.filter(
    (u) => !existingUsernames.includes(u) && verifiedOrgMembers.has(u.toLowerCase())
  );
  const removeAccess = existingUsernames.filter(
    (u) =>
      !githubUsernames.includes(u) &&
      !staffTeamUsernames?.includes(u) &&
      !adminsThatShouldNotBeListedAsAdmins.includes(u)
  );
  for (const username of newAccess) {
    madeChanges = true;
    const resp = await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
      owner: org,
      repo,
      username,
      permission: "write"
    });
    scope?.addBreadcrumb({
      category: "github",
      message: `${org}/${repo} adding collaborator ${username}`,
      level: "info"
    });
    if (resp.status !== 201 && resp.status !== 204) {
      console.log(`Failed to add collaborator ${username} to ${org}/${repo}`);
      console.log(resp);
      const localScope = scope?.clone();
      localScope?.setTag("github_operation_error", "failed_to_add_collaborator");
      localScope?.setContext("response", { data: resp });
      Sentry.captureException(new Error(`Failed to add collaborator to repo`), localScope);
    }
  }
  for (const username of removeAccess) {
    madeChanges = true;
    scope?.addBreadcrumb({
      category: "github",
      message: `${org}/${repo} removing collaborator ${username}`,
      level: "info"
    });

    console.log(`removing collaborator ${username} from ${org}/${repo}`);
    const newScope = scope?.clone();
    newScope?.setTag("username", username);
    Sentry.captureMessage(`Removing collaborator in ${org}`, newScope);
    await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
      owner: org,
      repo,
      username
    });
  }
  return { madeChanges };
}
/**
 * Mark the user_role row for a specific (org, team_slug) as github_org_confirmed = true.
 *
 * The team slug encodes which class+role this is: `{classSlug}-staff` or `{classSlug}-students`.
 * We deliberately scope the confirmation to the class whose team the user was just added to,
 * NOT to every class in the org. Otherwise, when a user has roles in multiple classes that share
 * a GitHub org, confirming one team would falsely mark them as confirmed in the others.
 */
async function markUserRoleOrgConfirmedForTeam({
  github_username,
  org,
  team_slug
}: {
  github_username: string;
  org: string;
  team_slug: string;
}) {
  let courseSlug: string | undefined;
  let allowedRoles: ("instructor" | "grader" | "student")[] = [];
  if (team_slug.endsWith("-staff")) {
    courseSlug = team_slug.slice(0, -"-staff".length);
    allowedRoles = ["instructor", "grader"];
  } else if (team_slug.endsWith("-students")) {
    courseSlug = team_slug.slice(0, -"-students".length);
    allowedRoles = ["student"];
  } else {
    console.warn(`markUserRoleOrgConfirmedForTeam: unrecognized team_slug "${team_slug}", skipping`);
    return;
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const { data: userData, error: userError } = await adminSupabase
    .from("users")
    .select("user_id")
    .ilike("github_username", github_username)
    .maybeSingle();
  if (userError) {
    throw new Error(`Error finding user with github_username ${github_username}: ${userError.message}`);
  }
  if (!userData) {
    console.warn(`markUserRoleOrgConfirmedForTeam: no user found for github_username ${github_username}`);
    return;
  }

  const { data: classData, error: classError } = await adminSupabase
    .from("classes")
    .select("id")
    .eq("github_org", org)
    .eq("slug", courseSlug)
    .maybeSingle();
  if (classError) {
    throw new Error(`Error finding class for org ${org} slug ${courseSlug}: ${classError.message}`);
  }
  if (!classData) {
    console.warn(`markUserRoleOrgConfirmedForTeam: no class found for org ${org} slug ${courseSlug}`);
    return;
  }

  const { error: updateError } = await adminSupabase
    .from("user_roles")
    .update({ github_org_confirmed: true })
    .eq("user_id", userData.user_id)
    .eq("class_id", classData.id)
    .in("role", allowedRoles);
  if (updateError) {
    throw new Error(
      `Failed to mark user_role org-confirmed for ${github_username} in class ${classData.id}: ${updateError.message}`
    );
  }
  console.log(
    `Marked user_role github_org_confirmed=true for ${github_username} in class ${classData.id} (team ${team_slug})`
  );
}

export async function listCommits(
  repo_full_name: string,
  page: number,
  scope?: Sentry.Scope
): Promise<{
  commits: ListCommitsResponse["data"];
  has_more: boolean;
}> {
  scope?.setTag("github_operation", "list_commits");
  scope?.setTag("repository", repo_full_name);
  scope?.setTag("page", page.toString());

  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner: org,
    repo,
    per_page: 100,
    page
  });
  const page_links = commits.headers["link"];
  // `link` header omits the `next` rel entirely on the last page, so an undefined
  // match must be treated as "no more pages". `next_page !== null` was true for
  // `undefined`, which made `has_more` always true.
  const next_page = page_links
    ?.split(",")
    .find((l) => l.includes('rel="next"'))
    ?.split(";")[0]
    .trim();
  return {
    commits: commits.data,
    has_more: Boolean(next_page) && commits.data.length > 0
  };
}

export async function getCommit(
  repo_full_name: string,
  ref: string,
  scope?: Sentry.Scope
): Promise<GetCommitResponse["data"]> {
  scope?.setTag("github_operation", "get_commit");
  scope?.setTag("repository", repo_full_name);
  scope?.setTag("ref", ref);

  const parts = repo_full_name
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length !== 2) {
    throw new Error(`Invalid repo_full_name format: ${repo_full_name}`);
  }
  const [org, repo] = parts;
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const commit = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner: org,
    repo,
    ref
  });
  return commit.data;
}

export async function triggerWorkflow(
  repo_full_name: string,
  sha: string,
  workflow_name: string,
  _scope?: Sentry.Scope
) {
  const scope = _scope?.clone();
  scope?.setTag("github_operation", "trigger_workflow");
  scope?.setTag("repository", repo_full_name);
  scope?.setTag("sha", sha);
  scope?.setTag("workflow_name", workflow_name);

  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const ref = `pawtograder-submit/${sha}`;
  //Create a tag for this sha to use to trigger the workflow
  try {
    // console.log("created ref", res.data);
    await octokit.request("POST /repos/{owner}/{repo}/git/tags", {
      owner: org,
      repo,
      tag: `pawtograder-submit/${sha}`,
      message: "pawtograder submission",
      object: sha,
      type: "commit",
      tagger: {
        name: "pawtograder",
        email: "khoury-pawtograder-app@ccs.neu.edu",
        date: new Date().toISOString()
      }
    });
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: org,
      repo,
      ref: `refs/tags/${ref}`,
      sha
    });
  } catch (err) {
    //If the ref already exists, don't worry about it
    if (err instanceof RequestError && err.message.includes("Reference already exists")) {
      console.log("Reference already exists, skipping");
    } else {
      throw err;
    }
  }
  console.log(`triggering workflow ${workflow_name} on ${repo_full_name} at ${ref}`);
  await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner: org,
    repo,
    workflow_id: workflow_name,
    ref
  });
  console.log("Workflow triggered on ", repo_full_name);
  return "Workflow triggered";
}

export type CheckRunUpdateProps = Endpoints["PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"]["parameters"];
export async function updateCheckRun(props: CheckRunUpdateProps, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "update_check_run");
  scope?.setTag("org", props.owner);
  scope?.setTag("repo", props.repo);
  scope?.setTag("check_run_id", props.check_run_id.toString());

  const octokit = await getOctoKit(props.owner, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + props.owner);
  }
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", props);
}

export async function createCheckRun(repo_full_name: string, sha: string, details_url: string, scope?: Sentry.Scope) {
  scope?.setTag("github_operation", "create_check_run");
  scope?.setTag("repository", repo_full_name);
  scope?.setTag("sha", sha);

  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }

  const res = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner: org,
    repo,
    name: "pawtograder",
    head_sha: sha,
    details_url,
    status: "queued",
    output: {
      title: "Submission Status",
      summary: "Submission not created",
      text: "Code was received by GitHub, but has not been automatically submitted to Pawtograder."
    }
  });
  return res.data;
}
export async function getRepo(org: string, repo: string, scope?: Sentry.Scope) {
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const repoData = await octokit.request("GET /repos/{owner}/{repo}", {
    owner: org,
    repo
  });
  return repoData.data;
}
export async function isUserInOrg(github_username: string, org: string) {
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }

  try {
    // Check if the user is a member of the organization
    await octokit.request("GET /orgs/{org}/members/{username}", {
      org: org,
      username: github_username
    });
    return true; // User is a member
  } catch (error: any) {
    // If the request fails with 404, the user is not a member or membership is private
    // If it fails with 302, the membership is private (only visible to org members)
    if (error.status === 404) {
      return false; // User is not a member
    } else if (error.status === 302) {
      // Membership is private, but user exists in org
      return true;
    }
    // For other errors, re-throw
    throw error;
  }
}

export async function enqueueSyncRepoPermissions({
  class_id,
  course_slug,
  org,
  repo,
  githubUsernames,
  debug_id
}: {
  class_id: number;
  course_slug: string;
  org: string;
  repo: string;
  githubUsernames: string[];
  debug_id?: string;
}) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data, error } = await adminSupabase.rpc("enqueue_github_sync_repo_permissions", {
    p_class_id: class_id,
    p_org: org,
    p_repo: repo,
    p_course_slug: course_slug,
    p_github_usernames: githubUsernames,
    p_debug_id: debug_id
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error("Failed to enqueue sync repo permissions");
  }
  return data;
}
export async function enqueueGithubArchiveRepo(class_id: number, org: string, repo: string, debug_id?: string) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data, error } = await adminSupabase.rpc("enqueue_github_archive_repo", {
    p_class_id: class_id,
    p_org: org,
    p_repo: repo,
    p_debug_id: debug_id
  });
  if (error) {
    Sentry.captureException(error);
    throw new Error("Failed to enqueue github archive repo");
  }
  return data;
}
