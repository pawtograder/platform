import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "./TestingUtils";
import type { TestingUser } from "./TestingUtils";

// E2E for github_deployments ingestion driven through the REAL
// github-repo-webhook edge function (the webhook → eventHandler.on(
// "deployment_status") → class-resolution → upsert_github_deployment path).
// deployments-ingestion.test.tsx exercises the RPC + RLS directly against the
// DB; THIS file closes the "no webhook→deployment e2e" gap by POSTing a real
// EventBridge `deployment_status` envelope and asserting the handler attributes
// the deployment to a class via each resolution path.
//
// HOW THIS RUNS
// -------------
// Like push-no-autograder.test.tsx, the test drives the webhook over HTTP. That
// function authenticates with the EVENTBRIDGE_SECRET header (it consumes an
// already-parsed EventBridge envelope; no GitHub HMAC). The deployment handler
// touches no GitHub APIs, so no E2E_MOCK_GITHUB clone path is involved.
//
// Required to run (orchestrator):
//   1. Local Supabase up (fresh DB) and Edge Functions served:
//        npx supabase functions serve --env-file .env.local
//   2. .env.local (or exported env) must contain, in addition to the usual
//      Supabase keys (SUPABASE_URL / SERVICE_ROLE / ANON):
//        EVENTBRIDGE_SECRET=<value>  # must match what `functions serve` sees;
//                                    # the test sends it as the Authorization header
//   3. Run just this file:
//        BASE_URL=http://localhost:3001 npx playwright test tests/e2e/deployment-status-webhook.test.tsx
//      (or, dev-mode iteration:  npm run test:e2e:local -- tests/e2e/deployment-status-webhook.test.tsx)
//
// If EVENTBRIDGE_SECRET is not set the webhook cannot be authenticated, so the
// HTTP-driven cases self-skip with a clear message rather than failing.

const FUNCTIONS_BASE = `${process.env.SUPABASE_URL?.replace(/\/$/, "")}/functions/v1`;
const EVENTBRIDGE_SECRET = process.env.EVENTBRIDGE_SECRET;

// Minimal `deployment_status` payload shape — only the fields the handler reads
// (grep eventHandler.on("deployment_status") in github-repo-webhook/index.ts):
//   repository.full_name
//   deployment.{ sha, environment, id, creator.login }
//   deployment_status.{ environment, state, target_url, log_url, id }
type DeploymentStatusDetail = {
  repository: { full_name: string; id: number };
  deployment: {
    id: number;
    sha: string;
    environment: string;
    creator: { login: string };
  };
  deployment_status: {
    id: number;
    state: string;
    environment: string;
    target_url: string;
    log_url: string;
  };
};

/** POST an EventBridge-style `deployment_status` envelope to github-repo-webhook. */
async function deliverDeploymentStatus(detail: DeploymentStatusDetail, deliveryId: string) {
  return await fetch(`${FUNCTIONS_BASE}/github-repo-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The function gate is: Authorization === EVENTBRIDGE_SECRET.
      Authorization: EVENTBRIDGE_SECRET ?? ""
    },
    body: JSON.stringify({
      id: deliveryId,
      "detail-type": "deployment_status",
      detail
    })
  });
}

/** Poll github_deployments for a row keyed on the github_deployment_id we sent. */
async function waitForDeployment(githubDeploymentId: number, classId: number) {
  for (let i = 0; i < 20; i++) {
    const { data } = await supabase
      .from("github_deployments")
      .select("id, repository_id, class_id, repository_name, sha, environment, state")
      .eq("class_id", classId)
      .eq("github_deployment_id", githubDeploymentId)
      .maybeSingle();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test.describe.configure({ mode: "serial" });

test.describe("deployment_status webhook ingestion (webhook → github_deployments)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // A fork/shared-project repo that is NOT in `repositories` — its deployment
  // resolves its class via a matching submission's (repository, head_sha) (Path 3).
  const FORK_REPO = `some-fork/dep-wh-${SAFE_ID}`;
  const FORK_SHA = `forkhead${SAFE_ID}`;
  // An unattributable repo: not tracked and no matching submission (skip path).
  const UNRELATED_REPO = `unrelated/dep-wh-${SAFE_ID}`;

  // Distinct github deployment/status ids per case so assertions are scoped.
  const BASE_GH_ID = Number(`${Date.now()}`.slice(-9));
  const trackedDeploymentGhId = BASE_GH_ID + 1;
  const trackedStatusGhId = trackedDeploymentGhId + 1000;
  const forkDeploymentGhId = BASE_GH_ID + 2;
  const forkStatusGhId = forkDeploymentGhId + 1000;
  const unrelatedDeploymentGhId = BASE_GH_ID + 3;
  const unrelatedStatusGhId = unrelatedDeploymentGhId + 1000;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;
  // The student's tracked repo (Path 1) + their submission used for Path 3.
  let trackedRepoId: number;
  let trackedRepoName: string;
  let studentSubmissionId: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E Deployment WH ${RUN_PREFIX}` });
    classId = cls.id;

    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `Dep WH Student ${RUN_PREFIX}`,
      email: `e2e-dep-wh-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Dep WH assignment ${RUN_PREFIX}`,
      assignment_slug: `e2e-dep-wh-${SAFE_ID}`
    });
    assignmentId = a.id;

    // A real submission + tracked repository for the student. Gives us:
    //   * trackedRepoId  -> Path 1 (deployment for a tracked repo)
    //   * the submission's (repository, head_sha) -> Path 3 (fork match)
    const prebaked = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignmentId,
      class_id: classId,
      repositorySuffix: `dep-wh-${SAFE_ID}`
    });
    studentSubmissionId = prebaked.submission_id;
    trackedRepoName = prebaked.repository_name;

    const { data: repoRow, error: repoErr } = await supabase
      .from("repositories")
      .select("id")
      .eq("repository", trackedRepoName)
      .single();
    expect(repoErr).toBeNull();
    trackedRepoId = repoRow!.id;

    // Point the student's submission at the fork repo+sha so Path 3 (match by
    // (repository, head_sha)) has something to resolve. submitted_via='pr' to
    // reflect a PR-mode submission; keep it active.
    const { error: subUpdErr } = await supabase
      .from("submissions")
      .update({ repository: FORK_REPO, head_sha: FORK_SHA, sha: FORK_SHA, submitted_via: "pr" })
      .eq("id", studentSubmissionId);
    expect(subUpdErr).toBeNull();
  });

  function makeDeploymentStatusDetail(
    repoName: string,
    sha: string,
    deploymentGhId: number,
    statusGhId: number,
    overrides?: { environment?: string; state?: string }
  ): DeploymentStatusDetail {
    const environment = overrides?.environment ?? "production";
    return {
      repository: { full_name: repoName, id: Math.floor(Math.random() * 1_000_000_000) },
      deployment: {
        id: deploymentGhId,
        sha,
        environment,
        creator: { login: "octocat" }
      },
      deployment_status: {
        id: statusGhId,
        state: overrides?.state ?? "success",
        environment,
        target_url: `https://example.com/${repoName}`,
        log_url: `https://example.com/${repoName}/logs`
      }
    };
  }

  test("Path 1: a deployment_status for a tracked repo records a row with repository_id + class resolved", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");

    const res = await deliverDeploymentStatus(
      makeDeploymentStatusDetail(trackedRepoName, "tracked-sha-wh-1", trackedDeploymentGhId, trackedStatusGhId),
      `dep-wh-tracked-${SAFE_ID}`
    );
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    const row = await waitForDeployment(trackedDeploymentGhId, classId);
    expect(row).not.toBeNull();
    expect(row!.repository_id).toBe(trackedRepoId);
    expect(row!.class_id).toBe(classId);
    expect(row!.repository_name).toBe(trackedRepoName);
    expect(row!.sha).toBe("tracked-sha-wh-1");
    expect(row!.environment).toBe("production");
    expect(row!.state).toBe("success");
  });

  test("Path 3: a deployment_status for a fork repo resolves the class via a matching submission (repository_id NULL)", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");

    // The fork repo is NOT in `repositories`, but FORK_SHA matches the student's
    // submission head_sha -> the handler resolves the class through the submission.
    const res = await deliverDeploymentStatus(
      makeDeploymentStatusDetail(FORK_REPO, FORK_SHA, forkDeploymentGhId, forkStatusGhId, { environment: "preview" }),
      `dep-wh-fork-${SAFE_ID}`
    );
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    const row = await waitForDeployment(forkDeploymentGhId, classId);
    expect(row).not.toBeNull();
    expect(row!.repository_id).toBeNull();
    expect(row!.class_id).toBe(classId);
    expect(row!.repository_name).toBe(FORK_REPO);
    expect(row!.sha).toBe(FORK_SHA);
    expect(row!.environment).toBe("preview");
  });

  test("Skip: a deployment_status for an unattributable repo records NO row", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");

    // Not tracked, and its sha matches no submission -> the handler returns
    // without writing (classId stays null). The webhook still returns ok.
    const res = await deliverDeploymentStatus(
      makeDeploymentStatusDetail(UNRELATED_REPO, `nomatch-${SAFE_ID}`, unrelatedDeploymentGhId, unrelatedStatusGhId),
      `dep-wh-unrelated-${SAFE_ID}`
    );
    expect(res.status, await res.text().catch(() => "")).toBe(200);

    // Give the (no-op) handler a beat, then assert no row landed for this id in
    // ANY class — an unattributable deployment must not be recorded.
    await new Promise((r) => setTimeout(r, 1500));
    const { data: anyRow } = await supabase
      .from("github_deployments")
      .select("id")
      .eq("github_deployment_id", unrelatedDeploymentGhId);
    expect(anyRow ?? []).toHaveLength(0);
  });
});
