import { App } from "@octokit/app";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";

import { Endpoints } from "@octokit/types";
import { createVerifier } from "fast-jwt";
import { readFileSync, writeFileSync } from "fs";
import buildGetJwks from "get-jwks";
import { Database } from "./SupabaseTypes.js";
import { createClient } from "@supabase/supabase-js";
import { AutograderFeedback } from "./api/AutograderController.js";
import { UserVisibleError } from "./InternalTypes.js";

type ListReposResponse = Endpoints["GET /orgs/{org}/repos"]["response"];

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
export function getGithubPrivateKey(): string {
    if (process.env.GITHUB_PRIVATE_KEY_STRING) {
        return process.env.GITHUB_PRIVATE_KEY_STRING;
    } else if (process.env.GITHUB_PRIVATE_KEY_FILE) {
        return readFileSync(process.env.GITHUB_PRIVATE_KEY_FILE, "utf8");
    } else {
        throw new Error("No github private key found");
    }
}
export default class GitHubController {
    private _app: App;
    private static _instance: GitHubController;
    private _installations: {
        orgName: string;
        id: number;
        octokit: Octokit;
    }[] = [];

    private getJwks = buildGetJwks({
        providerDiscovery: true,
        issuersWhitelist: ["https://token.actions.githubusercontent.com/"],
    });

    static initialize() {
        try {
            const app = new App({
                authStrategy: createAppAuth,
                appId: process.env.GITHUB_APP_ID || -1,
                privateKey: getGithubPrivateKey(),
                oauth: {
                    clientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
                    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
                },
                webhooks: {
                    secret: process.env.GITHUB_WEBHOOK_SECRET || "",
                },
            });
            this._instance = new GitHubController(app);
            return app;
        } catch (e) {
            console.error(e);
            console.error(
                "Failed to initialize GitHubController - No GitHub features will be available. To fix: create a new GitHub App and set the environment variables in the .env file.",
            );
            return null;
        }
    }
    static async initializeApp() {
        const app = GitHubController._instance;
        if (app) {
            await app.initializeApp();
        }
    }
    static getInstance(): GitHubController {
        return this._instance;
    }
    constructor(app: App) {
        this._app = app;
        app.oauth.on("token.created", async (token) => {
            console.log("Token created", token);
            // Get the user's profile from github
            // const { data } = await app.octokit.request('GET /user', {
            //   headers: {
            //     authorization: `token ${token.token}`
            //   jwt
            // });
            // console.log('User:', data);
            // appendFileSync('tokens.txt', `${token.token}\n`);
        });
        app.oauth.on("token", async (token) => {
            console.log("Token", token);
            // Get the user's profile from github
            const { data } = await token.octokit.request("GET /user");
            console.log("User:", data);
        });
    }

    async getFileFromRepo(repoName: string, path: string) {
        const octokit = this._installations[0].octokit;
        const file = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
                owner: repoName.split("/")[0],
                repo: repoName.split("/")[1],
                path,
            },
        );
        return file.data;
    }

    async listFilesInRepoDirectory(
        repoName: string,
        path: string,
    ): Promise<FileListing[]> {
        const octokit = this._installations[0].octokit;
        const files = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
                owner: repoName.split("/")[0],
                repo: repoName.split("/")[1],
                path,
                mediaType: {
                    format: "raw",
                },
            },
        );
        if (Array.isArray(files.data)) {
            const ret = await Promise.all(files.data.map(
                async (file): Promise<FileListing[]> => {
                    if (file.type === "dir") {
                        return await this.listFilesInRepoDirectory(
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
    async listFilesInRepo(repoName: string) {
        return this.listFilesInRepoDirectory(repoName, "");
    }
    async completeCheckRun(
        submission: Database["public"]["Tables"]["submissions"]["Row"],
        feedback: AutograderFeedback,
    ) {
        const octokit = this._installations[0].octokit;
        let conclusion:
            | "success"
            | "action_required"
            | "neutral"
            | "cancelled"
            | "failure"
            | "skipped"
            | "stale"
            | "timed_out"
            | undefined;
        let score = feedback.score ||
            feedback.tests.reduce((acc, test) => acc + (test.score || 0), 0);
        let max_score = feedback.max_score ||
            feedback.tests.reduce(
                (acc, test) => acc + (test.max_score || 0),
                0,
            );
        if (score === max_score) {
            conclusion = "success";
        } else if (score === 0) {
            conclusion = "action_required";
        } else {
            conclusion = "action_required";
        }
        await octokit.request(
            "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
            {
                owner: submission.repository.split("/")[0],
                repo: submission.repository.split("/")[1],
                check_run_id: submission.check_run_id!,
                status: "completed",
                conclusion,
                output: {
                    title: "PawtoGrader",
                    summary:
                        `Grading script completed, ${feedback.score}/${feedback.max_score}`,
                    text:
                        `View the complete results at [${process.env.PAWTOGRADER_WEBAPP_URL}/course/${submission.class_id}/assignment/${submission.assignment_id}/submission/${submission.id}](${process.env.PAWTOGRADER_WEBAPP_URL}/course/${submission.class_id}/assignment/${submission.assignment_id}/submission/${submission.id})
${feedback.output.visible?.output}`,
                },
            },
        );
    }

    async createCheckRun(
        repository: string,
        sha: string,
        workflow_ref: string,
    ): Promise<number> {
        const octokit = this._installations[0].octokit;
        const checkRun = await octokit.request(
            "POST /repos/{owner}/{repo}/check-runs",
            {
                owner: repository.split("/")[0],
                repo: repository.split("/")[1],
                head_sha: sha,
                name: "PawtoGrader",
                status: "in_progress",
                output: {
                    title: "PawtoGrader",
                    summary: "PawtoGrader is running...",
                },
            },
        );
        return checkRun.data.id;
    }

    async getRepoTarballURL(
        repo: string,
        sha?: string,
    ): Promise<{ download_link: string; sha: string }> {
        const octokit = this._installations[0].octokit;
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
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
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

    /**
     * Clones a student's repository, ensuring that the repository is cloned with the correct SHA
     * @param repository
     * @param sha
     * @param workDir
     */
    async cloneRepository(
        repository: string,
        sha: string,
        workDir: string,
    ): Promise<Buffer> {
        const octokit = this._installations[0].octokit;
        const tarball = await octokit.request(
            "GET /repos/{owner}/{repo}/zipball/{ref}",
            {
                owner: repository.split("/")[0],
                repo: repository.split("/")[1],
                ref: sha,
            },
        );
        //Extract the tarball
        if (tarball.data) {
            return Buffer.from(tarball.data as ArrayBuffer);
        } else {
            throw new Error("Failed to fetch tarball");
        }
    }

    async validateOIDCToken(token: string): Promise<GitHubOIDCToken> {
        const getJwks = this.getJwks;
        const validator = createVerifier({
            key: async (header: any) => {
                const publicKey = await getJwks.getPublicKey({
                    kid: header.header.kid,
                    alg: header.header.alg,
                    domain: "https://token.actions.githubusercontent.com/",
                });
                return publicKey;
            },
        });
        const payload = await validator(token);
        if (!payload) {
            throw new Error("Invalid token");
        }
        return payload;
    }
    async initializeApp() {
        if (!this._app) {
            console.error(
                "GitHubController not initialized, skipping installation retrieval",
            );
            return;
        }
        const installations = await this._app.octokit.request(
            "GET /app/installations",
        );
        for (let installation of installations.data) {
            this._installations.push({
                orgName: installation.account?.login || "",
                id: installation.id,
                octokit: new Octokit({
                    authStrategy: createAppAuth,
                    auth: {
                        appId: process.env.GITHUB_APP_ID,
                        privateKey: getGithubPrivateKey(),
                        installationId: installation.id,
                    },
                }),
            });
        }
    }

    async createRepo(
        org: string,
        repoName: string,
        template_repo: string,
        github_username: string,
    ) {
        console.log("Creating repo", org, repoName, template_repo, github_username);
        const octokit = this._installations[0].octokit;
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
    async getRepos(
        course: Database["public"]["Tables"]["classes"]["Row"],
    ): Promise<ListReposResponse["data"]> {
        //TODO: Have different orgs for different courses

        const octokit = this._installations[0].octokit;
        const repos = await octokit.request("GET /orgs/{org}/repos", {
            org: "pawtograder",
        });

        return repos.data;
    }
    async resolveRef(action_repository: string, action_ref: string) {
        const octokit = this._installations[0].octokit;
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
}
