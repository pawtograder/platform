import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  getTestRunPrefix,
  supabase,
  TEST_HANDOUT_REPO,
  type TestingUser
} from "./TestingUtils";

// Integration coverage for the repo_mode-aware enqueue path (PR #781, review
// gaps T1–T4). These exercise the SQL that decides creation_method / source_repo
// / branch_protection and the group-change TRIGGER path (create_all_repos_for_
// assignment_internal), asserting the message actually placed on the
// `async_calls` pgmq queue — no GitHub and no worker required.
//
// We read the queue immediately after enqueuing. The every-minute
// invoke-github-async-worker cron drains async_calls, but the read happens
// milliseconds after the enqueue call returns, well inside that window; matched
// messages are deleted so neither the worker nor a later poll reprocesses our
// fake repos.

const RUN = getTestRunPrefix();
const SAFE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type CreateRepoArgs = {
  org: string;
  repoName: string;
  templateRepo?: string;
  creationMethod?: string;
  sourceRepo?: string;
  branchProtection?: { blockForcePush?: boolean; requirePullRequest?: boolean; requiredReviewers?: number };
};

type QueueRow = { msg_id: number; message: { method?: string; args?: CreateRepoArgs } };

async function readAsyncCalls(vtSeconds: number): Promise<QueueRow[]> {
  const { data, error } = await supabase
    .schema("pgmq_public")
    .rpc("read", { queue_name: "async_calls", sleep_seconds: vtSeconds, n: 200 });
  if (error) throw new Error(`pgmq read failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

// Poll the queue for create_repo messages whose repoName matches `repoName`,
// deleting (consuming) the matches so they don't get reprocessed. Returns the
// matched args. Resolves as soon as at least one match is found.
async function findCreateRepoArgs(repoName: string, timeoutMs = 8000): Promise<CreateRepoArgs[]> {
  const matches: CreateRepoArgs[] = [];
  const seen = new Set<number>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await readAsyncCalls(2);
    for (const row of rows) {
      if (seen.has(row.msg_id)) continue;
      seen.add(row.msg_id);
      const msg = row.message;
      if (msg?.method === "create_repo" && msg.args?.repoName === repoName) {
        matches.push(msg.args);
        await supabase.schema("pgmq_public").rpc("delete", { queue_name: "async_calls", message_id: row.msg_id });
      }
    }
    if (matches.length > 0) return matches;
    await new Promise((r) => setTimeout(r, 300));
  }
  return matches;
}

// Assert that NO create_repo message for `repoName` shows up within a short
// window (used for the skip/warning paths). Does not consume other suites' msgs.
async function expectNoCreateRepo(repoName: string, windowMs = 2500): Promise<void> {
  const deadline = Date.now() + windowMs;
  const seen = new Set<number>();
  while (Date.now() < deadline) {
    const rows = await readAsyncCalls(1);
    for (const row of rows) {
      if (seen.has(row.msg_id)) continue;
      seen.add(row.msg_id);
      if (row.message?.method === "create_repo" && row.message.args?.repoName === repoName) {
        throw new Error(`Unexpected create_repo message enqueued for ${repoName}`);
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function makeStudentWithGithub(
  classId: number,
  tag: string
): Promise<{ user: TestingUser; githubUsername: string }> {
  const user = await createUserInClass({
    role: "student",
    class_id: classId,
    name: `RepoCfg ${tag} ${RUN}`,
    email: `e2e-repocfg-${tag}-${SAFE}@pawtograder.net`
  });
  const githubUsername = `gh-${tag}-${SAFE}`.toLowerCase();
  const { error } = await supabase
    .from("users")
    .update({ github_username: githubUsername })
    .eq("user_id", user.user_id);
  if (error) throw new Error(`set github_username failed: ${error.message}`);
  return { user, githubUsername };
}

const releasedYesterday = () => addDays(new Date(), -1).toUTCString();
const dueNextWeek = () => addDays(new Date(), 7).toISOString();

test.describe("repo_mode-aware enqueue (PR #781: T1–T4)", () => {
  test("T1: template_only_staff (mode 1) enqueues a TEMPLATE-generate message", async () => {
    const klass = await createClass({ name: `RepoCfg M1 ${RUN}` });
    const { user, githubUsername } = await makeStudentWithGithub(klass.id, "m1");
    const a = await insertAssignment({
      class_id: klass.id,
      name: `M1 ${RUN}`,
      assignment_slug: `e2e-repocfg-m1-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "template_only_staff"
    });

    const { error } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: true
    });
    expect(error).toBeNull();

    const repoName = `${klass.slug}-${a.slug}-${githubUsername}`;
    const [args] = await findCreateRepoArgs(repoName);
    expect(args, `expected a create_repo message for ${repoName}`).toBeTruthy();
    expect(args.creationMethod ?? "template").toBe("template");
    expect(args.sourceRepo ?? args.templateRepo).toBe(TEST_HANDOUT_REPO);
    expect(args.branchProtection).toMatchObject({
      blockForcePush: true,
      requirePullRequest: false,
      requiredReviewers: 0
    });
  });

  test("T1: template_with_student_forks (mode 2) enqueues a FORK message with branch protection", async () => {
    const klass = await createClass({ name: `RepoCfg M2 ${RUN}` });
    const { user, githubUsername } = await makeStudentWithGithub(klass.id, "m2");
    const a = await insertAssignment({
      class_id: klass.id,
      name: `M2 ${RUN}`,
      assignment_slug: `e2e-repocfg-m2-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "template_with_student_forks",
      protect_block_force_push: true,
      protect_require_pull_request: true,
      protect_required_reviewers: 2
    });

    const { error } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: true
    });
    expect(error).toBeNull();

    const repoName = `${klass.slug}-${a.slug}-${githubUsername}`;
    const [args] = await findCreateRepoArgs(repoName);
    expect(args, `expected a create_repo message for ${repoName}`).toBeTruthy();
    expect(args.creationMethod).toBe("fork");
    expect(args.sourceRepo).toBe(TEST_HANDOUT_REPO);
    // protect_* must flow through to the worker message.
    expect(args.branchProtection).toMatchObject({
      blockForcePush: true,
      requirePullRequest: true,
      requiredReviewers: 2
    });
  });

  test("T2: fork_from_prior_assignment with no source repo skips (no message enqueued)", async () => {
    const klass = await createClass({ name: `RepoCfg M3miss ${RUN}` });
    const { user, githubUsername } = await makeStudentWithGithub(klass.id, "m3miss");

    // Source is a no_submission assignment, so create_repos_for_student never
    // creates a student repo on it — the target's fork-source lookup therefore
    // misses and must warn + skip rather than enqueue.
    const source = await insertAssignment({
      class_id: klass.id,
      name: `M3 source ${RUN}`,
      assignment_slug: `e2e-repocfg-m3src-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "no_submission"
    });
    const target = await insertAssignment({
      class_id: klass.id,
      name: `M3 target ${RUN}`,
      assignment_slug: `e2e-repocfg-m3tgt-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "fork_from_prior_assignment",
      source_assignment_id: source.id
    });

    const { error } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: true
    });
    // The RPC raises a WARNING and continues; it must not error.
    expect(error).toBeNull();

    // No source repo exists, so the mode-3 target must not enqueue anything.
    await expectNoCreateRepo(`${klass.slug}-${target.slug}-${githubUsername}`);
  });

  test("T4: force-recreate re-enqueues even when a repositories row already exists", async () => {
    const klass = await createClass({ name: `RepoCfg force ${RUN}` });
    const { user, githubUsername } = await makeStudentWithGithub(klass.id, "force");
    const a = await insertAssignment({
      class_id: klass.id,
      name: `Force ${RUN}`,
      assignment_slug: `e2e-repocfg-force-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "template_with_student_forks"
    });
    const repoName = `${klass.slug}-${a.slug}-${githubUsername}`;

    // First call (no force) creates the repositories row + enqueues.
    const { error: e0 } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: false
    });
    expect(e0).toBeNull();
    const first = await findCreateRepoArgs(repoName);
    expect(first[0], "first call should enqueue").toBeTruthy();

    // Second call (no force): the repositories row now exists → dedup → no msg.
    const { error: e1 } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: false
    });
    expect(e1).toBeNull();
    await expectNoCreateRepo(repoName);

    // With force: bypasses the dedup guard → message enqueued again.
    const { error: e2 } = await supabase.rpc("create_repos_for_student", {
      user_id: user.user_id,
      class_id: klass.id,
      p_force: true
    });
    expect(e2).toBeNull();
    const [args] = await findCreateRepoArgs(repoName);
    expect(args, "force=true should re-enqueue despite the existing repo row").toBeTruthy();
    expect(args.creationMethod).toBe("fork");
  });

  test("T3: group-change TRIGGER path is fork-aware for mode 2 (regression guard for S1)", async () => {
    const klass = await createClass({ name: `RepoCfg trigger ${RUN}` });
    const { user, githubUsername } = await makeStudentWithGithub(klass.id, "grp");

    // Released mode-2 GROUP assignment: editing membership fires
    // trigger_sync_repos_on_assignment_groups_members_change ->
    // create_all_repos_for_assignment_internal, which (after the S1 fix) must
    // enqueue a FORK, not a template-generate.
    const a = await insertAssignment({
      class_id: klass.id,
      name: `Trigger ${RUN}`,
      assignment_slug: `e2e-repocfg-trig-${SAFE}`,
      due_date: dueNextWeek(),
      release_date: releasedYesterday(),
      repo_mode: "template_with_student_forks",
      group_config: "groups",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: dueNextWeek(),
      protect_block_force_push: true,
      protect_require_pull_request: true,
      protect_required_reviewers: 1
    });

    const groupName = `trig${SAFE}`.toLowerCase();
    const { data: group, error: gErr } = await supabase
      .from("assignment_groups")
      .insert({ assignment_id: a.id, class_id: klass.id, name: groupName })
      .select("id")
      .single();
    expect(gErr).toBeNull();

    // Adding the member fires the trigger.
    const { error: mErr } = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: group!.id,
      assignment_id: a.id,
      class_id: klass.id,
      added_by: user.private_profile_id,
      profile_id: user.private_profile_id
    });
    expect(mErr).toBeNull();

    const repoName = `${klass.slug}-${a.slug}-group-${groupName}`;
    const [args] = await findCreateRepoArgs(repoName);
    expect(args, `trigger path should enqueue a fork for group repo ${repoName}`).toBeTruthy();
    expect(args.creationMethod).toBe("fork");
    expect(args.sourceRepo).toBe(TEST_HANDOUT_REPO);
    expect(args.branchProtection).toMatchObject({
      blockForcePush: true,
      requirePullRequest: true,
      requiredReviewers: 1
    });
  });
});
