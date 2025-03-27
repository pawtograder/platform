import { App, Octokit } from "https://esm.sh/octokit?dts";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
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
    if(installations.length === 0) {
        const _installations = await app.octokit.request("GET /app/installations");
        _installations.data.forEach(i => {
            installations.push({
                orgName: i.account?.login || "",
                id: i.id,
                octokit: new Octokit({
                    authStrategy: createAppAuth,
                    auth: {
                        appId: Deno.env.get("GITHUB_APP_ID") || -1,
                        privateKey: Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "",
                        installationId: i.id,
                    },
                }),
            });
        });
    }
    return installations[0].octokit;
}


export async function addPushWebhook(repoName: string, type: 'grader_solution' | 'template_repo') {
    const octokit = await getOctoKit(repoName);
    if(!octokit) {
        throw new Error("No octokit found");
    }
    const webhook = await octokit.request("POST /repos/{owner}/{repo}/hooks", {
        owner: repoName.split("/")[0],
        repo: repoName.split("/")[1], 
        name: "web",
        config: {
            url: `${Deno.env.get("SUPABASE_URL")}/functions/github-repo-webhook?type=${type}`,
            content_type: "json",
            secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret",
        },
        events: ["push"],
    });
    console.log('webhook added', webhook.data);
}
export async function removePushWebhook(repoName: string, webhookId: number) {
    const octokit = await getOctoKit(repoName);
    if(!octokit) {
        throw new Error("No octokit found");
    }
    const webhook = await octokit.request("DELETE /repos/{owner}/{repo}/hooks/{hook_id}", {
        owner: repoName.split("/")[0],
        repo: repoName.split("/")[1],
        hook_id: webhookId,
    });
    console.log('webhook removed', webhook.data);
}
export async function getFileFromRepo(repoName: string, path: string) {
    console.log('getting file from repo', repoName, path);
    const octokit = await getOctoKit(repoName);
    if(!octokit) {
        throw new Error("No octokit found");
    }
    console.log('octokit acquired');
    const file = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: repoName.split("/")[0],
        repo: repoName.split("/")[1],
        path,
    });
    console.log('file acquired');
    return file;
}