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

// Data-layer tests for the Phase-4 read-only PR-submission surfaces (the
// Checks and Deployments subpages). These exercise the exact queries the UI
// runs, under the exact RLS the UI runs them under:
//
//   * Checks subpage -> get_submission_checks(submission_id): returns the
//     workflow_events whose head_sha matches the submission's head_sha (incl.
//     runs on a fork repo not in `repositories`). The submission owner and class
//     staff can read them; a student in another class cannot read the submission
//     at all, so the SECURITY INVOKER RPC yields nothing for them.
//   * Deployments subpage -> github_deployments filtered by
//     (repository_name = submission.repository AND sha = coalesce(head_sha, sha)):
//     the owner + staff read their deployment; an unrelated student does not.
//
// The UI-render layer is thin (a Chakra table + empty state) over these queries,
// so we assert at the data/RLS layer here — the same approach as
// deployments-ingestion.test.tsx and pr-submission-mode.test.tsx.
//
// NOTE(orchestrator): `github_deployments` (table) and `upsert_github_deployment`
// / `get_submission_checks` (RPCs) are added by migration 20260606000000 and are
// NOT yet in the generated Database type. Every access below goes through a small
// typed alias cast; drop these casts after `npm run client-local` regenerates the
// types (mirrors the `asUntyped` helper in deployments-ingestion.test.tsx).

type WorkflowEventRow = {
  id: number;
  head_sha: string | null;
  workflow_name: string | null;
  status: string | null;
  conclusion: string | null;
  repository_name: string;
};

type DeploymentRow = {
  id: number;
  repository_name: string;
  sha: string | null;
  environment: string | null;
  state: string | null;
  target_url: string | null;
};

type UntypedClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: WorkflowEventRow[] | number | null; error: { message: string } | null }>;
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        eq: (col: string, val: unknown) => Promise<{ data: DeploymentRow[] | null; error: { message: string } | null }>;
      };
    };
  };
};

const asUntyped = (client: unknown) => client as unknown as UntypedClient;

async function getSubmissionChecks(client: unknown, submissionId: number) {
  return asUntyped(client).rpc("get_submission_checks", { p_submission_id: submissionId }) as Promise<{
    data: WorkflowEventRow[] | null;
    error: { message: string } | null;
  }>;
}

async function getDeploymentsForSubmission(client: unknown, repositoryName: string, sha: string) {
  return asUntyped(client)
    .from("github_deployments")
    .select("id, repository_name, sha, environment, state, target_url")
    .eq("repository_name", repositoryName)
    .eq("sha", sha);
}

test.describe.configure({ mode: "serial" });

test.describe("PR submission surfaces (checks + deployments data/RLS)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // PR submissions can run CI/deploy on the contributor's fork — a repo NOT in
  // `repositories`. Match purely by (repository_name, sha).
  const FORK_REPO = `some-fork/pr-surfaces-${SAFE_ID}`;
  const HEAD_SHA = `head${SAFE_ID}`;
  const BASE_SHA = `base${SAFE_ID}`;

  let classAId: number;
  let classBId: number;
  let instructorA: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser; // owns a DIFFERENT submission in the same class
  let studentC: TestingUser; // in another class entirely
  let assignmentId: number;
  let submissionId: number;

  const deploymentGhId = Number(`${Date.now()}`.slice(-9)) + 11;
  const deploymentStatusGhId = deploymentGhId + 5000;

  test.beforeAll(async () => {
    const clsA = await createClass({ name: `E2E PR Surfaces A ${RUN_PREFIX}` });
    classAId = clsA.id;
    const clsB = await createClass({ name: `E2E PR Surfaces B ${RUN_PREFIX}` });
    classBId = clsB.id;

    instructorA = await createUserInClass({
      role: "instructor",
      class_id: classAId,
      name: `Surf Instructor A ${RUN_PREFIX}`,
      email: `e2e-surf-instr-a-${SAFE_ID}@pawtograder.net`
    });
    studentA = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `Surf Student A ${RUN_PREFIX}`,
      email: `e2e-surf-a-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `Surf Student B ${RUN_PREFIX}`,
      email: `e2e-surf-b-${SAFE_ID}@pawtograder.net`
    });
    studentC = await createUserInClass({
      role: "student",
      class_id: classBId,
      name: `Surf Student C ${RUN_PREFIX}`,
      email: `e2e-surf-c-${SAFE_ID}@pawtograder.net`
    });

    const a = await insertAssignment({
      class_id: classAId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Surf assignment ${RUN_PREFIX}`,
      assignment_slug: `e2e-surf-${SAFE_ID}`
    });
    assignmentId = a.id;
    // Configure as a PR-mode assignment (drives the UI tab gating; not strictly
    // needed for the data-layer asserts, but keeps the fixture faithful).
    await supabase.from("assignments").update({ submission_mode: "pr" }).eq("id", assignmentId);

    // studentA's submission, repointed at the fork repo + head sha as a PR
    // submission. This is what both surfaces resolve against.
    const prebaked = await insertPreBakedSubmission({
      student_profile_id: studentA.private_profile_id,
      assignment_id: assignmentId,
      class_id: classAId,
      repositorySuffix: `surf-${SAFE_ID}`
    });
    submissionId = prebaked.submission_id;

    const { error: subUpdErr } = await supabase
      .from("submissions")
      .update({
        repository: FORK_REPO,
        head_sha: HEAD_SHA,
        base_sha: BASE_SHA,
        sha: HEAD_SHA,
        pr_number: 42,
        pr_state: "open",
        submitted_via: "pr"
      })
      .eq("id", submissionId);
    expect(subUpdErr).toBeNull();

    // CI run (workflow_event) on the fork, matching the submission head_sha.
    const { error: weErr } = await supabase.from("workflow_events").insert({
      class_id: classAId,
      event_type: "workflow_run",
      repository_name: FORK_REPO,
      head_sha: HEAD_SHA,
      head_branch: `pr-${SAFE_ID}`,
      workflow_name: "CI",
      workflow_run_id: deploymentGhId, // any unique-ish bigint
      run_number: 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success"
    });
    expect(weErr).toBeNull();

    // A workflow_event for a DIFFERENT sha — must NOT come back for this submission.
    const { error: weOtherErr } = await supabase.from("workflow_events").insert({
      class_id: classAId,
      event_type: "workflow_run",
      repository_name: FORK_REPO,
      head_sha: `other${SAFE_ID}`,
      workflow_name: "CI-other",
      workflow_run_id: deploymentGhId + 1,
      status: "completed",
      conclusion: "failure"
    });
    expect(weOtherErr).toBeNull();

    // Deployment for the fork repo + head sha (Path 3: NULL repository_id,
    // resolved to the class via the submission match).
    // types: upsert_github_deployment not yet in generated Database (deferred regen)
    const { error: depErr } = await asUntyped(supabase).rpc("upsert_github_deployment", {
      p_class_id: classAId,
      p_repository_name: FORK_REPO,
      p_repository_id: null,
      p_sha: HEAD_SHA,
      p_environment: "preview",
      p_state: "success",
      p_target_url: "https://example.com/surf-deploy",
      p_github_deployment_id: deploymentGhId,
      p_github_deployment_status_id: deploymentStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "surf" }
    });
    expect(depErr).toBeNull();
  });

  test("Checks: get_submission_checks returns CI runs matching the submission head_sha (service role)", async () => {
    const { data, error } = await getSubmissionChecks(supabase, submissionId);
    expect(error).toBeNull();
    const shas = (data ?? []).map((w) => w.head_sha);
    // The matching run is present; the other-sha run is excluded.
    expect(shas).toContain(HEAD_SHA);
    expect(shas).not.toContain(`other${SAFE_ID}`);
    const match = (data ?? []).find((w) => w.head_sha === HEAD_SHA);
    expect(match?.workflow_name).toBe("CI");
    expect(match?.conclusion).toBe("success");
  });

  test("Checks RLS: the submission owner can read their checks", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { data, error } = await getSubmissionChecks(studentClient, submissionId);
    expect(error).toBeNull();
    expect((data ?? []).some((w) => w.head_sha === HEAD_SHA)).toBe(true);
  });

  test("Checks RLS: class staff can read another student's checks", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { data, error } = await getSubmissionChecks(instructorClient, submissionId);
    expect(error).toBeNull();
    expect((data ?? []).some((w) => w.head_sha === HEAD_SHA)).toBe(true);
  });

  test("Checks RLS: a student in another class reads no checks for this submission", async () => {
    // get_submission_checks is SECURITY INVOKER: the submissions-RLS join yields
    // no `s` row for a caller who cannot read the submission, so the RPC returns
    // an empty set (not the CI of a submission they can't see).
    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await getSubmissionChecks(studentClient, submissionId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  test("Deployments: the owner reads their submission's deployment (matched by repo + head sha)", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { data, error } = await getDeploymentsForSubmission(studentClient, FORK_REPO, HEAD_SHA);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
    const row = (data ?? [])[0];
    expect(row.environment).toBe("preview");
    expect(row.state).toBe("success");
    expect(row.target_url).toBe("https://example.com/surf-deploy");
  });

  test("Deployments RLS: class staff read the deployment", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { data, error } = await getDeploymentsForSubmission(instructorClient, FORK_REPO, HEAD_SHA);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("Deployments RLS: a same-class student who does NOT own the submission reads none", async () => {
    // studentB is in class A but has no submission/repository tied to FORK_REPO +
    // HEAD_SHA, so the (repository, head_sha) ownership path does not match.
    const studentClient = await createAuthenticatedClient(studentB);
    const { data, error } = await getDeploymentsForSubmission(studentClient, FORK_REPO, HEAD_SHA);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  test("Deployments RLS: a student in another class reads none", async () => {
    const studentClient = await createAuthenticatedClient(studentC);
    const { data, error } = await getDeploymentsForSubmission(studentClient, FORK_REPO, HEAD_SHA);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
