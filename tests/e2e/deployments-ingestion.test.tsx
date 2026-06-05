import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// Tests for the github_deployments read-only data layer (PR-submission-mode
// Phase 4, P1-backend), exercised directly against the DB:
//   * RLS: staff read all deployments in their class; a student reads only
//     deployments tied to their own repository OR their own submission (matched
//     by head_sha, the fork/shared-project case); a student in another class
//     reads none.
//   * upsert_github_deployment idempotency: a re-delivered
//     (github_deployment_id, github_deployment_status_id) updates the existing
//     row's mutable fields instead of inserting a duplicate.
//
async function upsertDeployment(args: Database["public"]["Functions"]["upsert_github_deployment"]["Args"]) {
  return supabase.rpc("upsert_github_deployment", args);
}

async function readDeploymentsForClass(client: SupabaseClient<Database>, classId: number) {
  return client.from("github_deployments").select("*").eq("class_id", classId).order("id");
}

test.describe.configure({ mode: "serial" });

test.describe("github_deployments ingestion + RLS", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // A fork/shared-project repo that is NOT in `repositories` — the deployment
  // for it resolves its class via a matching submission head_sha (Path 3).
  const FORK_REPO = `some-fork/pr-deploy-${SAFE_ID}`;
  const FORK_SHA = `forkhead${SAFE_ID}`;

  let classAId: number;
  let classBId: number;
  let instructorA: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let assignmentId: number;
  // studentA's tracked repo (Path 2) + their submission used for Path 3.
  let trackedRepoId: number;
  let trackedRepoName: string;
  let studentASubmissionId: number;

  // Deployment ids we create, to scope assertions to this test run.
  const trackedDeploymentGhId = Number(`${Date.now()}`.slice(-9)) + 1; // unique-ish
  const trackedStatusGhId = trackedDeploymentGhId + 1000;
  const forkDeploymentGhId = trackedDeploymentGhId + 2;
  const forkStatusGhId = trackedDeploymentGhId + 2000;
  const unrelatedDeploymentGhId = trackedDeploymentGhId + 4;
  const unrelatedStatusGhId = trackedDeploymentGhId + 4000;

  test.beforeAll(async () => {
    const clsA = await createClass({ name: `E2E Deployments A ${RUN_PREFIX}` });
    classAId = clsA.id;
    const clsB = await createClass({ name: `E2E Deployments B ${RUN_PREFIX}` });
    classBId = clsB.id;

    instructorA = await createUserInClass({
      role: "instructor",
      class_id: classAId,
      name: `Dep Instructor A ${RUN_PREFIX}`,
      email: `e2e-dep-instr-a-${SAFE_ID}@pawtograder.net`
    });
    studentA = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `Dep Student A ${RUN_PREFIX}`,
      email: `e2e-dep-a-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classBId,
      name: `Dep Student B ${RUN_PREFIX}`,
      email: `e2e-dep-b-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classAId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Dep assignment ${RUN_PREFIX}`,
      assignment_slug: `e2e-dep-${SAFE_ID}`
    });
    assignmentId = a.id;

    // A real submission + tracked repository for studentA. Gives us:
    //   * trackedRepoId  -> deployment with repository_id set (Path 2)
    //   * the submission's head_sha -> fork deployment match (Path 3)
    const prebaked = await insertPreBakedSubmission({
      student_profile_id: studentA.private_profile_id,
      assignment_id: assignmentId,
      class_id: classAId,
      repositorySuffix: `dep-${SAFE_ID}`
    });
    studentASubmissionId = prebaked.submission_id;
    trackedRepoName = prebaked.repository_name;

    const { data: repoRow, error: repoErr } = await supabase
      .from("repositories")
      .select("id")
      .eq("repository", trackedRepoName)
      .single();
    expect(repoErr).toBeNull();
    trackedRepoId = repoRow!.id;

    // Point studentA's submission at the fork repo+sha so Path 3 (match by
    // (repository, head_sha)) has something to resolve. submitted_via='pr' to
    // reflect a PR-mode submission. We keep this submission active.
    const { error: subUpdErr } = await supabase
      .from("submissions")
      .update({ repository: FORK_REPO, head_sha: FORK_SHA, sha: FORK_SHA, submitted_via: "pr" })
      .eq("id", studentASubmissionId);
    expect(subUpdErr).toBeNull();
  });

  test("ingestion records a deployment for a tracked repo (Path 2 fixture)", async () => {
    const { data: id, error } = await upsertDeployment({
      p_class_id: classAId,
      p_repository_name: trackedRepoName,
      p_repository_id: trackedRepoId,
      p_sha: "tracked-sha-1",
      p_environment: "production",
      p_state: "success",
      p_target_url: "https://example.com/tracked",
      p_github_deployment_id: trackedDeploymentGhId,
      p_github_deployment_status_id: trackedStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "tracked" }
    });
    expect(error).toBeNull();
    expect(typeof id).toBe("number");
  });

  test("ingestion records a fork/shared-project deployment with NULL repository_id (Path 3 fixture)", async () => {
    const { data: id, error } = await upsertDeployment({
      p_class_id: classAId,
      p_repository_name: FORK_REPO,
      p_repository_id: undefined, // not in `repositories`
      p_sha: FORK_SHA,
      p_environment: "preview",
      p_state: "success",
      p_target_url: "https://example.com/fork",
      p_github_deployment_id: forkDeploymentGhId,
      p_github_deployment_status_id: forkStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "fork" }
    });
    expect(error).toBeNull();
    expect(typeof id).toBe("number");

    const { data, error: readErr } = await readDeploymentsForClass(supabase, classAId);
    expect(readErr).toBeNull();
    const forkRow = (data ?? []).find((d) => d.github_deployment_id === forkDeploymentGhId);
    expect(forkRow).toBeTruthy();
    expect(forkRow!.repository_id).toBeNull();
    expect(forkRow!.repository_name).toBe(FORK_REPO);
    expect(forkRow!.sha).toBe(FORK_SHA);
  });

  test("ingestion records an unrelated deployment (visible to staff, not to the student)", async () => {
    const { error } = await upsertDeployment({
      p_class_id: classAId,
      p_repository_name: `unrelated/repo-${SAFE_ID}`,
      p_repository_id: undefined,
      p_sha: "unrelated-sha",
      p_environment: "production",
      p_state: "success",
      p_target_url: "https://example.com/unrelated",
      p_github_deployment_id: unrelatedDeploymentGhId,
      p_github_deployment_status_id: unrelatedStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "unrelated" }
    });
    expect(error).toBeNull();
  });

  test("idempotency: re-delivering the same (deployment_id, status_id) updates in place, no duplicate", async () => {
    const before = await readDeploymentsForClass(supabase, classAId);
    const beforeCount = (before.data ?? []).length;

    // Re-deliver the tracked deployment with a changed state + target_url.
    const { data: id, error } = await upsertDeployment({
      p_class_id: classAId,
      p_repository_name: trackedRepoName,
      p_repository_id: trackedRepoId,
      p_sha: "tracked-sha-1",
      p_environment: "production",
      p_state: "error", // changed
      p_target_url: "https://example.com/tracked-v2", // changed
      p_github_deployment_id: trackedDeploymentGhId,
      p_github_deployment_status_id: trackedStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "tracked-v2" }
    });
    expect(error).toBeNull();
    expect(typeof id).toBe("number");

    const after = await readDeploymentsForClass(supabase, classAId);
    expect((after.data ?? []).length).toBe(beforeCount); // no new row

    const row = (after.data ?? []).find((d) => d.github_deployment_id === trackedDeploymentGhId);
    expect(row).toBeTruthy();
    expect(row!.state).toBe("error");
    expect(row!.target_url).toBe("https://example.com/tracked-v2");
  });

  test("RLS: staff (instructor) can read every deployment in their class", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { data, error } = await readDeploymentsForClass(instructorClient, classAId);
    expect(error).toBeNull();
    const ghIds = (data ?? []).map((d) => d.github_deployment_id);
    expect(ghIds).toContain(trackedDeploymentGhId);
    expect(ghIds).toContain(forkDeploymentGhId);
    expect(ghIds).toContain(unrelatedDeploymentGhId);
  });

  test("RLS: a student reads deployments tied to their own repo (Path 2) and submission head_sha (Path 3), but not unrelated ones", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { data, error } = await readDeploymentsForClass(studentClient, classAId);
    expect(error).toBeNull();
    const ghIds = (data ?? []).map((d) => d.github_deployment_id);

    // Path 2: deployment for studentA's tracked repository.
    expect(ghIds).toContain(trackedDeploymentGhId);
    // Path 3: fork deployment matched to studentA's submission by head_sha.
    expect(ghIds).toContain(forkDeploymentGhId);
    // The unrelated deployment is NOT tied to the student -> not visible.
    expect(ghIds).not.toContain(unrelatedDeploymentGhId);
  });

  test("RLS: a student in another class reads no deployments from this class", async () => {
    const studentClient = await createAuthenticatedClient(studentB);
    const { data, error } = await readDeploymentsForClass(studentClient, classAId);
    // Either an empty result or an error is acceptable; the invariant is that
    // none of class A's deployments leak to a student in class B.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
