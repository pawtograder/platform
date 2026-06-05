import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// E2E for the push-mode zero-runner submission path (P0 of the PR-submission
// epic). For a push-mode assignment with has_autograder=false, a `#submit` push
// must create a submission DIRECTLY from the github-repo-webhook handler — no
// repository_check_run, no grade.yml dispatch, no workflow_events — and ingest
// the repo's files via the shared SubmissionIngestion core.
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
    repoName = `${END_TO_END_REPO_PREFIX}-${SAFE_ID}`;
    const { data: repo, error: repoErr } = await supabase
      .from("repositories")
      .insert({
        assignment_id: assignmentId,
        repository: repoName,
        class_id: classId,
        profile_id: student.private_profile_id,
        synced_handout_sha: "none"
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
    const { data: checkRuns } = await supabase
      .from("repository_check_runs")
      .select("id")
      .eq("repository_id", repoId);
    expect(checkRuns ?? []).toHaveLength(0);

    const { data: wfEvents } = await supabase
      .from("workflow_events")
      .select("id")
      .eq("repository_name", repoName);
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

    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("repository", repoName)
      .eq("sha", sha);
    expect(subs).toHaveLength(1);
  });

  test("non-#submit push to a push-mode no-autograder repo creates NO submission", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const sha = `0badf00d${SAFE_ID}`.slice(0, 40);
    const res = await deliverPush(makePushDetail(repoName, sha, "WIP, not submitting yet"), `e2e-push-${SAFE_ID}-3`);
    expect(res.status).toBe(200);

    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("repository", repoName)
      .eq("sha", sha);
    expect(subs ?? []).toHaveLength(0);
  });
});
