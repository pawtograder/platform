/**
 * Contract tests for `syncRepositoryToHandoutGit` (docs/handout-sync-git-worker.md §4, §5.9, §7,
 * §8.2-§8.4; build plan WP3).
 *
 * Git is real: every case builds `file://` remotes with `testFixtures.ts` and runs the engine
 * against them. Only the REST edges are stubbed: the token, repo sizes, the bot account, the
 * branch-safety compare and the pull request calls, through one fake `request`. Each case produces
 * one `SyncResult` shape the handler in `github-async-worker` branches on.
 *
 * Run from supabase/functions with a Deno that can spawn git:
 *   deno test --no-check --allow-all _shared/gitSync/syncEntry.test.ts
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";
import type { SyncResult } from "../GitHubSyncHelpers.ts";
import type { GitSyncDeps, SolutionRepos, SyncRepositoryToHandoutGitParams } from "./syncEntry.ts";
import { withSyncJob } from "./engine.ts";
import { TemplateCache } from "./templateCache.ts";
import { binary, GitFixture, R, shouldSkipRealGit, type Snapshot, T, text, world, type World } from "./testFixtures.ts";

// GitHubWrapper, which syncEntry imports, builds a GitHub App at import time and needs a non-empty
// private key. Nothing here authenticates. A static import would hoist above this line.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const {
  DEFAULT_MAX_REPO_KIB,
  handoutSyncEngineFor,
  planRepositoryToHandoutGit,
  REDELIVERY_KINDS,
  SHADOW_STUDENT_TOKEN_PERMISSIONS,
  resetBotIdentityForTesting,
  SYNC_TOKEN_PERMISSIONS,
  syncRepositoryToHandoutGit,
  TEMPLATE_TOKEN_PERMISSIONS
} = await import("./syncEntry.ts");
const { renderSyncPullRequestBody, syncPullRequestTitle } = await import("../GitHubSyncHelpers.ts");
const { requestScopedInstallationToken, getScopedInstallationToken } = await import("../GitHubWrapper.ts");

const SKIP = await shouldSkipRealGit("syncEntry.test.ts");

function gitTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: SKIP, sanitizeResources: false, sanitizeOps: false, fn });
}

/** The student token: the student repo, with write. */
const TOKEN = "ghs_testtoken0123456789";
/** The template token: the template repo, read only, from the template org's installation. */
const TEMPLATE_TOKEN = "ghs_templatetoken9876543210";
const APP_SLUG = "pawtograder-test";
const BOT_ID = 4242;
const MERGE_SHA = "c0ffee0000000000000000000000000000000001";

// ---------------------------------------------------------------------------------------------
// The REST stub
// ---------------------------------------------------------------------------------------------

interface FakePr {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string };
  body?: string;
}

type Call = { route: string; params: Record<string, unknown>; token?: string };

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * The GitHub REST API as far as the git path calls it. Reads the student's fixture remote for
 * branch heads, so a PR's head is the commit the engine really pushed. Any other route throws,
 * which is how a test notices a call the contract does not allow (such as re-reading the branch).
 *
 * It also enforces token scope the way GitHub does: the student token reaches only the student
 * repo and the template token only the template repo, so a call made with the wrong one fails.
 */
class FakeGitHub {
  calls: Call[] = [];
  sizes = new Map<string, number>();
  pulls: FakePr[] = [];
  mergeable = true;
  /** The commits `GET compare` reports, keyed by nothing: one answer per test. */
  compareCommits: unknown[] = [];
  /** Runs when a single PR is read, before the answer is built. Lets a test move the branch. */
  onGetPull?: (pr: FakePr) => Promise<void>;
  /** Overrides `total_commits` in the compare answer, to model GitHub's 250-commit cap. */
  compareTotal?: number;
  /** Every PR create answers "No commits between", with no merged PR to explain it. */
  noCommitsBetween = false;
  /** The PR list fails with a 502. */
  failList = false;
  /** The next N PR lists answer empty, as if a concurrent job's PR were not visible yet. */
  hiddenLists = 0;

  constructor(
    private readonly w: World,
    private readonly timeline: string[]
  ) {}

  request = async (route: string, params: Record<string, unknown>, token?: string): Promise<{ data: unknown }> => {
    this.calls.push({ route, params, token });
    this.timeline.push(`rest ${route}`);
    const full = `${params.owner}/${params.repo}`;
    if (params.owner !== undefined) {
      const reachable =
        token === TOKEN ? this.w.input.repoFullName : token === TEMPLATE_TOKEN ? this.w.input.templateRepo : "";
      if (full !== reachable) throw httpError(404, `Not Found (token cannot see ${full})`);
    }
    switch (route) {
      case "GET /repos/{owner}/{repo}":
        return { data: { size: this.sizes.get(full) ?? 100 } };
      case "GET /users/{username}":
        return { data: { id: BOT_ID, login: params.username, type: "Bot" } };
      case "GET /repos/{owner}/{repo}/compare/{basehead}":
        return {
          data: { total_commits: this.compareTotal ?? this.compareCommits.length, commits: this.compareCommits }
        };
      case "GET /repos/{owner}/{repo}/pulls": {
        if (this.failList) throw httpError(502, "Bad Gateway");
        if (this.hiddenLists > 0) {
          this.hiddenLists--;
          return { data: [] };
        }
        const branch = String(params.head).split(":")[1];
        await this.followBranches();
        return {
          data: this.pulls
            .filter((p) => p.head.ref === branch)
            .slice()
            .reverse()
        };
      }
      case "POST /repos/{owner}/{repo}/pulls": {
        const branch = String(params.head);
        const head = await this.w.student.ref(`refs/heads/${branch}`);
        if (!head) throw httpError(422, "Validation Failed: head does not exist");
        if (this.noCommitsBetween) throw httpError(422, `Validation Failed: No commits between main and ${branch}`);
        if (this.pulls.some((p) => p.head.ref === branch && p.state === "open")) {
          throw httpError(422, `Validation Failed: A pull request already exists for ${params.owner}:${branch}.`);
        }
        // What GitHub says once the branch's commit is already in main, as after a merge.
        if (this.pulls.some((p) => p.head.ref === branch && p.merged_at !== null && p.head.sha === head)) {
          throw httpError(422, `Validation Failed: No commits between main and ${branch}`);
        }
        const pr: FakePr = {
          number: 100 + this.pulls.length,
          html_url: `https://github.com/${full}/pull/${100 + this.pulls.length}`,
          state: "open",
          merged_at: null,
          merge_commit_sha: null,
          head: { sha: head, ref: branch },
          body: String(params.body)
        };
        this.pulls.push(pr);
        return { data: { number: pr.number, html_url: pr.html_url } };
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        const pr = this.pulls.find((p) => p.number === params.pull_number)!;
        await this.followBranches();
        await this.onGetPull?.(pr);
        return { data: { number: pr.number, mergeable: this.mergeable, head: { sha: pr.head.sha } } };
      }
      case "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": {
        const pr = this.pulls.find((p) => p.number === params.pull_number)!;
        if (params.sha !== pr.head.sha) throw httpError(409, "Head branch was modified");
        Object.assign(pr, { state: "closed", merged_at: "2026-11-02T00:00:00Z", merge_commit_sha: MERGE_SHA });
        return { data: { sha: MERGE_SHA, merged: true } };
      }
      case "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": {
        const pr = this.pulls.find((p) => p.number === params.pull_number)!;
        pr.body = String(params.body);
        return { data: { number: pr.number } };
      }
      case "DELETE /repos/{owner}/{repo}/git/refs/{ref}":
        return { data: null };
      default:
        throw new Error(`unexpected route in test: ${route}`);
    }
  };

  routes(): string[] {
    return this.calls.map((c) => c.route);
  }

  /** An open PR's head follows its branch, as on GitHub. */
  private async followBranches(): Promise<void> {
    for (const pr of this.pulls) {
      if (pr.state !== "open") continue;
      const head = await this.w.student.ref(`refs/heads/${pr.head.ref}`);
      if (head) pr.head.sha = head;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Harness {
  gh: FakeGitHub;
  deps: GitSyncDeps;
  timeline: string[];
  tokenRequests: Array<{ org: string; repositories: string[]; permissions: unknown }>;
  octokitTokens: string[];
  /** Git spawns that happened while a limiter was held. Must stay empty. */
  spawnsUnderLimiter: string[][];
  captured: unknown[];
  run: (overrides?: Partial<SyncRepositoryToHandoutGitParams>) => Promise<SyncResult>;
}

function harness(
  w: World,
  opts: { solution?: SolutionRepos; maxRepoKib?: number; gitBinary?: string; cache?: TemplateCache } = {}
): Harness {
  resetBotIdentityForTesting();
  const timeline: string[] = [];
  const gh = new FakeGitHub(w, timeline);
  const tokenRequests: Harness["tokenRequests"] = [];
  const octokitTokens: string[] = [];
  const spawnsUnderLimiter: string[][] = [];
  const captured: unknown[] = [];
  const held = { sync: 0, content: 0 };
  const limiter = (name: "sync" | "content") => ({
    schedule: async <X>(fn: () => Promise<X>): Promise<X> => {
      held[name]++;
      timeline.push(`${name}:start`);
      try {
        return await fn();
      } finally {
        held[name]--;
        timeline.push(`${name}:end`);
      }
    }
  });
  const cache = opts.cache ?? new TemplateCache(w.fx.templatesDir);
  const deps: GitSyncDeps = {
    runtime: () => ({
      jobsDir: w.fx.jobsDir,
      templateCache: cache,
      remote: w.fx.remote(),
      maxRepoKib: opts.maxRepoKib ?? DEFAULT_MAX_REPO_KIB
    }),
    getScopedToken: (org, repositories, permissions) => {
      timeline.push("token");
      tokenRequests.push({ org, repositories: [...repositories], permissions });
      // Read-only means the template request; everything else is the student's.
      const token = permissions.contents === "read" && !permissions.pull_requests ? TEMPLATE_TOKEN : TOKEN;
      return Promise.resolve({ token, expiresAt: "2026-11-02T01:00:00Z" });
    },
    octokitForToken: (token) => {
      octokitTokens.push(token);
      const octokit = { request: (route: string, params: Record<string, unknown>) => gh.request(route, params, token) };
      return octokit as unknown as ReturnType<GitSyncDeps["octokitForToken"]>;
    },
    appSlug: () => Promise.resolve(APP_SLUG),
    loadSolutionRepos: () =>
      Promise.resolve(opts.solution ?? { graderRepo: "org/grader", solutionTemplateRepo: "org/solution-template" }),
    syncLimiter: () => limiter("sync"),
    contentLimiter: () => limiter("content"),
    sleep: () => Promise.resolve(),
    captureException: (e) => {
      captured.push(e);
    },
    engineContext: {
      log: () => {},
      gitLog: () => {},
      testOnly: {
        git: {
          gitBinary: opts.gitBinary,
          onSpawn: (argv) => {
            timeline.push("git");
            if (argv.includes("push")) timeline.push("git push");
            if (held.sync > 0 || held.content > 0) spawnsUnderLimiter.push([...argv]);
          }
        }
      }
    }
  };
  const run = (overrides: Partial<SyncRepositoryToHandoutGitParams> = {}) =>
    syncRepositoryToHandoutGit(
      {
        repositoryFullName: w.input.repoFullName,
        templateRepo: w.input.templateRepo,
        fromSha: w.F,
        toSha: w.H,
        syncedRepoSha: w.S,
        // Never touched: every database read goes through `loadSolutionRepos`, stubbed above.
        adminSupabase: {} as SyncRepositoryToHandoutGitParams["adminSupabase"],
        autoMerge: true,
        waitBeforeMerge: 0,
        repositoryId: 1,
        retryCount: 0,
        jobId: "123",
        ...overrides
      },
      deps
    );
  return { gh, deps, timeline, tokenRequests, octokitTokens, spawnsUnderLimiter, captured, run };
}

const branchFor = (w: World) => `sync-to-${w.H.substring(0, 7)}`;

/** A clean update: the handout edits one file and adds one, and the student touched neither. */
async function cleanWorld(fx: GitFixture): Promise<World> {
  return await world(fx, {
    before: { "a.txt": "one\n", "README.md": "readme\n" },
    after: { "a.txt": "two\n", "README.md": "readme\n", "img.bin": new Uint8Array([0, 1, 2, 3]) }
  });
}

/** Every changed file is the student's own and conflicts with the handout's edit. */
async function blockedWorld(fx: GitFixture): Promise<World> {
  return await world(fx, {
    before: { "a.txt": "one\n" },
    after: { "a.txt": "two\n" },
    student: (b) => ({ ...b, "a.txt": "mine\n" })
  });
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

Deno.test("the handout_sync queue takes the git engine; every other queue takes REST", () => {
  assertEquals(handoutSyncEngineFor("handout_sync"), "git");
  assertEquals(handoutSyncEngineFor("async_calls"), "rest");
  assertEquals(handoutSyncEngineFor("async_calls_low_priority"), "rest");
  assertEquals(handoutSyncEngineFor(undefined), "rest");
});

// ---------------------------------------------------------------------------------------------
// Successful shapes
// ---------------------------------------------------------------------------------------------

gitTest("no_changes: an empty handout diff opens nothing and reports no head", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, { before: { "a.txt": "same\n" }, after: { "a.txt": "same\n" } });
    const h = harness(w);
    assertEquals(await h.run(), { success: true, no_changes: true });
    assert(!h.gh.routes().some((r) => r.includes("/pulls")), "no PR call for an empty diff");
  });
});

gitTest("blocked_by_student_changes: every file is the student's and still differs at main", async () => {
  await GitFixture.with(async (fx) => {
    const w = await blockedWorld(fx);
    const h = harness(w);
    assertEquals(await h.run(), { success: true, blocked_by_student_changes: true, unresolved_paths: ["a.txt"] });
    assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), null, "nothing was pushed");
    assert(!h.gh.routes().some((r) => r.includes("/pulls")));
  });
});

gitTest("§6.3 recheck: blocked paths already current at main become no_changes with that head", async () => {
  await GitFixture.with(async (fx) => {
    const w = await blockedWorld(fx);
    // After the last sync the student applied the handout's change by hand.
    const head = await w.student.commitOn("main", { "a.txt": "two\n" }, { message: "apply handout by hand\n" });
    const h = harness(w);
    assertEquals(await h.run(), { success: true, no_changes: true, repo_head_sha: head });
  });
});

gitTest("merged: a clean update is pushed, opened with the REST title and body, and merged", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    const result = await h.run();
    const commit = await w.student.ref(`refs/heads/${branchFor(w)}`);
    assert(commit, "the sync branch was pushed");
    assertEquals(result, {
      success: true,
      pr_number: 100,
      pr_url: `https://github.com/${R}/pull/100`,
      merged: true,
      merge_sha: MERGE_SHA,
      unresolved_paths: undefined
    });
    const create = h.gh.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!;
    assertEquals(create.params.title, syncPullRequestTitle(w.H));
    assertEquals(create.params.head, branchFor(w));
    assertEquals(create.params.base, "main");
    // The body the REST path would write for the same sync.
    assertEquals(
      create.params.body,
      renderSyncPullRequestBody({
        toSha: w.H,
        fromSha: w.F,
        baselineSha: w.S,
        baselineWasRecorded: true,
        changedFiles: [
          { path: "a.txt", status: "modified", isBinary: false },
          { path: "img.bin", status: "added", isBinary: true }
        ],
        unresolved: [],
        effectiveAutoMerge: true
      })
    );
    const merge = h.gh.calls.find((c) => c.route.endsWith("/merge"))!;
    assertEquals(merge.params.sha, commit, "the merge is pinned to the commit this job pushed");
    // §5.7: committed as the App's bot, so `isOurSyncCommit` reads it as ours.
    const header = text(await w.student.git(["cat-file", "commit", commit]));
    assertMatch(header, new RegExp(`\\ncommitter ${APP_SLUG}\\[bot\\] <${BOT_ID}\\+${APP_SLUG}\\[bot\\]@users`));
  });
});

gitTest("open PR with unresolved_paths: a partial update is held open and names what it left", async () => {
  await GitFixture.with(async (fx) => {
    const w = await world(fx, {
      before: { "a.txt": "one\n", "b.txt": "bee\n" },
      after: { "a.txt": "two\n", "b.txt": "bee2\n" },
      student: (b) => ({ ...b, "a.txt": "mine\n" })
    });
    const h = harness(w);
    assertEquals(await h.run(), {
      success: true,
      pr_number: 100,
      pr_url: `https://github.com/${R}/pull/100`,
      merged: false,
      merge_sha: undefined,
      unresolved_paths: ["a.txt"]
    });
    assert(!h.gh.routes().some((r) => r.endsWith("/merge")), "auto-merge is off with files left to the student");
    const body = String(h.gh.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!.params.body);
    assert(body.includes("### Files this update did not change"));
    assert(body.includes("It will NOT be merged automatically, because some of the files"));
  });
});

gitTest("an open PR for the branch is reused, not recreated", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.mergeable = false;
    const first = await h.run();
    assertEquals([first.pr_number, first.merged], [100, false]);
    const rendered = h.gh.pulls[0].body;
    h.gh.pulls[0].body = "an earlier attempt's body";
    const second = await h.run();
    assertEquals([second.pr_number, second.merged], [100, false]);
    assertEquals(h.gh.routes().filter((r) => r === "POST /repos/{owner}/{repo}/pulls").length, 1);
    // The reused PR's body is rewritten to what this attempt renders.
    assertEquals(h.gh.pulls[0].body, rendered);
    assertEquals(h.gh.routes().filter((r) => r === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}").length, 1);
  });
});

gitTest("a reused PR's body says what this attempt will do, not what the attempt that opened it would", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.mergeable = false;
    // The first attempt was told not to auto-merge, so its body says it will not be merged.
    await h.run({ autoMerge: false });
    assert(h.gh.pulls[0].body!.includes("It will NOT be merged automatically. Review it"));
    const again = await h.run();
    assertEquals([again.pr_number, again.merged], [100, false]);
    assert(h.gh.pulls[0].body!.includes("It will be auto-merged if there are no conflicts."));
  });
});

gitTest("the merge is pinned to the pushed commit: a student push before the merge stays unmerged", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    let theirs = "";
    h.gh.onGetPull = async (pr) => {
      // The student pushes onto the sync branch while the job waits for mergeability.
      theirs = await w.student.commit({ "a.txt": "theirs\n", "README.md": "readme\n" }, { parents: [pr.head.sha] });
      await w.student.setRef(`refs/heads/${pr.head.ref}`, theirs);
      pr.head.sha = theirs;
    };
    const result = await h.run();
    assertEquals([result.pr_number, result.merged, result.merge_sha], [100, false, undefined]);
    const merge = h.gh.calls.find((c) => c.route.endsWith("/merge"))!;
    assert(merge.params.sha !== theirs, "never asks GitHub to merge the student's commit");
  });
});

gitTest("already in sync: main holds the handout's content at every touched path, so no push and no PR", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    // The student applied the handout's change by hand after the last sync.
    const head = await w.student.commitOn(
      "main",
      { "a.txt": "two\n", "README.md": "readme\n", "img.bin": new Uint8Array([0, 1, 2, 3]) },
      { message: "apply the handout by hand\n" }
    );
    const h = harness(w);
    assertEquals(await h.run(), { success: true, no_changes: true, repo_head_sha: head });
    assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), null, "nothing was pushed");
    assert(!h.gh.routes().some((r) => r.startsWith("POST") || r.startsWith("PUT")), "no PR was opened");
  });
});

gitTest("already in sync counts the files left to the student: one still differing means a PR", async () => {
  await GitFixture.with(async (fx) => {
    // A binary the student replaced is skipped outright, so it is not among the files the plan
    // writes or merges; only the unresolved list names it.
    const w = await world(fx, {
      before: { "img.bin": binary(1), "b.txt": "bee\n" },
      after: { "img.bin": binary(2), "b.txt": "bee2\n" },
      student: (b) => ({ ...b, "img.bin": binary(3) })
    });
    // b.txt, the one file the sync writes, is already current at main; img.bin, left to the
    // student, still is not.
    await w.student.commitOn("main", { "img.bin": binary(3), "b.txt": "bee2\n" });
    const h = harness(w);
    const result = await h.run();
    assertEquals([result.pr_number, result.merged, result.unresolved_paths], [100, false, ["img.bin"]]);
  });
});

gitTest("'No commits between' with no merged PR reports no_changes with our commit as the head", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.noCommitsBetween = true;
    const result = await h.run();
    const commit = await w.student.ref(`refs/heads/${branchFor(w)}`);
    assert(commit && commit !== w.S);
    assertEquals(result, { success: true, no_changes: true, repo_head_sha: commit });
    assert(h.gh.routes().includes("DELETE /repos/{owner}/{repo}/git/refs/{ref}"), "the branch is cleaned up");
  });
});

gitTest("'already exists' race: a PR another job opened after the lookup is found, refreshed and merged", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.pulls.push({
      number: 77,
      html_url: `https://github.com/${R}/pull/77`,
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      head: { sha: w.S, ref: branchFor(w) },
      body: "the other job's body"
    });
    // Both lookups (before the push and before the create) miss it.
    h.gh.hiddenLists = 2;
    const result = await h.run();
    assertEquals([result.success, result.pr_number, result.merged, result.merge_sha], [true, 77, true, MERGE_SHA]);
    assertEquals(h.gh.pulls.length, 1, "no second PR");
    assert(h.gh.pulls[0].body!.startsWith("## Handout Update"), "the body was refreshed");
  });
});

gitTest("a failed PR list is retryable and nothing is pushed", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.failList = true;
    const result = await h.run();
    assertEquals([result.success, result.terminal_reason], [false, undefined]);
    assert(result.error!.includes("Bad Gateway"));
    assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), null);
  });
});

gitTest("a PR closed without merging at our commit is not a merge: a new PR is opened, as REST does", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    h.gh.mergeable = false;
    const first = await h.run();
    assertEquals([first.pr_number, first.merged], [100, false]);
    const commit = await w.student.ref(`refs/heads/${branchFor(w)}`);
    // Someone closed it unmerged; its head is still our commit.
    Object.assign(h.gh.pulls[0], { state: "closed" });
    assertEquals(h.gh.pulls[0].head.sha, commit);
    h.gh.mergeable = true;
    const second = await h.run();
    assertEquals([second.pr_number, second.merged, second.merge_sha], [101, true, MERGE_SHA]);
  });
});

gitTest("sync_git_error_kind is tagged for every engine failure, terminal_sync_reason for terminals", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const spy = () => {
      const tags: Record<string, string> = {};
      const scope = { setTag: (k: string, v: string) => void (tags[k] = v), addBreadcrumb: () => {} };
      return { tags, scope: scope as unknown as SyncRepositoryToHandoutGitParams["scope"] };
    };

    const retryable = spy();
    await harness(w).run({ toSha: "e".repeat(40), retryCount: 1, scope: retryable.scope });
    assertEquals(retryable.tags.sync_git_error_kind, "unfetchable");
    assertEquals(retryable.tags.terminal_sync_reason, undefined);

    const terminal = spy();
    await harness(w).run({ toSha: "abc", scope: terminal.scope });
    assertEquals(terminal.tags.sync_git_error_kind, "invalid_sync_input");
    assertEquals(terminal.tags.terminal_sync_reason, "invalid_sync_input");

    // A credential the remote refuses: git's own message, through a stand-in for the student fetch.
    const which = await new Deno.Command("sh", { args: ["-c", "command -v git"] }).output();
    const realGit = new TextDecoder().decode(which.stdout).trim();
    const wrapper = `${fx.root}/git-auth-fail`;
    await Deno.writeTextFile(
      wrapper,
      [
        "#!/bin/sh",
        `case "$*" in *student-a*) echo "fatal: Authentication failed for 'https://github.com/${R}.git/'" >&2; exit 128;; esac`,
        `exec ${realGit} "$@"`,
        ""
      ].join("\n")
    );
    await Deno.chmod(wrapper, 0o755);
    const auth = spy();
    const result = await harness(w, { gitBinary: wrapper }).run({ scope: auth.scope });
    assertEquals([result.success, result.terminal_reason], [false, undefined]);
    assertEquals(auth.tags.sync_git_error_kind, "auth_failed");
  });
});

// ---------------------------------------------------------------------------------------------
// §5.9 matched pair
// ---------------------------------------------------------------------------------------------

for (const branchDeletedOnMerge of [false, true]) {
  gitTest(
    `§5.9 matched pair: a retry after a crash past the merge reports merged with merge_sha` +
      (branchDeletedOnMerge ? " (branch auto-deleted)" : ""),
    async () => {
      await GitFixture.with(async (fx) => {
        const w = await cleanWorld(fx);
        const h = harness(w);
        const first = await h.run();
        assertEquals([first.merged, first.merge_sha], [true, MERGE_SHA]);
        const commit = (await w.student.ref(`refs/heads/${branchFor(w)}`))!;
        // GitHub merged it into main. The worker then died before writing the row.
        await w.student.setRef(
          "refs/heads/main",
          await w.student.commit(
            { "a.txt": "two\n", "README.md": "readme\n", "img.bin": new Uint8Array([0, 1, 2, 3]) },
            { parents: [w.S, commit], message: "Merge pull request #100\n" }
          )
        );
        if (branchDeletedOnMerge) await w.student.deleteRef(`refs/heads/${branchFor(w)}`);
        const pushesBefore = h.timeline.filter((e) => e === "git push").length;

        const retry = await h.run({ retryCount: 1 });
        assertEquals(retry, {
          success: true,
          pr_number: 100,
          pr_url: `https://github.com/${R}/pull/100`,
          merged: true,
          merge_sha: MERGE_SHA
        });
        assertEquals(retry.no_changes, undefined);
        assertEquals(h.gh.routes().filter((r) => r === "POST /repos/{owner}/{repo}/pulls").length, 1);
        assertEquals(h.timeline.filter((e) => e === "git push").length, pushesBefore, "nothing was pushed");
        assertEquals(
          await w.student.ref(`refs/heads/${branchFor(w)}`),
          branchDeletedOnMerge ? null : commit,
          branchDeletedOnMerge ? "the auto-deleted branch is not recreated" : "the branch is untouched"
        );
      });
    }
  );
}

// ---------------------------------------------------------------------------------------------
// §8.2 token, §5.8 branch safety, limiter
// ---------------------------------------------------------------------------------------------

gitTest("§8.2: two tokens, the student repo with three write permissions and the template read-only", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    assertEquals((await h.run()).merged, true);
    // The read-only template token first, so a template over the size limit stops the job before
    // a token that can write to the student repo is minted.
    assertEquals(h.tokenRequests, [
      { org: "org", repositories: ["handout"], permissions: { contents: "read" } },
      {
        org: "org",
        repositories: ["student-a"],
        permissions: { contents: "write", pull_requests: "write", workflows: "write" }
      }
    ]);
    assertEquals(SYNC_TOKEN_PERMISSIONS, { contents: "write", pull_requests: "write", workflows: "write" });
    assertEquals(TEMPLATE_TOKEN_PERMISSIONS, { contents: "read" });
    assertEquals(h.octokitTokens, [TEMPLATE_TOKEN, TOKEN]);
    // The template token makes exactly one REST call, the template's size; the student token the rest.
    const templateCalls = h.gh.calls.filter((c) => c.token === TEMPLATE_TOKEN);
    assertEquals(
      templateCalls.map((c) => [c.route, `${c.params.owner}/${c.params.repo}`]),
      [["GET /repos/{owner}/{repo}", T]]
    );
    assert(h.gh.calls.filter((c) => c.token !== TEMPLATE_TOKEN).every((c) => c.token === TOKEN));
  });
});

/**
 * A git stand-in that appends `<header>\t<argv>` for every call to `log` and then runs the real
 * git, where `<header>` is the `GIT_CONFIG_VALUE_0` runGit put in the child's environment.
 */
async function envSpyGit(fx: GitFixture, log: string): Promise<string> {
  const which = await new Deno.Command("sh", { args: ["-c", "command -v git"] }).output();
  const realGit = new TextDecoder().decode(which.stdout).trim();
  assert(realGit.startsWith("/"), "found the real git");
  const wrapper = `${fx.root}/git-env-spy`;
  await Deno.writeTextFile(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' "\${GIT_CONFIG_VALUE_0:-none}" "$*" >> '${log}'`,
      `exec ${realGit} "$@"`,
      ""
    ].join("\n")
  );
  await Deno.chmod(wrapper, 0o755);
  return wrapper;
}

/** The token inside an `AUTHORIZATION: basic …` header, or "none". */
function tokenInHeader(header: string): string {
  if (header === "none") return "none";
  const basic = header.replace(/^AUTHORIZATION: basic /, "");
  return atob(basic).replace(/^x-access-token:/, "");
}

gitTest("§8.2: template fetches carry only the template token, student-side git only the student token", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const log = `${fx.root}/git-env.log`;
    const h = harness(w, { gitBinary: await envSpyGit(fx, log) });
    assertEquals((await h.run()).merged, true);
    const calls = (await Deno.readTextFile(log))
      .trim()
      .split("\n")
      .map((line) => {
        const tab = line.indexOf("\t");
        return { token: tokenInHeader(line.slice(0, tab)), argv: line.slice(tab + 1) };
      });
    const templateUrl = `file://${fx.remotePath(T)}`;
    const studentUrl = `file://${fx.remotePath(R)}`;
    const templateSide = calls.filter((c) => c.argv.includes(templateUrl) || c.argv.includes(fx.templatesDir));
    const studentSide = calls.filter((c) => c.argv.includes(studentUrl) || c.argv.includes(fx.jobsDir));
    assert(
      templateSide.some((c) => c.argv.includes(templateUrl)),
      "a template fetch ran"
    );
    assert(
      studentSide.some((c) => c.argv.includes(studentUrl) && c.argv.includes(" push ")),
      "a push ran"
    );
    for (const c of templateSide) assertEquals(c.token, TEMPLATE_TOKEN, `template-side call: ${c.argv}`);
    for (const c of studentSide) assertEquals(c.token, TOKEN, `student-side call: ${c.argv}`);
    assert(!templateSide.some((c) => studentSide.includes(c)), "no call names both sides");
  });
});

gitTest("§8.2 engine: with no template token, template fetches carry no credential, not the student's", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const log = `${fx.root}/git-env.log`;
    const ctx = fx.jobContext({ token: TOKEN });
    ctx.testOnly = { git: { ...ctx.testOnly?.git, gitBinary: await envSpyGit(fx, log) } };
    const plan = await withSyncJob(ctx, (job) => job.plan(w.input));
    assertEquals(plan.kind, "commit");
    const lines = (await Deno.readTextFile(log)).trim().split("\n");
    const templateUrl = `file://${fx.remotePath(T)}`;
    const fetches = lines.filter((l) => l.includes(templateUrl));
    assert(fetches.length > 0, "a template fetch ran");
    for (const l of fetches) assertEquals(tokenInHeader(l.slice(0, l.indexOf("\t"))), "none", l);
    const student = lines.filter((l) => l.includes(`file://${fx.remotePath(R)}`));
    assert(student.length > 0);
    for (const l of student) assertEquals(tokenInHeader(l.slice(0, l.indexOf("\t"))), TOKEN, l);
  });
});

gitTest("§8.2: a handout in another org syncs end to end with that org's installation", async () => {
  await GitFixture.with(async (fx) => {
    const otherT = "other-org/handout";
    const template = await fx.createRepo(otherT);
    const before: Snapshot = { "a.txt": "one\n" };
    const F = await template.commitOn("main", before);
    const H = await template.commitOn("main", { "a.txt": "two\n", "b.txt": "new\n" });
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", before);
    const w: World = {
      fx,
      template,
      student,
      F,
      H,
      S,
      input: { templateRepo: otherT, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R }
    };
    const h = harness(w);
    const result = await h.run();
    assertEquals([result.success, result.merged, result.merge_sha], [true, true, MERGE_SHA]);
    assertEquals(
      h.tokenRequests.map((t) => [t.org, t.repositories, t.permissions]),
      [
        ["other-org", ["handout"], { contents: "read" }],
        ["org", ["student-a"], SYNC_TOKEN_PERMISSIONS]
      ]
    );
    const commit = (await student.ref(`refs/heads/${branchFor(w)}`))!;
    assertEquals(await student.show(commit, "b.txt"), "new\n");
  });
});

Deno.test("§8.2: the access-token request carries names, not full names, and the permissions as given", async () => {
  const calls: Call[] = [];
  const appOctokit = {
    request: (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return Promise.resolve({ data: { token: TOKEN, expires_at: "2026-11-02T01:00:00Z" } });
    }
  };
  const minted = await requestScopedInstallationToken(
    appOctokit as unknown as Parameters<typeof requestScopedInstallationToken>[0],
    77,
    ["student-a", "handout"],
    SYNC_TOKEN_PERMISSIONS
  );
  assertEquals(minted, { token: TOKEN, expiresAt: "2026-11-02T01:00:00Z" });
  assertEquals(calls, [
    {
      route: "POST /app/installations/{installation_id}/access_tokens",
      params: {
        installation_id: 77,
        repositories: ["student-a", "handout"],
        permissions: { contents: "write", pull_requests: "write", workflows: "write" }
      }
    }
  ]);
  let refused = false;
  try {
    await getScopedInstallationToken("org", ["org/student-a"], SYNC_TOKEN_PERMISSIONS);
  } catch (e) {
    refused = String(e).includes("without an owner");
  }
  assert(refused, "a full name is refused before any installation lookup");
});

gitTest(
  "§5.8: confirmResetSafe compares base...head for the ls-remote head and never re-reads the branch",
  async () => {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      // An earlier attempt of ours left a different commit on the branch.
      const stale = await w.student.commit({ "a.txt": "stale\n", "README.md": "readme\n" }, { parents: [w.S] });
      await w.student.setRef(`refs/heads/${branchFor(w)}`, stale);
      const h = harness(w);
      h.gh.compareCommits = [
        {
          commit: {
            message: `Sync handout updates to ${w.H.substring(0, 7)}\n\nbody`,
            verification: { verified: false }
          },
          author: { type: "Bot" },
          committer: { login: `${APP_SLUG}[bot]`, type: "Bot" }
        }
      ];
      const result = await h.run();
      assertEquals(result.merged, true);
      const compares = h.gh.calls.filter((c) => c.route.includes("/compare/"));
      assertEquals(compares.length, 1);
      assertEquals(compares[0].params.basehead, `${w.S}...${stale}`);
      assert(
        !h.gh.routes().some((r) => r.includes("/git/ref") || r.includes("/branches")),
        "the branch head comes from ls-remote, not REST"
      );
      assert((await w.student.ref(`refs/heads/${branchFor(w)}`)) !== stale, "reset over our own stale commit");
    });
  }
);

gitTest("the limiters are held only for the PR calls, never during git", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    await h.run();
    assertEquals(h.spawnsUnderLimiter, []);
    const start = h.timeline.indexOf("sync:start");
    const inner = h.timeline.indexOf("content:start");
    const end = h.timeline.lastIndexOf("content:end");
    assert(start >= 0 && inner > start, "both limiters are taken, the content limiter inside the sync limiter");
    assert(h.timeline.slice(0, start).includes("git"), "git ran before the limiters");
    // Everything that creates, edits or merges a PR, and every PR read after the push. The one
    // read before the push (the merged-PR check) runs without the limiters, between git calls.
    const lastPush = h.timeline.lastIndexOf("git push");
    const prCalls = h.timeline
      .map((e, i) => [e, i] as const)
      .filter(([e, i]) => e.startsWith("rest ") && (e.includes("/pulls") || e.includes("/merge")) && i > lastPush);
    assert(prCalls.length >= 3);
    for (const [e, i] of prCalls) assert(i > inner && i < end, `${e} ran outside the content limiter`);
  });
});

// ---------------------------------------------------------------------------------------------
// §7 terminals
// ---------------------------------------------------------------------------------------------

function assertTerminal(result: SyncResult, reason: string): void {
  assertEquals(result.success, false);
  assertEquals(result.terminal_reason, reason, result.error);
  assert(typeof result.error === "string" && result.error.length > 0);
}

for (const which of ["student", "template"] as const) {
  gitTest(
    `§8.4: a ${which} repo over HANDOUT_SYNC_MAX_REPO_KIB is terminal repo_too_large before any fetch`,
    async () => {
      await GitFixture.with(async (fx) => {
        const w = await cleanWorld(fx);
        const h = harness(w, { maxRepoKib: 1000 });
        h.gh.sizes.set(which === "student" ? R : T, 1001);
        assertTerminal(await h.run(), "repo_too_large");
        assert(!h.timeline.includes("git"), "nothing was fetched");
        if (which === "template") {
          assertEquals(
            h.tokenRequests.map((t) => t.repositories),
            [["handout"]],
            "no student write token was minted"
          );
        }
      });
    }
  );
}

for (const solution of [
  { graderRepo: "ORG/Handout", solutionTemplateRepo: "org/solution-template" },
  { graderRepo: null, solutionTemplateRepo: "org/HANDOUT" }
]) {
  gitTest(`§8.3: a template equal to ${JSON.stringify(solution)} is terminal template_is_solution_repo`, async () => {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      const h = harness(w, { solution });
      assertTerminal(await h.run(), "template_is_solution_repo");
      assertEquals(h.tokenRequests, [], "refused before a token is minted");
      assert(!h.timeline.includes("git"));
    });
  });
}

gitTest("§5.8: a GH001 push rejection is terminal file_too_large", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const which = await new Deno.Command("sh", { args: ["-c", "command -v git"] }).output();
    const realGit = new TextDecoder().decode(which.stdout).trim();
    assert(realGit.startsWith("/"), "found the real git");
    const wrapper = `${fx.root}/git-gh001`;
    await Deno.writeTextFile(
      wrapper,
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        '  if [ "$a" = "push" ]; then',
        '    echo "remote: error: File img.bin is 120.50 MB; this exceeds GitHub\'s file size limit of 100.00 MB" >&2',
        '    echo "remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com." >&2',
        '    echo " ! [remote rejected] HEAD -> sync (pre-receive hook declined)" >&2',
        "    exit 1",
        "  fi",
        "done",
        `exec ${realGit} "$@"`,
        ""
      ].join("\n")
    );
    await Deno.chmod(wrapper, 0o755);
    const h = harness(w, { gitBinary: wrapper });
    const result = await h.run();
    assertTerminal(result, "file_too_large");
    assert(result.error!.includes("img.bin"), "the error names the path");
  });
});

gitTest("§5.8: foreign commits on the sync branch are terminal sync_branch_not_ours", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const theirs = await w.student.commit(
      { "a.txt": "resolved by hand\n", "README.md": "readme\n" },
      { parents: [w.S] }
    );
    await w.student.setRef(`refs/heads/${branchFor(w)}`, theirs);
    const h = harness(w);
    h.gh.compareCommits = [
      { commit: { message: "resolve the update" }, author: { type: "User" }, committer: { login: "stu", type: "User" } }
    ];
    assertTerminal(await h.run(), "sync_branch_not_ours");
    assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), theirs, "their commit is still there");
  });
});

for (const [label, commits, total] of [
  [
    "a truncated compare (over GitHub's 250-commit cap)",
    [
      {
        commit: { message: "Sync handout updates to 1234567", verification: { verified: false } },
        author: { type: "Bot" },
        committer: { login: `${APP_SLUG}[bot]`, type: "Bot" }
      }
    ],
    300
  ],
  [
    "an unattributed commit",
    [{ commit: { message: "Sync handout updates to 1234567" }, author: null, committer: null }],
    undefined
  ]
] as const) {
  gitTest(`§5.8: ${label} on the sync branch is terminal sync_branch_not_ours`, async () => {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      const there = await w.student.commit({ "a.txt": "x\n", "README.md": "readme\n" }, { parents: [w.S] });
      await w.student.setRef(`refs/heads/${branchFor(w)}`, there);
      const h = harness(w);
      h.gh.compareCommits = [...commits];
      h.gh.compareTotal = total;
      assertTerminal(await h.run(), "sync_branch_not_ours");
      assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), there, "the branch is untouched");
    });
  });
}

for (const [label, missing, reason] of [
  ["H", "toSha", "handout_revision_missing"],
  ["F", "fromSha", "handout_base_missing"]
] as const) {
  gitTest(`§7: an unfetchable ${label} is retryable at retry 4 and terminal ${reason} at retry 5`, async () => {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      const h = harness(w);
      const gone = "e".repeat(40);
      const atFour = await h.run({ [missing]: gone, retryCount: 4 });
      assertEquals(atFour.success, false);
      assertEquals(atFour.terminal_reason, undefined, "still retryable");
      assert(atFour.error!.includes("not fetchable"));
      assertTerminal(await h.run({ [missing]: gone, retryCount: 5 }), reason);
    });
  });
}

for (const [label, overrides] of [
  ["a repo name starting with -", { repositoryFullName: "-x/evil" }],
  ["a short sha", { toSha: "abc123" }],
  ["an uppercase synced repo sha", { syncedRepoSha: "A".repeat(40) }]
] as const) {
  gitTest(`§8.1: ${label} is terminal invalid_sync_input before any request`, async () => {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      const h = harness(w);
      assertTerminal(await h.run(overrides), "invalid_sync_input");
      assertEquals(h.tokenRequests, []);
      assertEquals(h.gh.calls, []);
      assert(!h.timeline.includes("git"));
    });
  });
}

gitTest("§5.2: a student repo with no main is terminal student_repo_has_no_main", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const F = await template.commitOn("main", { "a.txt": "a\n" });
    const H = await template.commitOn("main", { "a.txt": "b\n" });
    const student = await fx.createRepo(R, { defaultBranch: "trunk" });
    const S = await student.commitOn("trunk", { "a.txt": "a\n" });
    const w: World = {
      fx,
      template,
      student,
      F,
      H,
      S,
      input: { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R }
    };
    assertTerminal(await harness(w).run({ syncedRepoSha: null }), "student_repo_has_no_main");
  });
});

gitTest("§5.3: a non-UTF-8 handout path is terminal non_utf8_path", async () => {
  await GitFixture.with(async (fx) => {
    const template = await fx.createRepo(T);
    const before: Snapshot = { "a.txt": "a\n" };
    const F = await template.commitOn("main", before);
    const bad = new Uint8Array([0x64, 0x2f, 0xff, 0xfe, 0x2e, 0x63]);
    const H = await template.commit(before, { parents: [F], rawPaths: [{ pathBytes: bad, content: "x\n" }] });
    await template.setRef("refs/heads/main", H);
    const student = await fx.createRepo(R);
    const S = await student.commitOn("main", before);
    const w: World = {
      fx,
      template,
      student,
      F,
      H,
      S,
      input: { templateRepo: T, fromSha: F, toSha: H, syncedRepoSha: S, repoFullName: R }
    };
    assertTerminal(await harness(w).run(), "non_utf8_path");
  });
});

gitTest("a failure never puts the token or the params object in the result", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w, { maxRepoKib: 1 });
    h.gh.sizes.set(R, 2);
    const result = await h.run();
    assert(!JSON.stringify(result).includes(TOKEN));
    assert(!JSON.stringify(result).includes(TEMPLATE_TOKEN));
  });
});

// ---------------------------------------------------------------------------------------------
// Worker seams: the per-job deadline signal and the shadow plan (build plan WP5)
// ---------------------------------------------------------------------------------------------

gitTest("runtime.signalFor: an aborted job signal stops the job before git runs, as retryable", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const h = harness(w);
    const asked: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const runtime = h.deps.runtime();
    h.deps.runtime = () => ({ ...runtime, signalFor: (jobId) => (asked.push(jobId), controller.signal) });
    const result = await h.run();
    assertEquals(asked, ["123"], "keyed by the jobId the handler passes, the msg_id");
    assertEquals(result.success, false);
    assertEquals(result.terminal_reason, undefined);
    assertMatch(String(result.error), /deadline/);
    assert(!h.timeline.includes("git push"));
    assertEquals(await w.student.ref(`refs/heads/${branchFor(w)}`), null);
  });
});

/** A harness whose token stub tells the two sides apart by repo, since in shadow both are read-only. */
function shadowHarness(w: World, opts: { solution?: SolutionRepos } = {}) {
  const h = harness(w, opts);
  h.deps.getScopedToken = (org, repositories, permissions) => {
    h.tokenRequests.push({ org, repositories: [...repositories], permissions });
    const token = `${org}/${repositories[0]}` === w.input.templateRepo ? TEMPLATE_TOKEN : TOKEN;
    return Promise.resolve({ token, expiresAt: "2026-11-02T01:00:00Z" });
  };
  const plan = () =>
    planRepositoryToHandoutGit(
      {
        repositoryFullName: w.input.repoFullName,
        templateRepo: w.input.templateRepo,
        fromSha: w.F,
        toSha: w.H,
        syncedRepoSha: w.S,
        adminSupabase: {} as SyncRepositoryToHandoutGitParams["adminSupabase"],
        repositoryId: 1,
        retryCount: 0,
        jobId: "77"
      },
      h.deps
    );
  return { ...h, plan };
}

gitTest("shadow plan: read-only tokens for both repos, the predicted tree, and no push or REST write", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const refsBefore = await w.student.refs();
    const h = shadowHarness(w);
    const prediction = await h.plan();

    // What a real sync from the same inputs would build.
    const expected = await withSyncJob(
      fx.jobContext({
        identity: { name: `${APP_SLUG}[bot]`, email: `${BOT_ID}+${APP_SLUG}[bot]@users.noreply.github.com` }
      }),
      (job) => job.plan(w.input)
    );
    assertEquals(expected.kind, "commit");
    assertEquals(prediction, {
      predicted_tree: expected.kind === "commit" ? expected.tree : null,
      predicted_commit_parent: w.S,
      unresolved: [],
      error: null
    });
    assertEquals(SHADOW_STUDENT_TOKEN_PERMISSIONS, { contents: "read" });
    assertEquals(
      h.tokenRequests.map((t) => [t.repositories[0], t.permissions]),
      [
        ["handout", { contents: "read" }],
        ["student-a", { contents: "read" }]
      ]
    );
    assert(!h.timeline.includes("git push"));
    assertEquals(await w.student.refs(), refsBefore, "nothing reached the student remote");
    assert(
      h.gh.calls.every((c) => c.route.startsWith("GET ")),
      `only reads: ${h.gh.calls.map((c) => c.route).join(", ")}`
    );
    assertEquals(await Array.fromAsync(Deno.readDir(fx.jobsDir)), [], "the job directory is gone");
  });
});

gitTest("shadow plan: every file left to the student predicts no tree and lists them", async () => {
  await GitFixture.with(async (fx) => {
    const w = await blockedWorld(fx);
    const prediction = await shadowHarness(w).plan();
    assertEquals(prediction, {
      predicted_tree: null,
      predicted_commit_parent: null,
      unresolved: [{ path: "a.txt", reason: "content_differs" }],
      error: null
    });
  });
});

gitTest("shadow plan: a terminal refusal is the prediction's error, not a throw", async () => {
  await GitFixture.with(async (fx) => {
    const w = await cleanWorld(fx);
    const prediction = await shadowHarness(w, { solution: { graderRepo: T, solutionTemplateRepo: null } }).plan();
    assertEquals([prediction.predicted_tree, prediction.unresolved], [null, null]);
    assertMatch(String(prediction.error), /^template_is_solution_repo: /);
  });
});

/** A git stand-in that fails every push with `stderr`, and runs the real git otherwise. */
async function failingPushGit(fx: GitFixture, stderr: string): Promise<string> {
  const path = `${fx.root}/failing-push-git.sh`;
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then printf '%s\\n' '${stderr}' >&2; exit 128; fi; done\nexec /usr/bin/git "$@"\n`
  );
  await Deno.chmod(path, 0o755);
  return path;
}

gitTest("a local git failure is marked for redelivery; a network failure is not", async () => {
  assertEquals([...REDELIVERY_KINDS].sort(), [
    "deadline_exceeded",
    "disk_full",
    "git_failed",
    "lease_rejected",
    "output_cap_exceeded",
    "reset_check_mismatch",
    "spawn_failed",
    "timeout"
  ]);
  for (const [stderr, kind] of [
    ["fatal: unable to write new index file: No space left on device", "disk_full"],
    ["error: RPC failed; curl 56 Recv failure: Connection reset by peer", undefined]
  ] as const) {
    await GitFixture.with(async (fx) => {
      const w = await cleanWorld(fx);
      const result = await harness(w, { gitBinary: await failingPushGit(fx, stderr) }).run();
      assertEquals([result.success, result.terminal_reason, result.redeliver_kind], [false, undefined, kind], stderr);
    });
  }
});
