/**
 * Unit tests for the push handling shared by github-repo-webhook and forgejo-repo-webhook.
 *
 * The GitHub cases pin the queries and the `repository_check_runs` row to what github-repo-webhook
 * produced before the code moved here (#1109): same filters, same row, `created_by` still
 * "github push by <pusher>".
 *
 * Run from supabase/functions:  deno test --no-check --allow-read --allow-env --allow-net _shared/RepoPush.test.ts
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  acceptStudentRepoPush,
  findStudentRepository,
  fromGitHubPush,
  ilikeLiteral,
  isDefaultBranchPush,
  recordCommitCheckRun,
  type GitHubPushPayload,
  type RepoPush
} from "./RepoPush.ts";
import { fakeSupabase, repositoryRow } from "./RepoPushFakeClient.ts";

const SHA = "3f786850e387550fdab836ed7e6dc881de23001b";
const PARENT_SHA = "89e6c98d92887913cadf06b2adb97f26cde4849b";

/** A GitHub push event, trimmed to plain fields, as EventBridge delivers it in `detail`. */
function gitHubPayload(overrides: Partial<GitHubPushPayload> = {}): GitHubPushPayload {
  const commit = {
    id: SHA,
    message: "Finish part 1 #submit",
    timestamp: "2026-11-09T10:00:00-05:00",
    author: { name: "Alex Kim" },
    removed: []
  };
  return {
    ref: "refs/heads/main",
    after: SHA,
    repository: { full_name: "cs101/hw1-alex", default_branch: "main" },
    head_commit: commit,
    commits: [{ ...commit, id: PARENT_SHA, message: "Start part 1" }, commit],
    pusher: { name: "alexkim" },
    ...overrides
  };
}

function tables() {
  return {
    repositories: [
      repositoryRow({ id: 1, git_provider: "github" }),
      repositoryRow({ id: 2, git_provider: "forgejo", profile_id: "other-profile" })
    ],
    assignments: [
      { id: 100, git_provider: "github", submission_mode: "push", has_autograder: true, repo_mode: "individual" }
    ],
    repository_check_runs: [] as Record<string, unknown>[]
  };
}

/** Replaces `status.created_at`, which is the insert time, after checking it is one. */
function withoutCreatedAt(row: Record<string, unknown>) {
  const status = row.status as Record<string, unknown>;
  assert(!Number.isNaN(Date.parse(status.created_at as string)));
  return { ...row, status: { ...status, created_at: "<now>" } };
}

Deno.test("fromGitHubPush carries the payload fields the handler reads", () => {
  const payload = gitHubPayload();
  assertEquals(fromGitHubPush(payload), {
    provider: "github",
    repository: "cs101/hw1-alex",
    ref: "refs/heads/main",
    after: SHA,
    defaultBranch: "main",
    headCommit: payload.head_commit,
    commits: payload.commits,
    pusherName: "alexkim"
  });
});

Deno.test("GitHub push: same lookups and the same commit history rows as before the move", async () => {
  const { client, queries, inserts } = fakeSupabase(tables());
  const scope = new Sentry.Scope();
  const push = fromGitHubPush(gitHubPayload());

  const repo = await findStudentRepository(client, "github", push.repository, scope);
  assertEquals(repo?.id, 1);
  assert(isDefaultBranchPush(push, scope));
  const accepted = await acceptStudentRepoPush(client, push, repo!, scope);
  assertEquals(accepted?.assignment?.id, 100);
  for (const commit of push.commits) await recordCommitCheckRun(client, repo!, push, commit, scope);

  assertEquals(
    queries.map((q) => [q.table, q.filters]),
    [
      [
        "repositories",
        [
          ["git_provider", "github"],
          ["repository", "cs101/hw1-alex"]
        ]
      ],
      [
        "assignments",
        [
          ["git_provider", "github"],
          ["id", 100]
        ]
      ],
      [
        "repository_check_runs",
        [
          ["repository_id", 1],
          ["sha", PARENT_SHA]
        ]
      ],
      [
        "repository_check_runs",
        [
          ["repository_id", 1],
          ["sha", SHA]
        ]
      ]
    ]
  );
  const row = (message: string, sha: string) => ({
    repository_id: 1,
    check_run_id: null,
    class_id: 10,
    assignment_group_id: null,
    commit_message: message,
    sha,
    profile_id: "student-profile",
    status: {
      created_at: "<now>",
      commit_author: "Alex Kim",
      commit_date: "2026-11-09T10:00:00-05:00",
      created_by: "github push by alexkim"
    }
  });
  assertEquals(
    inserts.map((i) => [i.table, withoutCreatedAt(i.row)]),
    [
      ["repository_check_runs", row("Start part 1", PARENT_SHA)],
      ["repository_check_runs", row("Finish part 1 #submit", SHA)]
    ]
  );
});

Deno.test("findStudentRepository only matches a repository on the given provider", async () => {
  const name = "cs101/hw1-alex";
  const both = fakeSupabase(tables());
  assertEquals((await findStudentRepository(both.client, "forgejo", name, new Sentry.Scope()))?.id, 2);
  assertEquals((await findStudentRepository(both.client, "github", name, new Sentry.Scope()))?.id, 1);

  const githubOnly = fakeSupabase({ repositories: [repositoryRow({ id: 1, git_provider: "github" })] });
  assertEquals(await findStudentRepository(githubOnly.client, "forgejo", name, new Sentry.Scope()), null);

  const forgejoOnly = fakeSupabase({ repositories: [repositoryRow({ id: 2, git_provider: "forgejo" })] });
  assertEquals(await findStudentRepository(forgejoOnly.client, "github", name, new Sentry.Scope()), null);
});

Deno.test("findStudentRepository ignores case for Forgejo only", async () => {
  const both = fakeSupabase(tables());
  assertEquals((await findStudentRepository(both.client, "forgejo", "CS101/HW1-Alex", new Sentry.Scope()))?.id, 2);
  // GitHub's lookup is unchanged: an exact, case-sensitive `eq`.
  assertEquals(await findStudentRepository(both.client, "github", "CS101/HW1-Alex", new Sentry.Scope()), null);
  assertEquals(
    both.queries.map((q) => q.filters),
    [
      [
        ["git_provider", "forgejo"],
        ["repository", { ilike: "CS101/HW1-Alex" }]
      ],
      [
        ["git_provider", "github"],
        ["repository", "CS101/HW1-Alex"]
      ]
    ]
  );
});

Deno.test("ilikeLiteral escapes the ILIKE wildcards and the escape character", () => {
  assertEquals(ilikeLiteral("cs101/hw1-alex"), "cs101/hw1-alex");
  assertEquals(ilikeLiteral("cs_101/100%\\done"), "cs\\_101/100\\%\\\\done");
});

Deno.test("acceptStudentRepoPush ignores an assignment on the other provider", async () => {
  const { client } = fakeSupabase(tables());
  const forgejoPush: RepoPush = { ...fromGitHubPush(gitHubPayload()), provider: "forgejo" };
  assertEquals(await acceptStudentRepoPush(client, forgejoPush, repositoryRow(), new Sentry.Scope()), {
    assignment: null
  });
});

Deno.test("isDefaultBranchPush uses the repository's default branch, or main", () => {
  const scope = new Sentry.Scope();
  const push = fromGitHubPush(gitHubPayload());
  assert(isDefaultBranchPush(push, scope));
  assert(!isDefaultBranchPush({ ...push, ref: "refs/heads/scratch" }, scope));
  assert(isDefaultBranchPush({ ...push, ref: "refs/heads/master", defaultBranch: "master" }, scope));
  assert(!isDefaultBranchPush({ ...push, defaultBranch: "master" }, scope));
  assert(isDefaultBranchPush({ ...push, defaultBranch: undefined }, scope));
  assert(isDefaultBranchPush({ ...push, defaultBranch: null }, scope));
});

Deno.test("acceptStudentRepoPush drops pushes Pawtograder doesn't act on", async () => {
  const push = fromGitHubPush(gitHubPayload());
  const cases: [string, Record<string, unknown>, RepoPush][] = [
    ["pr-mode assignment", { submission_mode: "pr" }, push],
    ["repo_mode none", { repo_mode: "none" }, push],
    ["repo_mode no_submission", { repo_mode: "no_submission" }, push],
    ["submission tag", {}, { ...push, ref: "refs/tags/pawtograder-submit/1" }],
    ["no head commit", {}, { ...push, headCommit: null }]
  ];
  for (const [label, assignment, input] of cases) {
    const t = tables();
    Object.assign(t.assignments[0], assignment);
    const { client } = fakeSupabase(t);
    assertEquals(await acceptStudentRepoPush(client, input, repositoryRow(), new Sentry.Scope()), null, label);
  }
});

Deno.test("recordCommitCheckRun leaves an existing row alone and treats a lost insert race as done", async () => {
  const push = fromGitHubPush(gitHubPayload());
  const commit = push.commits[1];
  const t = tables();
  t.repository_check_runs.push({ id: 9, repository_id: 1, sha: SHA });
  const existing = fakeSupabase(t);
  await recordCommitCheckRun(existing.client, repositoryRow(), push, commit, new Sentry.Scope());
  assertEquals(existing.inserts, []);

  const race = fakeSupabase(tables(), { insertError: { code: "23505", message: "duplicate key" } });
  await recordCommitCheckRun(race.client, repositoryRow(), push, commit, new Sentry.Scope());

  const failing = fakeSupabase(tables(), { insertError: { code: "42501", message: "permission denied" } });
  await assertRejects(() => recordCommitCheckRun(failing.client, repositoryRow(), push, commit, new Sentry.Scope()));
});
