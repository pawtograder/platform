import { decode, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
import { throttling } from "https://esm.sh/@octokit/plugin-throttling";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import { Redis } from "https://esm.sh/ioredis?target=deno";
import { App, Endpoints, Octokit, RequestError } from "https://esm.sh/octokit?dts";
import * as Sentry from "npm:@sentry/deno";

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

      // Check if this is a 404 error that we should retry
      const is404 = error instanceof RequestError && error.status === 404;

      if (!is404 || attempt === maxRetries) {
        // Don't retry for non-404 errors or if we've exhausted retries
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
              error_type: is404 ? "404_not_found" : "other"
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
        error_status: 404,
        operation: "github_api_retry"
      });

      Sentry.addBreadcrumb({
        message: `GitHub API 404 error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
        level: "warning",
        data: {
          attempt: attempt + 1,
          delay_ms: delayMs,
          error_status: 404,
          error_message: error instanceof Error ? error.message : String(error)
        }
      });

      console.log(
        `GitHub API 404 error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1}):`,
        error instanceof Error ? error.message : String(error)
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError!;
}

export type ListCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"];
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

export async function getOctoKit(repoOrOrgName: string, scope?: Sentry.Scope) {
  const org = repoOrOrgName.includes("/") ? repoOrOrgName.split("/")[0] : repoOrOrgName;
  scope?.addBreadcrumb({
    message: `Getting Octokit for ${org}`,
    category: "github",
    level: "info"
  });
  if (installations.length === 0) {
    let connection: Bottleneck.IORedisConnection | undefined;
    if (Deno.env.get("UPSTASH_REDIS_REST_URL") && Deno.env.get("UPSTASH_REDIS_REST_TOKEN")) {
      const host = Deno.env.get("UPSTASH_REDIS_REST_URL")?.replace("https://", "");
      const password = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
      connection = new Bottleneck({
        datastore: "ioredis",
        clearDatastore: false,
        id: "gitHubRateLimiter" + (Deno.env.get("GITHUB_APP_ID") || ""),
        clientOptions: {
          host,
          password,
          username: "default",
          tls: {},
          port: 6379
        },
        Redis
      });
      connection.on("error", (err: Error) => console.error(err));
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
  //Check if the grader exists in supabase storage
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data, error: firstError } = await adminSupabase.storage
    .from("graders")
    .createSignedUrl(`${repo}/${resolved_sha}/archive.tgz`, 60);
  if (firstError) {
    //If the grader doesn't exist, create it
    const grader = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner: repo.split("/")[0],
      repo: repo.split("/")[1],
      ref: resolved_sha
    });
    //Upload the grader to supabase storage
    //TODO do some garbage collection in this bucket, especially for regression tests
    const { error: saveGraderError } = await adminSupabase.storage
      .from("graders")
      .upload(`${repo}/${resolved_sha}/archive.tgz`, grader.data as ArrayBuffer);
    if (saveGraderError) {
      if (saveGraderError.message === "The resource already exists") {
        //This is fine, just continue
      } else {
        throw new Error(`Failed to save grader: ${saveGraderError.message}`);
      }
    }
    //Return the grader
    const { data: secondAttempt, error: secondError } = await adminSupabase.storage
      .from("graders")
      .createSignedUrl(`${repo}/${resolved_sha}/archive.tgz`, 60);
    if (secondError || !secondAttempt) {
      throw new Error(`Failed to retrieve grader: ${secondError.message}`);
    }
    return {
      download_link: secondAttempt.signedUrl,
      sha: resolved_sha
    };
  } else {
    return {
      download_link: data.signedUrl,
      sha: resolved_sha
    };
  }
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
    return { content };
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
    const resp = await octokit.request("POST /repos/{template_owner}/{template_repo}/generate", {
      template_repo: repo,
      template_owner: owner,
      owner: org,
      name: repoName,
      private: true
    });
    console.log(JSON.stringify(resp.headers, null, 2));
    scope?.setTag("github_operation", "create_repo_request_done");
    //Disable squash merging, make template
    scope?.setTag("github_operation", "patch_repo_settings");
    await retryWithBackoff(
      () =>
        octokit.request("PATCH /repos/{owner}/{repo}", {
          owner: org,
          repo: repoName,
          allow_squash_merge: false,
          is_template: is_template_repo ? true : false
        }),
      3, // maxRetries
      1000, // baseDelayMs
      scope
    );
    //Get the head SHA
    scope?.setTag("github_operation", "get_head_sha");
    scope?.setTag("ref", "heads/main");
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
    return heads.data.object.sha as string;
  } catch (e) {
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
        return heads.data.object.sha as string;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
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
  const collaborators = await octokit.request("GET /repos/{owner}/{repo}/collaborators", {
    owner: org,
    repo,
    per_page: 100
  });
  for (const collaborator of collaborators.data) {
    console.log("removing collaborator", collaborator.login);
    await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
      owner: org,
      repo,
      username: collaborator.login
    });
  }

  const newName = `archived-${new Date().toISOString()}-${repo}`;
  console.log("renaming repo to", newName);
  //Rename the repo
  await octokit.request("PATCH /repos/{owner}/{repo}", {
    owner: org,
    repo,
    name: newName
  });
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

  try {
    const resp = await octokit.request("POST /orgs/{org}/invitations", {
      org,
      role: "direct_member",
      invitee_id: userID,
      team_ids: [teamID]
    });
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
      response?: { data?: { errors?: Array<{ message?: unknown }> } };
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
    if (/already.*(part|member).*organization/i.test(combinedMessage)) {
      scope?.addBreadcrumb({
        category: "github",
        message: `User ${githubUsername} appears to already be in org ${org}; adding to team ${team_slug}`,
        level: "info"
      });
      await updateUserRolesForGithubOrg({ github_username: githubUsername, org });
      //Update our user_role to mark that they are in the org!
      await octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
        org,
        team_slug,
        username: githubUsername,
        role: "member"
      });
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
  const existingAccess = await octokit.paginate("GET /repos/{owner}/{repo}/collaborators", {
    owner: org,
    repo,
    per_page: 100
  });
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
  const newAccess = githubUsernames.filter(
    (u) => !existingUsernames.includes(u) && allOrgMembers?.includes(u) // && !existingInvitations.some((i) => i.invitee?.login === u)
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
async function updateUserRolesForGithubOrg({ github_username, org }: { github_username: string; org: string }) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  // First, find the user by github_username
  const { data: userData, error: userError } = await adminSupabase
    .from("users")
    .select("*")
    .eq("github_username", github_username)
    .single();

  if (userError) {
    throw new Error(`Error finding user with github_username ${github_username}: ${userError.message}`);
  }

  if (!userData) {
    throw new Error(`User with github_username ${github_username} not found`);
  }

  // Find all classes with the specified GitHub org
  const { data: classes } = await adminSupabase.from("classes").select("id").eq("github_org", org);

  if (!classes || classes.length === 0) {
    throw new Error(`No classes found with GitHub org ${org}`);
  }

  const classIds = classes.map((c) => c.id);

  // Update user_roles for this user in all classes with the specified org
  for (const classId of classIds) {
    const { error: updateError } = await adminSupabase
      .from("user_roles")
      .update({ github_org_confirmed: true })
      .eq("user_id", userData.user_id)
      .eq("class_id", classId)
      .select();
    if (updateError) {
      throw new Error(`Failed to update user roles for class ${classId}: ${updateError.message}`);
    }
  }

  console.log(`Updated user roles for ${github_username} in classes with org ${org}`);
  return;
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
  const next_page = page_links
    ?.split(",")
    .find((l) => l.includes("next"))
    ?.split(";")[0]
    .split("=")[1];
  return {
    commits: commits.data,
    has_more: next_page !== null
  };
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
    },
    actions: [
      {
        label: "Submit",
        description: "Creates a submission for this commit",
        identifier: "submit"
      }
    ]
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
