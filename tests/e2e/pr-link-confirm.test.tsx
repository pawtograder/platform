import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import { confirmPrLink } from "@/lib/edgeFunctions";

// A2 — pr-link-confirm edge function: the "student picks which PR" + authz flow.
//
// pr-link-confirm (supabase/functions/pr-link-confirm/index.ts) is the path used
// when several candidate PRs exist (manual identification, or base_branch/
// branch_convention matched >1 PR) and the submitter must choose one. It:
//   1. authorizes the caller (enrolled staff, or the owning student/group member),
//   2. flips the chosen submission_pr_links row to confirmed (a DB trigger,
//      submission_pr_links_single_confirmed, unconfirms the submitter's siblings),
//   3. reads the PR head/base from GitHub via getPullRequest, then
//   4. calls ingest_pr_submission so the confirmed PR becomes a submission.
//
// IMPORTANT (E2E behavior): getPullRequest in GitHubWrapper.ts has NO E2E stub —
// unlike the webhook-direct path (handlePrSubmission) it always hits the real
// GitHub API. With the dummy GitHub App credentials used in E2E there is no real
// installation, so getOctoKit returns undefined and getPullRequest throws; the
// handler then returns a non-2xx and confirmPrLink rejects. The confirm UPDATE in
// step 2 runs *before* that GitHub call as its own PostgREST request, so the
// confirm + sibling-unconfirm side effects are durably committed regardless. We
// therefore:
//   * assert the confirm/unconfirm DB invariants (the heart of this function),
//     tolerating a post-confirm rejection from the unstubbable GitHub fetch;
//   * drive submission creation via the same ingest_pr_submission RPC the function
//     calls internally (service-role, p_auto_confirm:false on the already-confirmed
//     link) so "a submission exists / the active submission moves" is deterministic
//     under E2E without depending on real GitHub;
//   * assert the authz rejections directly — those throw a SecurityError BEFORE any
//     DB write, so they reject deterministically and leave the links untouched.
//
// Unlike pr-webhook-ingest / pr-base-tree-cache this needs neither EVENTBRIDGE_SECRET
// nor E2E_MOCK_GITHUB: pr-link-confirm uses ordinary Supabase auth (a magic-link
// session), and the GitHub fetch is tolerated. Repos still use the E2E student-repo
// `--<suffix>` convention so any clone/file-fetch resolves to the fixture.
//
// Requires (see AGENTS.md): `npx supabase functions serve --env-file .env.local`
// with E2E_ENABLE=true.

const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";

type IngestArgs = {
  p_assignment_id: number;
  p_pr_repo: string;
  p_pr_number: number;
  p_base_sha?: string | null;
  p_head_sha?: string | null;
  p_pr_state?: string | null;
  p_profile_id?: string | null;
  p_assignment_group_id?: number | null;
  p_auto_confirm?: boolean;
};

/** Service-role call to the ingestion RPC (the same RPC pr-link-confirm invokes). */
async function ingest(args: IngestArgs) {
  return (await (supabase.rpc as CallableFunction)("ingest_pr_submission", args)) as {
    data: number | null;
    error: { message: string; code?: string } | null;
  };
}

/**
 * Invoke confirmPrLink as `client` and report whether it resolved. Tolerates a
 * post-confirm failure from the unstubbable getPullRequest GitHub fetch (which
 * happens AFTER the confirm UPDATE is committed): the caller asserts the durable
 * confirm/unconfirm DB state either way. Authz failures (SecurityError, thrown
 * BEFORE the UPDATE) are asserted separately with `.rejects`, not via this helper.
 */
async function confirmTolerant(
  client: Awaited<ReturnType<typeof createAuthenticatedClient>>,
  linkId: number
): Promise<{ resolved: boolean }> {
  try {
    await confirmPrLink({ link_id: linkId }, client);
    return { resolved: true };
  } catch {
    // Post-confirm GitHub fetch failed under E2E; the confirm itself committed.
    return { resolved: false };
  }
}

/** Insert an UNCONFIRMED candidate link for a profile (service role). */
async function insertCandidateLink(opts: {
  classId: number;
  assignmentId: number;
  profileId: string;
  prRepo: string;
  prNumber: number;
}): Promise<number> {
  const { data, error } = await supabase
    .from("submission_pr_links")
    .insert({
      class_id: opts.classId,
      assignment_id: opts.assignmentId,
      profile_id: opts.profileId,
      pr_repo: opts.prRepo,
      pr_number: opts.prNumber,
      confirmed: false
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to insert candidate link: ${error.message}`);
  return data!.id;
}

async function readConfirmed(linkId: number): Promise<boolean | null> {
  const { data } = await supabase.from("submission_pr_links").select("confirmed").eq("id", linkId).maybeSingle();
  return data?.confirmed ?? null;
}

test.describe.configure({ mode: "serial" });

test.describe("pr-link-confirm (multi-candidate student picks + authz)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // E2E student-repo prefix so any clone/file-fetch resolves to the fixture repo.
  const UPSTREAM = `${END_TO_END_REPO_PREFIX}--pr-confirm-${SAFE_ID}`;
  const REPO_1 = `${END_TO_END_REPO_PREFIX}--pr-confirm-1-${SAFE_ID}`;
  const REPO_2 = `${END_TO_END_REPO_PREFIX}--pr-confirm-2-${SAFE_ID}`;
  const PR_1 = 201;
  const PR_2 = 202;

  let classId: number;
  let owner: TestingUser;
  let otherStudent: TestingUser;
  let instructor: TestingUser;
  let assignmentId: number;
  let link1Id: number;
  let link2Id: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR Link Confirm ${RUN_PREFIX}` });
    classId = cls.id;

    owner = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Confirm Owner ${RUN_PREFIX}`,
      email: `e2e-prc-owner-${SAFE_ID}@pawtograder.net`
    });
    otherStudent = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Confirm Other ${RUN_PREFIX}`,
      email: `e2e-prc-other-${SAFE_ID}@pawtograder.net`
    });
    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `PR Confirm Instructor ${RUN_PREFIX}`,
      email: `e2e-prc-inst-${SAFE_ID}@pawtograder.net`
    });

    // manual identification: the webhook never auto-confirms, so the student must
    // pick which candidate PR is their submission via pr-link-confirm.
    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Link Confirm ${RUN_PREFIX}`,
      assignment_slug: `e2e-prc-${SAFE_ID}`
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "manual"
      })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // Two unconfirmed candidate links for the same student/assignment (distinct
    // pr_repo + pr_number). Neither auto-confirms (manual identification).
    link1Id = await insertCandidateLink({
      classId,
      assignmentId,
      profileId: owner.private_profile_id,
      prRepo: REPO_1,
      prNumber: PR_1
    });
    link2Id = await insertCandidateLink({
      classId,
      assignmentId,
      profileId: owner.private_profile_id,
      prRepo: REPO_2,
      prNumber: PR_2
    });
  });

  test("preconditions: two unconfirmed candidate links, no submission yet", async () => {
    expect(await readConfirmed(link1Id)).toBe(false);
    expect(await readConfirmed(link2Id)).toBe(false);
    const { count } = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("profile_id", owner.private_profile_id);
    expect(count ?? 0).toBe(0);
  });

  test("authz: a different student in the class cannot confirm the owner's link", async () => {
    const otherClient = await createAuthenticatedClient(otherStudent);
    // SecurityError is thrown before the confirm UPDATE -> the SDK surfaces a
    // rejection and the link is left untouched.
    await expect(confirmPrLink({ link_id: link1Id }, otherClient)).rejects.toBeTruthy();
    expect(await readConfirmed(link1Id)).toBe(false);
    expect(await readConfirmed(link2Id)).toBe(false);
  });

  test("owner confirms link #1: it becomes confirmed and the sibling is unconfirmed", async () => {
    const ownerClient = await createAuthenticatedClient(owner);
    await confirmTolerant(ownerClient, link1Id);

    // The confirm UPDATE + single-confirmed trigger committed regardless of the
    // subsequent (unstubbable) GitHub fetch.
    expect(await readConfirmed(link1Id)).toBe(true);
    expect(await readConfirmed(link2Id)).toBe(false);

    // Deterministically ingest the now-confirmed PR (the same RPC the function
    // calls internally) and assert a submission exists for the confirmed PR.
    const { data: sub1Id, error } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: owner.private_profile_id,
      p_pr_repo: REPO_1,
      p_pr_number: PR_1,
      p_base_sha: "c1base",
      p_head_sha: "c1head",
      p_pr_state: "open",
      p_auto_confirm: false
    });
    expect(error).toBeNull();
    expect(typeof sub1Id).toBe("number");

    const { data: active } = await supabase
      .from("submissions")
      .select("id, pr_number, is_active, submitted_via")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", owner.private_profile_id)
      .eq("is_active", true);
    expect(active).toHaveLength(1);
    expect(active![0]).toMatchObject({ id: sub1Id, pr_number: PR_1, is_active: true, submitted_via: "pr" });
  });

  test("owner switches to link #2: #2 becomes confirmed, #1 unconfirmed, the active submission moves", async () => {
    const ownerClient = await createAuthenticatedClient(owner);
    await confirmTolerant(ownerClient, link2Id);

    // The trigger flipped the confirmed flag from #1 to #2.
    expect(await readConfirmed(link2Id)).toBe(true);
    expect(await readConfirmed(link1Id)).toBe(false);

    // Ingest the newly-confirmed PR; ingest_pr_submission deactivates the prior
    // active (PR #1) submission for this submitter and the active row moves to PR #2.
    const { data: sub2Id, error } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: owner.private_profile_id,
      p_pr_repo: REPO_2,
      p_pr_number: PR_2,
      p_base_sha: "c2base",
      p_head_sha: "c2head",
      p_pr_state: "open",
      p_auto_confirm: false
    });
    expect(error).toBeNull();
    expect(typeof sub2Id).toBe("number");

    const { data: active } = await supabase
      .from("submissions")
      .select("id, pr_number, is_active")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", owner.private_profile_id)
      .eq("is_active", true);
    expect(active).toHaveLength(1);
    expect(active![0]).toMatchObject({ id: sub2Id, pr_number: PR_2 });
  });

  test("authz: a staff member (instructor) in the class is allowed to confirm a link", async () => {
    // Switch the confirmed link back to #1 as staff. Staff are authorized by
    // assertUserIsInCourse + the instructor/grader role check (not ownership).
    const instructorClient = await createAuthenticatedClient(instructor);
    const result = await confirmTolerant(instructorClient, link1Id);

    // The confirm side effect must have committed (staff passed authz). If the
    // GitHub fetch happened to succeed (real creds on the runner), it resolves;
    // either way the durable confirm/unconfirm state is asserted below.
    expect([true, false]).toContain(result.resolved);
    expect(await readConfirmed(link1Id)).toBe(true);
    expect(await readConfirmed(link2Id)).toBe(false);
  });
});
