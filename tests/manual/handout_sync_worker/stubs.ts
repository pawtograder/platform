/**
 * The GitHub side of the WP5 scratch tests: `file://` remotes and a REST stub for the calls the
 * git path makes, answered from those remotes. Test-only; used by `harness.ts` (the worker as a
 * child process) and by `backstop.scratch.test.ts` (in-process).
 */
import type { GitSyncDeps, GitSyncOctokit } from "../../../supabase/functions/_shared/gitSync/syncEntry.ts";
import type { RemoteConfig } from "../../../supabase/functions/_shared/gitSync/runGit.ts";

export function harnessRemote(fixtureRoot: string): RemoteConfig {
  return { protocol: "file", remoteUrlFor: (name) => `file://${fixtureRoot}/remotes/${name}.git` };
}

/**
 * Stubbed REST and database edges of `syncRepositoryToHandoutGit`. Tokens and REST calls are
 * logged to `ctrl/tokens.jsonl` and `ctrl/rest.jsonl`, pull requests persist in `ctrl/prs.json`,
 * and every git call runs through `ctrl/git-wrapper.sh`.
 */
export function harnessGitDeps(fixtureRoot: string, ctrl: string): Partial<GitSyncDeps> {
  const remotesDir = `${fixtureRoot}/remotes`;

  /** Appends one JSON line to a control-dir log the test reads back. */
  async function record(file: string, value: unknown): Promise<void> {
    await Deno.writeTextFile(`${ctrl}/${file}`, JSON.stringify(value) + "\n", { append: true });
  }

  async function git(args: string[]): Promise<string> {
    const out = await new Deno.Command("/usr/bin/git", {
      args,
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin", HOME: "/", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "piped",
      stderr: "piped"
    }).output();
    if (!out.success) throw new Error(`harness git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
    return new TextDecoder().decode(out.stdout).trim();
  }

  interface StubPr {
    number: number;
    html_url: string;
    state: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
    head: { sha: string; ref: string };
    repo: string;
  }

  /** Pull requests persist in the control dir, so a worker restarted mid-test sees the same ones. */
  async function loadPrs(): Promise<StubPr[]> {
    try {
      return JSON.parse(await Deno.readTextFile(`${ctrl}/prs.json`));
    } catch {
      return [];
    }
  }
  async function savePrs(prs: StubPr[]): Promise<void> {
    await Deno.writeTextFile(`${ctrl}/prs.json`, JSON.stringify(prs));
  }

  /** The GitHub REST calls `syncRepositoryToHandoutGit` makes, answered from the `file://` remotes. */
  function stubOctokit(token: string): GitSyncOctokit {
    const request = async (route: string, params: Record<string, unknown> = {}) => {
      await record("rest.jsonl", { token, route, params });
      const fullName = `${params.owner}/${params.repo}`;
      const gitDir = `${remotesDir}/${fullName}.git`;
      switch (route) {
        case "GET /repos/{owner}/{repo}":
          return { data: { size: 1 } };
        case "GET /users/{username}":
          return { data: { id: 4242, login: params.username } };
        case "GET /repos/{owner}/{repo}/compare/{basehead}":
          return { data: { total_commits: 0, commits: [] } };
        case "GET /repos/{owner}/{repo}/pulls": {
          const branch = String(params.head).split(":")[1];
          return { data: (await loadPrs()).filter((p) => p.repo === fullName && p.head.ref === branch).reverse() };
        }
        case "POST /repos/{owner}/{repo}/pulls": {
          const prs = await loadPrs();
          const branch = String(params.head);
          const sha = await git(["--git-dir", gitDir, "rev-parse", `refs/heads/${branch}`]);
          const pr: StubPr = {
            number: prs.length + 1,
            html_url: `https://github.invalid/${fullName}/pull/${prs.length + 1}`,
            state: "open",
            merged_at: null,
            merge_commit_sha: null,
            head: { sha, ref: branch },
            repo: fullName
          };
          prs.push(pr);
          await savePrs(prs);
          return { data: pr };
        }
        case "PATCH /repos/{owner}/{repo}/pulls/{pull_number}":
          return { data: {} };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
          return { data: { mergeable: true } };
        case "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": {
          // A fast-forward stands in for GitHub's merge: the sync commit's parent is `S`, which is
          // `main` in these fixtures.
          const prs = await loadPrs();
          const pr = prs.find((p) => p.repo === fullName && p.number === params.pull_number)!;
          await git(["--git-dir", gitDir, "update-ref", "refs/heads/main", String(params.sha)]);
          pr.state = "closed";
          pr.merged_at = new Date().toISOString();
          pr.merge_commit_sha = String(params.sha);
          await savePrs(prs);
          return { data: { sha: params.sha, merged: true } };
        }
        case "DELETE /repos/{owner}/{repo}/git/refs/{ref}":
          return { data: {} };
        default:
          throw new Error(`harness: unexpected GitHub request ${route}`);
      }
    };
    return { request } as unknown as GitSyncOctokit;
  }

  let tokenCounter = 0;
  return {
    getScopedToken: async (org, repositories, permissions) => {
      const token = `ghs_harness${++tokenCounter}x${crypto.randomUUID().replaceAll("-", "")}`;
      await record("tokens.jsonl", { org, repositories, permissions, token });
      return { token, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
    octokitForToken: (token) => stubOctokit(token),
    appSlug: () => Promise.resolve("pawtograder-test"),
    syncLimiter: () => ({ schedule: (fn) => fn() }),
    contentLimiter: () => ({ schedule: (fn) => fn() }),
    sleep: () => Promise.resolve(),
    captureException: (error) => console.error("harness captureException:", error),
    // Every git call goes through the wrapper the test wrote, which can stall a push on demand.
    engineContext: { testOnly: { git: { gitBinary: `${ctrl}/git-wrapper.sh` } } }
  };
}
