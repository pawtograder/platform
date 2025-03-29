import { decode, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { App, Octokit, RequestError } from "https://esm.sh/octokit?dts";
import { Buffer } from "node:buffer";
import { Database } from "./SupabaseTypes.d.ts";

import { FileListing } from "./FunctionTypes.d.ts";
import { UserVisibleError } from "./HandlerUtils.ts";
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
        clientSecret: Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET") || "",
    },
    webhooks: {
        secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret",
    },
});
const installations: {
    orgName: string;
    id: number;
    octokit: Octokit;
}[] = [];
async function getOctoKit(repoName: string) {
    console.log("getting octokit for", repoName);
    if (installations.length === 0) {
        const _installations = await app.octokit.request(
            "GET /app/installations",
        );
        _installations.data.forEach((i) => {
            installations.push({
                orgName: i.account?.login || "",
                id: i.id,
                octokit: new Octokit({
                    authStrategy: createAppAuth,
                    auth: {
                        appId: Deno.env.get("GITHUB_APP_ID") || -1,
                        privateKey: Deno.env.get("GITHUB_PRIVATE_KEY_STRING") ||
                            "",
                        installationId: i.id,
                    },
                }),
            });
        });
    }
    const ret = installations.find((i) => i.orgName === repoName.split("/")[0])
        ?.octokit;
    if (ret) {
        return ret;
    }
    console.warn(
        `No octokit found for ${repoName}, using default: ${
            installations[0].orgName
        }`,
    );
    return installations[0].octokit;
}
export async function resolveRef(
    action_repository: string,
    action_ref: string,
) {
    const octokit = await getOctoKit(action_repository);
    if (!octokit) {
        throw new Error(
            `Resolve ref failed: No octokit found for ${action_repository}`,
        );
    }
    async function getRefOrUndefined(ref: string) {
        try {
            const heads = await octokit.request(
                "GET /repos/{owner}/{repo}/git/ref/{ref}",
                {
                    owner: action_repository.split("/")[0],
                    repo: action_repository.split("/")[1],
                    ref,
                },
            );
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
    throw new UserVisibleError(
        `Ref not found: ${action_ref} in ${action_repository}`,
    );
}
export async function getRepoTarballURL(repo: string, sha?: string) {
    const octokit = await getOctoKit(repo);
    if (!octokit) {
        throw new Error(
            `Get repo tarball URL failed: No octokit found for ${repo}`,
        );
    }
    let resolved_sha: string;
    if (sha) {
        resolved_sha = sha;
    } else {
        const head = await octokit.request(
            "GET /repos/{owner}/{repo}/git/ref/heads/main",
            {
                owner: repo.split("/")[0],
                repo: repo.split("/")[1],
            },
        );
        resolved_sha = head.data.object.sha;
    }
    //Check if the grader exists in supabase storage
    const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data, error: firstError } = await adminSupabase.storage.from(
        "graders",
    ).createSignedUrl(
        `${repo}/${sha}/archive.tgz`,
        60,
    );
    if (firstError) {
        //If the grader doesn't exist, create it
        const grader = await octokit.request(
            "GET /repos/{owner}/{repo}/tarball/{ref}",
            {
                owner: repo.split("/")[0],
                repo: repo.split("/")[1],
                ref: resolved_sha,
            },
        );
        //Upload the grader to supabase storage
        //TODO do some garbage collection in this bucket, especially for regression tests
        const { error: saveGraderError } = await adminSupabase.storage.from(
            "graders",
        ).upload(
            `${repo}/${sha}/archive.tgz`,
            grader.data as ArrayBuffer,
        );
        if (saveGraderError) {
            throw new Error(
                `Failed to save grader: ${saveGraderError.message}`,
            );
        }
        //Return the grader
        const { data: secondAttempt, error: secondError } = await adminSupabase
            .storage.from("graders").createSignedUrl(
                `${repo}/${sha}/archive.tgz`,
                60,
            );
        if (secondError || !secondAttempt) {
            throw new Error(
                `Failed to retrieve grader: ${secondError.message}`,
            );
        }
        return {
            download_link: secondAttempt.signedUrl,
            sha: resolved_sha,
        };
    } else {
        return {
            download_link: data.signedUrl,
            sha: resolved_sha,
        };
    }
}
export async function cloneRepository(repoName: string, ref: string) {
    const octokit = await getOctoKit(repoName);
    if (!octokit) {
        throw new Error(
            `Clone repository failed: No octokit found for ${repoName}`,
        );
    }
    const tarball = await octokit.request(
        "GET /repos/{owner}/{repo}/zipball/{ref}",
        {
            owner: repoName.split("/")[0],
            repo: repoName.split("/")[1],
            ref,
        },
    );
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
) {
    const octokit = await getOctoKit(repoName);
    if (!octokit) {
        throw new Error(
            `Add push webhook failed: No octokit found for ${repoName}`,
        );
    }
    const webhook = await octokit.request("POST /repos/{owner}/{repo}/hooks", {
        owner: repoName.split("/")[0],
        repo: repoName.split("/")[1],
        name: "web",
        config: {
            url: `${
                Deno.env.get("SUPABASE_URL")
            }/functions/github-repo-webhook?type=${type}`,
            content_type: "json",
            secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret",
        },
        events: ["push"],
    });
    console.log("webhook added", webhook.data);
}
export async function removePushWebhook(repoName: string, webhookId: number) {
    const octokit = await getOctoKit(repoName);
    if (!octokit) {
        throw new Error(
            `Remove push webhook failed: No octokit found for ${repoName}`,
        );
    }
    const webhook = await octokit.request(
        "DELETE /repos/{owner}/{repo}/hooks/{hook_id}",
        {
            owner: repoName.split("/")[0],
            repo: repoName.split("/")[1],
            hook_id: webhookId,
        },
    );
    console.log("webhook removed", webhook.data);
}
export async function getFileFromRepo(repoName: string, path: string) {
    console.log("getting file from repo", repoName, path);
    const octokit = await getOctoKit(repoName);
    if (!octokit) {
        throw new Error(
            `Get file from repo failed: No octokit found for ${repoName}`,
        );
    }
    console.log("octokit acquired");
    const file = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
            owner: repoName.split("/")[0],
            repo: repoName.split("/")[1],
            path,
        },
    );
    console.log("file acquired");
    return file.data;
}

async function getJwks() {
    const jwks = await fetch(
        "https://token.actions.githubusercontent.com/.well-known/jwks",
    );
    const jwksData = await jwks.json();
    return jwksData;
}

export async function validateOIDCToken(
    token: string,
): Promise<GitHubOIDCToken> {
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
            hash: "SHA-256",
        },
        true,
        ["verify"],
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
        per_page: 100,
    });
    return repos;
}

export async function createRepo(
    org: string,
    repoName: string,
    template_repo: string,
    github_username: string,
) {
    console.log("Creating repo", org, repoName, template_repo, github_username);
    const octokit = await getOctoKit(org);
    if (!octokit) {
        throw new UserVisibleError(
            "No GitHub installation found for organization " + org,
        );
    }
    console.log(`Found octokit for ${org}`);
    const owner = template_repo.split("/")[0];
    const repo = template_repo.split("/")[1];

    try {
        await octokit.request(
            "POST /repos/{template_owner}/{template_repo}/generate",
            {
                template_repo: repo,
                template_owner: owner,
                owner: org,
                name: repoName,
                private: true,
            },
        );
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
    //Disable squash merging
    await octokit.request("PATCH /repos/{owner}/{repo}", {
        owner: org,
        repo: repoName,
        allow_squash_merge: false,
    });
    //Add the user as an admin
    await octokit.request(
        "PUT /repos/{owner}/{repo}/collaborators/{username}",
        {
            owner: org,
            repo: repoName,
            username: github_username,
            permission: "maintain",
        },
    );
}
async function listFilesInRepoDirectory(
    octokit: Octokit,
    orgName: string,
    repoName: string,
    path: string,
): Promise<FileListing[]> {
    const files = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
            owner: orgName,
            repo: repoName,
            path,
            mediaType: {
                format: "raw",
            },
            per_page: 100,
        },
    );
    if (Array.isArray(files.data)) {
        const ret = await Promise.all(files.data.map(
            async (file): Promise<FileListing[]> => {
                if (file.type === "dir") {
                    return await listFilesInRepoDirectory(
                        octokit,
                        orgName,
                        repoName,
                        file.path,
                    );
                }
                if (file.type === "file") {
                    return [{
                        name: file.name,
                        path: file.path,
                        size: file.size,
                        sha: file.sha,
                    }];
                } else {
                    return [];
                }
            },
        ));
        return ret.flat();
    }
    throw new UserVisibleError(
        `Failed to list files in repo directory: not an array, in ${repoName} at ${path}`,
    );
}
export async function listFilesInRepo(org: string, repo: string) {
    const octokit = await getOctoKit(org);
    if (!octokit) {
        throw new Error("No octokit found for organization " + org);
    }
    return await listFilesInRepoDirectory(octokit, org, repo, "");
}
