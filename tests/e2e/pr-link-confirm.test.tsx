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
//   2. reads the PR head/base from GitHub via getPullRequest BEFORE mutating any
//      DB state,
//   3. flips the chosen submission_pr_links row to confirmed (a DB trigger,
//      submission_pr_links_single_confirmed, unconfirms the submitter's siblings),
//   4. calls ingest_pr_submission so the confirmed PR becomes a submission, and
//      reverts the confirm if that ingest errors.
//
// IMPORTANT (E2E behavior): getPullRequest in GitHubWrapper.ts has NO E2E stub and
// always hits the real GitHub API. With the dummy GitHub App credentials used in
// E2E there is no real installation, so getOctoKit returns undefined and
// getPullRequest THROWS. Because the function now fetches the PR *before* the
// confirm UPDATE (step 2), that throw means nothing is mutated: the link stays
// unconfirmed and no submission is created. We therefore:
//   * assert that a failed pre-confirm fetch leaves the link UNCONFIRMED with no
//     submission (the heart of the confirm-after-ingest ordering);
//   * assert the authz rejection directly (SecurityError, thrown BEFORE the fetch,
//     leaves the links untouched);
//   * cover the confirm/unconfirm trigger + ingest_pr_submission active-submission
//     move at the DB layer (service-role confirm UPDATE fires the same trigger the
//     function relies on; the same ingest RPC the function calls), which is
//     deterministic under E2E without a real GitHub fetch.
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

/** Service-role confirm of a link (fires the single-confirmed trigger), bypassing
 * the edge function's unstubbable GitHub fetch. */
async function setConfirmed(linkId: number): Promise<void> {
  const { error } = await supabase.from("submission_pr_links").update({ confirmed: true }).eq("id", linkId);
  if (error) throw new Error(`Failed to confirm link ${linkId}: ${error.message}`);
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

async function countSubmissions(assignmentId: number, profileId: string): Promise<number> {
  const { count } = await supabase
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("assignment_id", assignmentId)
    .eq("profile_id", profileId);
  return count ?? 0;
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
    expect(await countSubmissions(assignmentId, owner.private_profile_id)).toBe(0);
  });

  test("authz: a different student in the class cannot confirm the owner's link", async () => {
    const otherClient = await createAuthenticatedClient(otherStudent);
    // The authz SecurityError is thrown BEFORE the GitHub fetch and the confirm
    // UPDATE; it surfaces (via wrapRequestHandler -> EdgeFunctionError) with the
    // authorization message. Assert on that message specifically so the test fails
    // if the rejection is instead a later GitHub-fetch error (which would mean the
    // authorization check was bypassed) rather than the authorization boundary.
    await expect(confirmPrLink({ link_id: link1Id }, otherClient)).rejects.toThrow(
      /can only confirm your own pull request/i
    );
    expect(await readConfirmed(link1Id)).toBe(false);
    expect(await readConfirmed(link2Id)).toBe(false);
  });

  test("confirm-after-ingest: a failed pre-confirm GitHub fetch leaves the link UNCONFIRMED with no submission", async () => {
    // The function fetches the PR from GitHub BEFORE confirming. getPullRequest is
    // unstubbable in E2E and throws (no real installation), so the function rejects
    // and must NOT have mutated the link table or created a submission. This is the
    // ordering invariant from the review: confirm only after the fetch (and ingest)
    // succeed, so a transient GitHub failure can't strand a confirmed link with no
    // submission.
    const ownerClient = await createAuthenticatedClient(owner);
    await expect(confirmPrLink({ link_id: link1Id }, ownerClient)).rejects.toBeTruthy();

    expect(await readConfirmed(link1Id)).toBe(false);
    expect(await readConfirmed(link2Id)).toBe(false);
    expect(await countSubmissions(assignmentId, owner.private_profile_id)).toBe(0);
  });

  test("single-confirmed trigger + ingest: confirming a link unconfirms the sibling and the active submission moves", async () => {
    // The edge function's GitHub fetch can't succeed in E2E, so drive the confirm
    // at the DB layer (the same UPDATE the function issues, which fires the same
    // single-confirmed trigger) plus the same ingest_pr_submission RPC the function
    // calls. This deterministically covers the DB invariants the function depends on.

    // Confirm link #1 -> it's the only confirmed link; ingest -> active PR #1.
    await setConfirmed(link1Id);
    expect(await readConfirmed(link1Id)).toBe(true);
    expect(await readConfirmed(link2Id)).toBe(false);

    const { data: sub1Id, error: err1 } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: owner.private_profile_id,
      p_pr_repo: REPO_1,
      p_pr_number: PR_1,
      p_base_sha: "c1base",
      p_head_sha: "c1head",
      p_pr_state: "open",
      p_auto_confirm: false
    });
    expect(err1).toBeNull();
    expect(typeof sub1Id).toBe("number");

    const active1 = await supabase
      .from("submissions")
      .select("id, pr_number, is_active, submitted_via")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", owner.private_profile_id)
      .eq("is_active", true);
    expect(active1.data).toHaveLength(1);
    expect(active1.data![0]).toMatchObject({ id: sub1Id, pr_number: PR_1, is_active: true, submitted_via: "pr" });

    // Switch to link #2: the trigger unconfirms #1; ingest deactivates the prior
    // active (PR #1) submission and the active row moves to PR #2.
    await setConfirmed(link2Id);
    expect(await readConfirmed(link2Id)).toBe(true);
    expect(await readConfirmed(link1Id)).toBe(false);

    const { data: sub2Id, error: err2 } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: owner.private_profile_id,
      p_pr_repo: REPO_2,
      p_pr_number: PR_2,
      p_base_sha: "c2base",
      p_head_sha: "c2head",
      p_pr_state: "open",
      p_auto_confirm: false
    });
    expect(err2).toBeNull();
    expect(typeof sub2Id).toBe("number");

    const active2 = await supabase
      .from("submissions")
      .select("id, pr_number, is_active")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", owner.private_profile_id)
      .eq("is_active", true);
    expect(active2.data).toHaveLength(1);
    expect(active2.data![0]).toMatchObject({ id: sub2Id, pr_number: PR_2 });
  });
});
