import { App, Octokit } from "https://esm.sh/octokit?dts";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
import { decode, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { Buffer } from "node:buffer";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
type FileListing = {
    name: string;
    path: string;
    size: number;
    sha: string;
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
    return installations.find((i) => i.orgName === repoName.split("/")[0])?.octokit!;
}
export async function resolveRef(action_repository: string, action_ref: string) {
    const octokit = await getOctoKit(action_repository);
    if (!octokit) {
        throw new Error("No octokit found");
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
        throw new Error("No octokit found");
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
    const supabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data, error: firstError } = await supabase.storage.from(
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
        const { error: saveGraderError } = await supabase.storage.from(
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
        const { data: secondAttempt, error: secondError } = await supabase
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
        throw new Error("No octokit found");
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
        throw new Error("No octokit found");
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
        throw new Error("No octokit found");
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
        throw new Error("No octokit found");
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
    return file;
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
