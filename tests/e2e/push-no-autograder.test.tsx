import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, createUserInClass, getTestRunPrefix, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// E2E for the push-mode zero-runner submission path (P0 of the PR-submission
// epic). For a push-mode assignment with has_autograder=false, EVERY push must
// create a submission DIRECTLY from the github-repo-webhook handler — no
// repository_check_run, no grade.yml dispatch, no workflow_events — and ingest
// the repo's files via the shared SubmissionIngestion core.
//
// Note the `#submit` marker is NOT required on this path (#895): with no
// autograder there is no workflow to conserve, so a push is a submission on its
// own. `#NOT-GRADED` still works, and the due-date gate still applies.
//
// HOW THIS RUNS
// -------------
// The test drives the real `github-repo-webhook` edge function over HTTP. That
// function authenticates with the EVENTBRIDGE_SECRET header (it does NOT verify
// a GitHub HMAC signature — it consumes an already-parsed EventBridge envelope),
// so no signed-payload harness is needed. The file ingestion takes the
// E2E_MOCK_GITHUB canned-file fast path (createPushDirectSubmission), so no real
// GitHub clone happens.
//
// Required to run (orchestrator):
//   1. Local Supabase up (fresh DB) and Edge Functions served:
//        npx supabase functions serve --env-file .env.local
//   2. .env.local (or exported env) must contain, in addition to the usual
//      Supabase keys (SUPABASE_URL / SERVICE_ROLE / ANON):
//        E2E_MOCK_GITHUB=true        # take the canned-file fast path
//        EVENTBRIDGE_SECRET=<value>  # must match what `functions serve` sees;
//                                    # the test sends it as the Authorization header
//   3. Run just this file:
//        BASE_URL=http://localhost:3001 npx playwright test tests/e2e/push-no-autograder.test.tsx
//      (or, dev-mode iteration:  npm run test:e2e:local -- tests/e2e/push-no-autograder.test.tsx)
//
// If EVENTBRIDGE_SECRET is not set the webhook cannot be authenticated, so the
// HTTP-driven cases self-skip with a clear message rather than failing.

const FUNCTIONS_BASE = `${process.env.SUPABASE_URL?.replace(/\/$/, "")}/functions/v1`;
const EVENTBRIDGE_SECRET = process.env.EVENTBRIDGE_SECRET;
// E2E student-repo prefix recognized by the edge functions' E2E_MOCK_GITHUB path
// (mirrors END_TO_END_REPO_PREFIX in supabase/functions/_shared/GitHubWrapper.ts).
const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";

type PushDetail = {
  ref: string;
  after: string;
  repository: { full_name: string; id: number };
  pusher: { name: string };
  head_commit: { id: string; message: string; timestamp: string };
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
};

/** POST an EventBridge-style `push` envelope to the github-repo-webhook function. */
async function deliverPush(detail: PushDetail, deliveryId: string) {
  return await fetch(`${FUNCTIONS_BASE}/github-repo-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The function gate is: Authorization === EVENTBRIDGE_SECRET.
      Authorization: EVENTBRIDGE_SECRET ?? ""
    },
    body: JSON.stringify({
      id: deliveryId,
      "detail-type": "push",
      detail
    })
  });
}

function makePushDetail(repoName: string, sha: string, message: string): PushDetail {
  const ts = new Date().toISOString();
  return {
    ref: "refs/heads/main",
    after: sha,
    repository: { full_name: repoName, id: Math.floor(Math.random() * 1_000_000_000) },
    pusher: { name: "e2e-pusher" },
    head_commit: { id: sha, message, timestamp: ts },
    commits: [
      {
        id: sha,
        message,
        timestamp: ts,
        author: { name: "e2e-author" },
        added: ["Main.java"],
        removed: [],
        modified: []
      }
    ]
  };
}

test.describe.configure({ mode: "serial" });

test.describe("Push-mode zero-runner submission (has_autograder=false)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;
  let repoId: number;
  let repoName: string;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Push Zero-Runner ${RUN_PREFIX}` });
    classId = cls.id;

    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `Push Student ${RUN_PREFIX}`,
      email: `e2e-push-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Push Zero-Runner ${RUN_PREFIX}`,
      assignment_slug: `e2e-push-${SAFE_ID}`
    });
    assignmentId = a.id;

    // insertAssignment doesn't support submission_mode/has_autograder; set them
    // via service-role update (same pattern as pr-submission-mode.test.tsx).
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({ submission_mode: "push", has_autograder: false })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // A student repo whose name uses the E2E prefix so the webhook's
    // E2E_MOCK_GITHUB path writes a canned file instead of cloning GitHub.
    repoName = `${END_TO_END_REPO_PREFIX}--${SAFE_ID}`;
    const { data: repo, error: repoErr } = await supabase
      .from("repositories")
      .insert({
        assignment_id: assignmentId,
        repository: repoName,
        class_id: classId,
        profile_id: student.private_profile_id,
        synced_handout_sha: "none",
        is_github_ready: true
      })
      .select("id")
      .single();
    expect(repoErr).toBeNull();
    repoId = repo!.id;
  });

  test("DB precondition: assignment is push-mode with no autograder", async () => {
    const { data: a } = await supabase
      .from("assignments")
      .select("submission_mode, has_autograder")
      .eq("id", assignmentId)
      .single();
    expect(a!.submission_mode).toBe("push");
    expect(a!.has_autograder).toBe(false);
  });

  test("#submit push creates a submission directly with files and NO grade.yml dispatch", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `deadbeef${SAFE_ID}`.slice(0, 40);
    const res = await deliverPush(makePushDetail(repoName, sha, "Finish part 1 #submit"), `e2e-push-${SAFE_ID}-1`);
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    // A submission row was created directly from the webhook.
    const { data: subs, error: subsErr } = await supabase
      .from("submissions")
      .select("id, repository, sha, run_number, run_attempt, submitted_via, is_active, profile_id, class_id, ordinal")
      .eq("repository", repoName)
      .eq("sha", sha);
    expect(subsErr).toBeNull();
    expect(subs).toHaveLength(1);
    const sub = subs![0];
    expect(sub.run_number).toBe(0);
    expect(sub.run_attempt).toBe(0);
    expect(sub.submitted_via).toBe("git");
    expect(sub.profile_id).toBe(student.private_profile_id);
    expect(sub.class_id).toBe(classId);
    // ordinal/is_active are set by the BEFORE-INSERT trigger (not manually).
    expect(sub.is_active).toBe(true);
    expect(sub.ordinal).toBe(1);

    // Files were ingested (canned Main.java via the E2E mock path).
    const { data: files } = await supabase
      .from("submission_files")
      .select("name, is_binary, contents")
      .eq("submission_id", sub.id);
    expect(files && files.length).toBeGreaterThanOrEqual(1);
    expect(files!.some((f) => f.name === "Main.java")).toBe(true);

    // The after-insert hook provisioned a grading review.
    const { data: subWithReview } = await supabase
      .from("submissions")
      .select("grading_review_id")
      .eq("id", sub.id)
      .single();
    expect(subWithReview!.grading_review_id).not.toBeNull();

    // Zero-runner: NO repository_check_run and NO workflow_events / grade.yml
    // dispatch were created for this repo.
    const { data: checkRuns } = await supabase.from("repository_check_runs").select("id").eq("repository_id", repoId);
    expect(checkRuns ?? []).toHaveLength(0);

    const { data: wfEvents } = await supabase.from("workflow_events").select("id").eq("repository_name", repoName);
    expect(wfEvents ?? []).toHaveLength(0);
  });

  test("idempotent: re-delivering the same push does not create a duplicate submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `cafef00d${SAFE_ID}`.slice(0, 40);
    const detail = makePushDetail(repoName, sha, "Resubmit #submit");

    const r1 = await deliverPush(detail, `e2e-push-${SAFE_ID}-2a`);
    expect(r1.status).toBe(200);
    // Distinct delivery id so the webhook-level Redis de-dup doesn't short-circuit;
    // the DB-level repository+sha guard in createPushDirectSubmission is what must hold.
    const r2 = await deliverPush(detail, `e2e-push-${SAFE_ID}-2b`);
    expect(r2.status).toBe(200);

    const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
    expect(subs).toHaveLength(1);
  });

  // #895: with no autograder there are no runner minutes to conserve, so EVERY
  // push is a submission — requiring #submit would mean students who never
  // learned the convention appear to have submitted nothing.
  test("push with NO #submit marker still creates a submission with files", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `0badf00d${SAFE_ID}`.slice(0, 40);
    const res = await deliverPush(makePushDetail(repoName, sha, "WIP, no marker at all"), `e2e-push-${SAFE_ID}-3`);
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    const { data: subs } = await supabase
      .from("submissions")
      .select("id, submitted_via, is_not_graded")
      .eq("repository", repoName)
      .eq("sha", sha);
    expect(subs).toHaveLength(1);
    expect(subs![0].submitted_via).toBe("git");
    // No #NOT-GRADED in the message, so this is a graded submission.
    expect(subs![0].is_not_graded).toBe(false);

    const { data: files } = await supabase.from("submission_files").select("name").eq("submission_id", subs![0].id);
    expect(files!.some((f) => f.name === "Main.java")).toBe(true);

    // Still zero-runner: no check run and no grade.yml dispatch.
    const { data: checkRuns } = await supabase.from("repository_check_runs").select("id").eq("repository_id", repoId);
    expect(checkRuns ?? []).toHaveLength(0);
    const { data: wfEvents } = await supabase.from("workflow_events").select("id").eq("repository_name", repoName);
    expect(wfEvents ?? []).toHaveLength(0);
  });

  test("successive pushes accumulate submissions, newest is active", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const shaA = `11111111${SAFE_ID}`.slice(0, 40);
    const shaB = `22222222${SAFE_ID}`.slice(0, 40);

    const r1 = await deliverPush(makePushDetail(repoName, shaA, "first pass"), `e2e-push-${SAFE_ID}-4a`);
    expect(r1.status).toBe(200);
    const r2 = await deliverPush(makePushDetail(repoName, shaB, "second pass"), `e2e-push-${SAFE_ID}-4b`);
    expect(r2.status).toBe(200);

    const { data: subs } = await supabase
      .from("submissions")
      .select("id, sha, is_active, ordinal")
      .in("sha", [shaA, shaB])
      .eq("repository", repoName)
      .order("ordinal", { ascending: true });
    expect(subs).toHaveLength(2);
    // The submissions BEFORE-INSERT trigger owns ordinal/is_active: only the
    // latest push is active.
    const [first, second] = subs!;
    expect(first.sha).toBe(shaA);
    expect(second.sha).toBe(shaB);
    expect(first.is_active).toBe(false);
    expect(second.is_active).toBe(true);
    expect(second.ordinal).toBeGreaterThan(first.ordinal);
  });

  // Handout syncs land on the student repo's default branch too. Now that every
  // push is a submission, an instructor pushing a handout update must NOT become
  // the student's newest "submission" — that would be work they never did.
  test("auto-merged handout-sync PR push creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `33333333${SAFE_ID}`.slice(0, 40);
    const detail = makePushDetail(
      repoName,
      sha,
      "Merge pull request #7 from pawtograder-playground/sync-to-abc1234\n\n[Instructor Update] Sync handout to abc1234"
    );
    const res = await deliverPush(detail, `e2e-push-${SAFE_ID}-5`);
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
    expect(subs ?? []).toHaveLength(0);
  });

  test("fork fast-forward to the handout's head sha creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    // A fork_merge_upstream sync leaves the student repo's head at exactly the
    // handout's head commit, with no distinguishing commit message.
    const handoutSha = `44444444${SAFE_ID}`.slice(0, 40);
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({ latest_template_sha: handoutSha })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // try/finally, not a trailing statement: these tests run serially against one
    // assignment and repo, so a restore skipped by a failed assertion leaves the next
    // test asserting "no submission" against still-mutated state, where it passes
    // vacuously and hides whatever broke.
    try {
      const res = await deliverPush(makePushDetail(repoName, handoutSha, "Add starter files"), `e2e-push-${SAFE_ID}-6`);
      expect(res.status, await res.text().catch(() => "")).toBe(200);

      await new Promise((r) => setTimeout(r, 1500));
      const { data: subs } = await supabase
        .from("submissions")
        .select("id")
        .eq("repository", repoName)
        .eq("sha", handoutSha);
      expect(subs ?? []).toHaveLength(0);
    } finally {
      await supabase.from("assignments").update({ latest_template_sha: null }).eq("id", assignmentId);
    }
  });

  // The `repositories` row is inserted before createRepo runs, so GitHub's initial
  // push for a freshly generated repo can arrive while is_github_ready is still
  // false. That push is the starter template, not student work.
  test("push to a repo still being provisioned creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const { error: notReadyErr } = await supabase
      .from("repositories")
      .update({ is_github_ready: false })
      .eq("id", repoId);
    expect(notReadyErr).toBeNull();

    const sha = `55555555${SAFE_ID}`.slice(0, 40);
    try {
      const res = await deliverPush(
        makePushDetail(repoName, sha, "Initial commit from template"),
        `e2e-push-${SAFE_ID}-7`
      );
      expect(res.status, await res.text().catch(() => "")).toBe(200);

      await new Promise((r) => setTimeout(r, 1500));
      const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
      expect(subs ?? []).toHaveLength(0);
    } finally {
      // Restored even on failure: leaving the repo unready would make the next test's
      // "no submission" assertion pass for the wrong reason.
      await supabase.from("repositories").update({ is_github_ready: true }).eq("id", repoId);
    }
  });

  // Switching an assignment to a no-repo mode coerces has_autograder=false but
  // leaves the old repositories rows behind; a later push to one of those must not
  // become a git submission for an upload-only assignment.
  test("push to a stale repo after switching to repo_mode='none' creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    // The protect_* fields must be cleared in the SAME update: the
    // assignments_no_protection_when_no_repo constraint rejects a no-repo mode while
    // any branch protection is still set, and insertAssignment leaves
    // protect_block_force_push at its column default of true. (This mirrors what the
    // edit page coerces for exactly this reason.)
    const { error: modeErr } = await supabase
      .from("assignments")
      .update({
        repo_mode: "none",
        protect_block_force_push: false,
        protect_require_pull_request: false,
        protect_required_reviewers: 0
      })
      .eq("id", assignmentId);
    expect(modeErr).toBeNull();

    const sha = `66666666${SAFE_ID}`.slice(0, 40);
    try {
      const res = await deliverPush(
        makePushDetail(repoName, sha, "still pushing to my old repo"),
        `e2e-push-${SAFE_ID}-8`
      );
      expect(res.status, await res.text().catch(() => "")).toBe(200);

      await new Promise((r) => setTimeout(r, 1500));
      const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
      expect(subs ?? []).toHaveLength(0);
    } finally {
      // Restore the repo mode first, then the protection default — the reverse order
      // would trip the same constraint on the way back.
      await supabase.from("assignments").update({ repo_mode: "template_only_staff" }).eq("id", assignmentId);
      await supabase.from("assignments").update({ protect_block_force_push: true }).eq("id", assignmentId);
    }
  });
});

// pr-mode push guard: a push to a tracked student repo whose assignment is
// submission_mode='pr' must be a no-op in the push handler. The PR webhook owns
// submissions in that mode, so the push must NOT create a submission, a
// repository_check_run, or workflow_events (no grade.yml dispatch).
test.describe("Push to a pr-mode repo is a no-op (no submission / check run / workflow)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;
  let repoId: number;
  let repoName: string;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR-mode Push Guard ${RUN_PREFIX}` });
    classId = cls.id;

    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Guard Student ${RUN_PREFIX}`,
      email: `e2e-prguard-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR-mode Push Guard ${RUN_PREFIX}`,
      assignment_slug: `e2e-prguard-${SAFE_ID}`
    });
    assignmentId = a.id;

    // pr-mode assignment. (has_autograder is irrelevant: the pr-mode guard
    // returns before the zero-runner branch is even considered.)
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({ submission_mode: "pr", upstream_repo: `pawtograder-playground/prguard-upstream-${SAFE_ID}` })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // A tracked student repo for this pr-mode assignment (the fork). Use the E2E
    // prefix only so that IF the guard regressed and ingestion ran, it would
    // still avoid a real clone; the assertions below require it does NOT run.
    repoName = `${END_TO_END_REPO_PREFIX}--prguard-${SAFE_ID}`;
    const { data: repo, error: repoErr } = await supabase
      .from("repositories")
      .insert({
        assignment_id: assignmentId,
        repository: repoName,
        class_id: classId,
        profile_id: student.private_profile_id,
        synced_handout_sha: "none",
        is_github_ready: true
      })
      .select("id")
      .single();
    expect(repoErr).toBeNull();
    repoId = repo!.id;
  });

  test("DB precondition: assignment is pr-mode", async () => {
    const { data: a } = await supabase.from("assignments").select("submission_mode").eq("id", assignmentId).single();
    expect(a!.submission_mode).toBe("pr");
  });

  test("#submit push to a pr-mode fork creates NO submission, NO check run, NO workflow events", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `aa11bb22${SAFE_ID}`.slice(0, 40);
    // Even a #submit message must be ignored on the push side in pr-mode.
    const res = await deliverPush(makePushDetail(repoName, sha, "Done #submit"), `e2e-prguard-${SAFE_ID}-1`);
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    // Give the handler a beat, then assert the guard produced nothing.
    await new Promise((r) => setTimeout(r, 1500));

    const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
    expect(subs ?? []).toHaveLength(0);

    const { data: checkRuns } = await supabase.from("repository_check_runs").select("id").eq("repository_id", repoId);
    expect(checkRuns ?? []).toHaveLength(0);

    const { data: wfEvents } = await supabase.from("workflow_events").select("id").eq("repository_name", repoName);
    expect(wfEvents ?? []).toHaveLength(0);
  });
});

// Server-time due-date gate: createPushDirectSubmission gates on the webhook
// RECEIVE time (server now()), not head_commit.timestamp. A commit whose
// timestamp is in the future (student-controllable via `git commit --date=...`)
// pushed to a past-due assignment must NOT create a submission.
test.describe("Push-direct submission honors the server-time due-date gate", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;
  let repoName: string;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Push Due-Date ${RUN_PREFIX}` });
    classId = cls.id;

    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `Push Due Student ${RUN_PREFIX}`,
      email: `e2e-pushdue-${SAFE_ID}@pawtograder.net`
    });

    // Due in the PAST. allow_not_graded_submissions defaults false, so even a
    // graded #submit after the deadline must be rejected.
    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -2).toISOString(),
      release_date: addDays(new Date(), -7).toUTCString(),
      name: `Push Due-Date ${RUN_PREFIX}`,
      assignment_slug: `e2e-pushdue-${SAFE_ID}`
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({ submission_mode: "push", has_autograder: false })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    repoName = `${END_TO_END_REPO_PREFIX}--pushdue-${SAFE_ID}`;
    const { error: repoErr } = await supabase.from("repositories").insert({
      assignment_id: assignmentId,
      repository: repoName,
      class_id: classId,
      profile_id: student.private_profile_id,
      synced_handout_sha: "none",
      is_github_ready: true
    });
    expect(repoErr).toBeNull();
  });

  test("#submit push with a FUTURE commit timestamp on a past-due assignment creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `f00dface${SAFE_ID}`.slice(0, 40);
    // Build a push whose head_commit.timestamp is far in the FUTURE. If the gate
    // (wrongly) trusted the commit ts, this would slip through; it must not.
    const detail = makePushDetail(repoName, sha, "Late but backdated #submit");
    const futureTs = addDays(new Date(), 30).toISOString();
    detail.head_commit.timestamp = futureTs;
    detail.commits[0].timestamp = futureTs;

    const res = await deliverPush(detail, `e2e-pushdue-${SAFE_ID}-1`);
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase.from("submissions").select("id").eq("repository", repoName).eq("sha", sha);
    expect(subs ?? []).toHaveLength(0);
  });
});

// 23514 group-transition: when a student has joined an assignment group, the
// submissions BEFORE-INSERT trigger rejects an INDIVIDUAL submission with
// check_violation (SQLSTATE 23514). createPushDirectSubmission must catch that
// and skip gracefully (no submission, webhook still returns 200) -- the group
// repo's push handles submissions instead.
test.describe("Push-direct submission skips gracefully on the group-transition 23514", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classId: number;
  let instructor: TestingUser;
  let student: TestingUser;
  let assignmentId: number;
  let individualRepoName: string;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Push Group-Transition ${RUN_PREFIX}` });
    classId = cls.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `Push GT Instructor ${RUN_PREFIX}`,
      email: `e2e-pushgt-instr-${SAFE_ID}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `Push GT Student ${RUN_PREFIX}`,
      email: `e2e-pushgt-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Push Group-Transition ${RUN_PREFIX}`,
      assignment_slug: `e2e-pushgt-${SAFE_ID}`,
      group_config: "both"
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({ submission_mode: "push", has_autograder: false })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // The student's INDIVIDUAL repo (profile_id set, no assignment_group_id).
    individualRepoName = `${END_TO_END_REPO_PREFIX}--pushgt-indiv-${SAFE_ID}`;
    const { error: repoErr } = await supabase.from("repositories").insert({
      assignment_id: assignmentId,
      repository: individualRepoName,
      class_id: classId,
      profile_id: student.private_profile_id,
      synced_handout_sha: "none",
      is_github_ready: true
    });
    expect(repoErr).toBeNull();

    // Put the student in a group for this assignment. With an active group
    // membership, the submissions insert trigger raises 23514 for an INDIVIDUAL
    // submission insert.
    const { data: group, error: groupErr } = await supabase
      .from("assignment_groups")
      .insert({ name: `Push GT Group ${RUN_PREFIX}`, class_id: classId, assignment_id: assignmentId })
      .select("id")
      .single();
    expect(groupErr).toBeNull();
    const { error: memberErr } = await supabase.from("assignment_groups_members").insert({
      assignment_group_id: group!.id,
      profile_id: student.private_profile_id,
      assignment_id: assignmentId,
      class_id: classId,
      added_by: instructor.private_profile_id
    });
    expect(memberErr).toBeNull();
  });

  test("#submit push to the INDIVIDUAL repo of a now-grouped student creates NO submission and returns ok", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `beadfeed${SAFE_ID}`.slice(0, 40);
    const res = await deliverPush(
      makePushDetail(individualRepoName, sha, "Submit from my individual repo #submit"),
      `e2e-pushgt-${SAFE_ID}-1`
    );
    // The 23514 is caught and skipped: the webhook must still succeed (no 500).
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("repository", individualRepoName)
      .eq("sha", sha);
    expect(subs ?? []).toHaveLength(0);
  });
});
