import { decode, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
import { throttling } from "https://esm.sh/@octokit/plugin-throttling";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { App, Endpoints, Octokit, RequestError } from "https://esm.sh/octokit?dts";

import { Buffer } from "node:buffer";
import { Database } from "./SupabaseTypes.d.ts";

import { createHash } from "node:crypto";
import { FileListing } from "./FunctionTypes.d.ts";
import { UserVisibleError } from "./HandlerUtils.ts";

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

async function getOctoKit(repoName: string) {
  if (installations.length === 0) {
    const _installations = await app.octokit.request("GET /app/installations");
    _installations.data.forEach((i) => {
      installations.push({
        orgName: i.account?.login || "",
        id: i.id,
        octokit: new MyOctokit({
          authStrategy: createAppAuth,
          auth: {
            appId: Deno.env.get("GITHUB_APP_ID") || -1,
            privateKey: Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "",
            installationId: i.id
          },
          throttle: {
            onRateLimit: (_retryAfter, options, _octokit, _retryCount) => {
              console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
              return true;
            },
            onSecondaryRateLimit: (_retryAfter, options, _octokit) => {
              octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
              return true;
            }
          }
        })
      });
    });
  }
  const ret = installations.find((i) => i.orgName === repoName.split("/")[0])?.octokit;
  if (ret) {
    return ret;
  }
  console.warn(`No octokit found for ${repoName}, using default: ${installations[0].orgName}`);
  return installations[0].octokit;
}
export async function resolveRef(action_repository: string, action_ref: string) {
  const octokit = await getOctoKit(action_repository);
  if (!octokit) {
    throw new Error(`Resolve ref failed: No octokit found for ${action_repository}`);
  }
  async function getRefOrUndefined(ref: string) {
    try {
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
export async function getRepoTarballURL(repo: string, sha?: string) {
  const octokit = await getOctoKit(repo);
  if (!octokit) {
    throw new Error(`Get repo tarball URL failed: No octokit found for ${repo}`);
  }
  let resolved_sha: string;
  if (sha) {
    resolved_sha = sha;
  } else {
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
export async function cloneRepository(repoName: string, ref: string) {
  const octokit = await getOctoKit(repoName);
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

export async function addPushWebhook(repoName: string, type: "grader_solution" | "template_repo") {
  const octokit = await getOctoKit(repoName);
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
export async function removePushWebhook(repoName: string, webhookId: number) {
  const octokit = await getOctoKit(repoName);
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
export async function getFileFromRepo(repoName: string, path: string) {
  console.log("getting file from repo", repoName, path);
  const octokit = await getOctoKit(repoName);
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
  const verified = await verify(token, key);
  return verified as GitHubOIDCToken;
}

export async function getRepos(org: string) {
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const repos = await octokit.paginate("GET /orgs/{org}/repos", {
    org,
    per_page: 100
  });
  return repos;
}

export async function createRepo(org: string, repoName: string, template_repo: string): string {
  console.log("Creating repo", org, repoName, template_repo);
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new UserVisibleError("No GitHub installation found for organization " + org);
  }
  console.log(`Found octokit for ${org}`);
  const owner = template_repo.split("/")[0];
  const repo = template_repo.split("/")[1];

  try {
    await octokit.request("POST /repos/{template_owner}/{template_repo}/generate", {
      template_repo: repo,
      template_owner: owner,
      owner: org,
      name: repoName,
      private: true
    });
    //Disable squash merging
    await octokit.request("PATCH /repos/{owner}/{repo}", {
      owner: org,
      repo: repoName,
      allow_squash_merge: false
    });
    //Get the head SHA
    const heads = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: org,
      repo: repoName
    });
    console.log(`Created repo ${org}/${repoName} with head SHA ${heads.data.object.sha}`);
    console.log(`Heads: ${JSON.stringify(heads.data)}`);
    return heads.data.object.sha;
  } catch (e) {
    if (e instanceof RequestError) {
      if (e.message.includes("Name already exists on this account")) {
        // continue
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
export async function listFilesInRepo(org: string, repo: string) {
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  return await listFilesInRepoDirectory(octokit, org, repo, "");
}

export async function archiveRepoAndLock(org: string, repo: string) {
  if (repo.includes("/")) {
    const [owner, repoName] = repo.split("/");
    org = owner;
    repo = repoName;
  }
  const octokit = await getOctoKit(org);
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

export async function syncStaffTeam(org: string, courseSlug: string, githubUsernames: string[]) {
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const team_slug = `${courseSlug}-staff`;
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
  let members: Endpoints["GET /orgs/{org}/teams/{team_id}/members"]["response"]["data"][] = [];
  try {
    const { data } = await octokit.request("GET /orgs/{org}/teams/{team_id}/members", {
      org,
      team_id,
      per_page: 100
    });
    members = data;
  } catch (e) {
    if (e instanceof RequestError && e.message.includes("Not Found")) {
      //This seems to happen when there are no members in the team?
      members = [];
    } else {
      throw e;
    }
  }

  const existingMembers = new Map(members.map((m) => [m.login, m]));
  const newMembers = githubUsernames.filter((u) => u && !existingMembers.has(u));
  const removeMembers = existingMembers.keys().filter((u) => u && !githubUsernames.includes(u));
  console.log(`Staff team: ${team_slug} intended members:`);
  console.log(githubUsernames.join(", "));
  for (const username of newMembers) {
    await octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug,
      username,
      role: "member"
    });
  }
  for (const username of removeMembers) {
    await octokit.request("DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug,
      username
    });
  }
}
const staffTeamCache = new Map<string, string[]>();
const orgMembershipCache = new Map<string, string[]>();
export async function syncRepoPermissions(org: string, repo: string, courseSlug: string, githubUsernames: string[]) {
  console.log("syncing repo permissions", org, repo, courseSlug, githubUsernames);
  if (repo.includes("/")) {
    const [owner, repoName] = repo.split("/");
    org = owner;
    repo = repoName;
  }
  const octokit = await getOctoKit(org);
  if (!octokit) {
    throw new Error("No octokit found for organization " + org);
  }
  const team_slug = `${courseSlug}-staff`;
  if (!staffTeamCache.has(courseSlug)) {
    const team = await octokit.request("GET /orgs/{org}/teams/{team_slug}/members", {
      org,
      team_slug
    });
    const staffGithubUsernames = team.data.map((m) => m.login);
    staffTeamCache.set(courseSlug, staffGithubUsernames);
    console.log("staff team", staffGithubUsernames);
  }
  const staffTeamUsernames = staffTeamCache.get(courseSlug) || [];
  if (!orgMembershipCache.has(org)) {
    const orgMembers = await octokit.request("GET /orgs/{org}/members", {
      org,
      per_page: 100
    });
    orgMembershipCache.set(
      org,
      orgMembers.data.map((m) => m.login)
    );
  }
  const orgMembers = orgMembershipCache.get(org) || [];
  console.log(`${org} org members: ${orgMembers.join(", ")}`);

  const existingInvitations = await octokit.request("GET /repos/{owner}/{repo}/invitations", {
    owner: org,
    repo,
    per_page: 100
  });
  //Find expired invitations and re-send
  const expiredInvitations = existingInvitations.data.filter((i) => i.expired);
  for (const invitation of expiredInvitations) {
    const invitee = invitation.invitee?.login;
    if (invitee) {
      console.log(`re-sending invitation for ${invitee}`);
      await octokit.request("DELETE /repos/{owner}/{repo}/invitations/{invitation_id}", {
        owner: org,
        repo,
        invitation_id: invitation.id
      });
      await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
        owner: org,
        repo,
        username: invitee,
        permission: "write"
      });
    }
  }

  const existingAccess = await octokit.request("GET /repos/{owner}/{repo}/collaborators", {
    owner: org,
    repo,
    per_page: 100
  });

  const existingUsernames = existingAccess.data.map((c) => c.login);
  console.log(`${org}/${repo} existing collaborators: ${existingUsernames.join(", ")}`);
  if (staffTeamUsernames.length && !existingUsernames.includes(staffTeamUsernames[0])) {
    await octokit.request("PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
      org,
      team_slug,
      owner: org,
      repo,
      permission: "maintain"
    });
  }
  const newAccess = githubUsernames.filter(
    (u) => !existingUsernames.includes(u) && !existingInvitations.data.some((i) => i.invitee?.login === u)
  );
  const removeAccess = existingUsernames.filter(
    (u) => !githubUsernames.includes(u) && !staffTeamUsernames.includes(u) && !orgMembers.includes(u)
  );
  for (const username of newAccess) {
    console.log(`adding collaborator ${username} to ${org}/${repo}`);
    await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
      owner: org,
      repo,
      username,
      permission: "write"
    });
  }
  for (const username of removeAccess) {
    console.log(`removing collaborator ${username} from ${org}/${repo}`);
    await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
      owner: org,
      repo,
      username
    });
  }
  console.log(`${org}/${repo} updated`);
}

export async function listCommits(
  repo_full_name: string,
  page: number
): Promise<{
  commits: ListCommitsResponse["data"];
  has_more: boolean;
}> {
  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org);
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

export async function triggerWorkflow(repo_full_name: string, sha: string, workflow_name: string) {
  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org);
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
export async function updateCheckRun(props: CheckRunUpdateProps) {
  const octokit = await getOctoKit(props.owner);
  if (!octokit) {
    throw new Error("No octokit found for organization " + props.owner);
  }
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", props);
}

export async function createCheckRun(repo_full_name: string, sha: string, details_url: string) {
  const [org, repo] = repo_full_name.split("/");
  const octokit = await getOctoKit(org);
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
  return res.data.id;
}
