import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, createUserInClass, getTestRunPrefix, insertAssignment, supabase } from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// End-to-end coverage for PR-mode submission ingestion driven through the REAL
// github-repo-webhook edge function (the webhook → handlePrSubmission →
// ingest_pr_submission → ingestPrSubmissionFiles path), the PR-mode analog of
// push-no-autograder.test.tsx. Closes the review's "no webhook→file e2e for PR
// mode" gap. The head fork uses the E2E student-repo prefix so
// ingestPrSubmissionFiles takes its E2E_MOCK_GITHUB canned-file path instead of
// cloning GitHub.
//
// Requires (see AGENTS.md): `npx supabase functions serve --env-file .env.local`
// with E2E_ENABLE=true, E2E_MOCK_GITHUB=true, and EVENTBRIDGE_SECRET set (the
// webhook authenticates on `Authorization === EVENTBRIDGE_SECRET`). Without
// EVENTBRIDGE_SECRET the webhook can't be authenticated, so the lifecycle tests
// skip.

const FUNCTIONS_BASE = `${process.env.SUPABASE_URL?.replace(/\/$/, "")}/functions/v1`;
const EVENTBRIDGE_SECRET = process.env.EVENTBRIDGE_SECRET;
const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";

type PrDetail = {
  action: string;
  repository: { full_name: string; id: number };
  pull_request: {
    number: number;
    state: string;
    draft: boolean;
    merged?: boolean;
    merged_at?: string | null;
    base: { ref: string; sha: string; repo: { full_name: string } };
    head: { ref: string; sha: string; repo: { full_name: string } };
    user: { login: string };
  };
};

/** POST an EventBridge-style `pull_request` envelope to github-repo-webhook. */
async function deliverPullRequest(detail: PrDetail, deliveryId: string) {
  return await fetch(`${FUNCTIONS_BASE}/github-repo-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: EVENTBRIDGE_SECRET ?? ""
    },
    body: JSON.stringify({ id: deliveryId, "detail-type": "pull_request", detail })
  });
}

test.describe.configure({ mode: "serial" });

test.describe("PR-mode webhook ingestion (webhook → submission + files)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const UPSTREAM = `pawtograder-playground/pr-upstream-${SAFE_ID}`;
  const FORK = `${END_TO_END_REPO_PREFIX}--fork-${SAFE_ID}`;
  const GH_LOGIN = `e2e-pr-author-${SAFE_ID}`;
  const PR_NUMBER = 42;
  // Author-spoofing fixtures: a login that maps to NO user, and a login that
  // maps to a user who is NOT a student in this assignment's class.
  const UNKNOWN_LOGIN = `e2e-pr-nobody-${SAFE_ID}`;
  const OUT_OF_CLASS_LOGIN = `e2e-pr-outsider-${SAFE_ID}`;
  // branch_convention fixtures: a separate upstream repo + assignment so its
  // deliveries can't cross-contaminate the base_branch assignment above.
  const BC_UPSTREAM = `pawtograder-playground/pr-bc-upstream-${SAFE_ID}`;

  // A dedicated upstream + student for the unmerged-closed case. Auto-confirm
  // only fires for a submitter's SOLE candidate link, so this case can't reuse
  // `student` (who already has a confirmed PR on `assignmentId`).
  const CLOSED_UPSTREAM = `pawtograder-playground/pr-closed-upstream-${SAFE_ID}`;
  const CLOSED_LOGIN = `e2e-pr-closed-${SAFE_ID}`;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;
  // A second pr-mode assignment identified by head-branch convention.
  let bcAssignmentId: number;
  // Dedicated assignment for the unmerged-closed case (see CLOSED_* above).
  let closedAssignmentId: number;
  let closedStudent: TestingUser;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR Webhook ${RUN_PREFIX}` });
    classId = cls.id;

    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Webhook Student ${RUN_PREFIX}`,
      email: `e2e-pr-wh-${SAFE_ID}@pawtograder.net`
    });
    // The PR handler maps pull_request.user.login -> users.github_username.
    const { error: ghErr } = await supabase
      .from("users")
      .update({ github_username: GH_LOGIN })
      .eq("user_id", student.user_id);
    expect(ghErr).toBeNull();

    // An out-of-class user: has a github_username (so author->user mapping
    // succeeds) but is enrolled in a DIFFERENT class, so they are NOT a student
    // in this assignment's class. The handler must reject their PR at the
    // user_roles gate, not ingest it. We create them in their own class.
    const otherCls = await createClass({ name: `E2E PR Webhook Other ${RUN_PREFIX}` });
    const outsider = await createUserInClass({
      role: "student",
      class_id: otherCls.id,
      name: `PR Webhook Outsider ${RUN_PREFIX}`,
      email: `e2e-pr-out-${SAFE_ID}@pawtograder.net`
    });
    const { error: outErr } = await supabase
      .from("users")
      .update({ github_username: OUT_OF_CLASS_LOGIN })
      .eq("user_id", outsider.user_id);
    expect(outErr).toBeNull();

    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Webhook ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-wh-${SAFE_ID}`
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "base_branch"
      })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();

    // A second pr-mode assignment that identifies submission PRs by their HEAD
    // branch name matching ^submission/.+$ (instead of by base branch).
    const bc = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Webhook BranchConv ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-wh-bc-${SAFE_ID}`
    });
    bcAssignmentId = bc.id;
    const { error: bcErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: BC_UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "branch_convention",
        pr_branch_convention: "^submission/.+$"
      })
      .eq("id", bcAssignmentId);
    expect(bcErr).toBeNull();

    // Dedicated student + base_branch pr-mode assignment for the unmerged-closed
    // case, so that PR's link is the submitter's sole candidate and auto-confirms.
    closedStudent = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Webhook Closed Student ${RUN_PREFIX}`,
      email: `e2e-pr-closed-${SAFE_ID}@pawtograder.net`
    });
    const { error: closedGhErr } = await supabase
      .from("users")
      .update({ github_username: CLOSED_LOGIN })
      .eq("user_id", closedStudent.user_id);
    expect(closedGhErr).toBeNull();

    const closedA = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Webhook Closed ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-wh-closed-${SAFE_ID}`
    });
    closedAssignmentId = closedA.id;
    const { error: closedCfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: CLOSED_UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "base_branch"
      })
      .eq("id", closedAssignmentId);
    expect(closedCfgErr).toBeNull();
  });

  function makePrDetail(action: string, headSha: string, overrides?: Partial<PrDetail["pull_request"]>): PrDetail {
    return {
      action,
      repository: { full_name: UPSTREAM, id: Math.floor(Math.random() * 1_000_000_000) },
      pull_request: {
        number: PR_NUMBER,
        state: "open",
        draft: false,
        base: { ref: "main", sha: "base-sha-1", repo: { full_name: UPSTREAM } },
        head: { ref: "feature", sha: headSha, repo: { full_name: FORK } },
        user: { login: GH_LOGIN },
        ...overrides
      }
    };
  }

  // A PR targeting the branch_convention assignment's upstream repo. The
  // identification gate keys off the HEAD ref (headRef), not the base ref.
  function makeBcPrDetail(prNumber: number, headRef: string, headSha: string): PrDetail {
    return {
      action: "opened",
      repository: { full_name: BC_UPSTREAM, id: Math.floor(Math.random() * 1_000_000_000) },
      pull_request: {
        number: prNumber,
        state: "open",
        draft: false,
        base: { ref: "main", sha: "bc-base-sha", repo: { full_name: BC_UPSTREAM } },
        head: { ref: headRef, sha: headSha, repo: { full_name: FORK } },
        user: { login: GH_LOGIN }
      }
    };
  }

  // A PR targeting the dedicated unmerged-closed assignment's upstream repo,
  // authored by the dedicated student so its link auto-confirms (sole candidate).
  function makeClosedPrDetail(
    action: string,
    headSha: string,
    overrides?: Partial<PrDetail["pull_request"]>
  ): PrDetail {
    return {
      action,
      repository: { full_name: CLOSED_UPSTREAM, id: Math.floor(Math.random() * 1_000_000_000) },
      pull_request: {
        number: 7301,
        state: "open",
        draft: false,
        base: { ref: "main", sha: "closed-base-sha", repo: { full_name: CLOSED_UPSTREAM } },
        head: { ref: "feature", sha: headSha, repo: { full_name: FORK } },
        user: { login: CLOSED_LOGIN },
        ...overrides
      }
    };
  }

  test("DB precondition: pr-mode assignment targeting the upstream repo", async () => {
    const { data: a } = await supabase
      .from("assignments")
      .select("submission_mode, upstream_repo")
      .eq("id", assignmentId)
      .single();
    expect(a?.submission_mode).toBe("pr");
    expect(a?.upstream_repo).toBe(UPSTREAM);
  });

  test("opened PR is ingested as a submission with files (auto-confirmed sole candidate)", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set; cannot authenticate the webhook (see file header).");
    const res = await deliverPullRequest(makePrDetail("opened", "head-sha-1"), `pr-open-${SAFE_ID}`);
    expect(res.ok).toBe(true);

    // The sole candidate auto-confirms and ingests; poll briefly for the row.
    let submissionId: number | null = null;
    for (let i = 0; i < 20 && submissionId === null; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("id")
        .eq("assignment_id", assignmentId)
        .eq("pr_number", PR_NUMBER)
        .eq("head_sha", "head-sha-1")
        .maybeSingle();
      submissionId = data?.id ?? null;
      if (submissionId === null) await new Promise((r) => setTimeout(r, 500));
    }
    expect(submissionId).not.toBeNull();

    const { data: sub } = await supabase
      .from("submissions")
      .select("pr_number, base_sha, head_sha, sha, pr_state, is_active, submitted_via")
      .eq("id", submissionId!)
      .single();
    expect(sub).toMatchObject({
      pr_number: PR_NUMBER,
      base_sha: "base-sha-1",
      head_sha: "head-sha-1",
      sha: "head-sha-1",
      pr_state: "open",
      is_active: true,
      submitted_via: "pr"
    });

    // Files were ingested from the head fork. Under E2E_MOCK_GITHUB the canned
    // file is Main.java (see _shared/PrSubmissionFiles.ts), so assert that exact
    // name is present rather than merely a nonzero count.
    const { data: files } = await supabase.from("submission_files").select("name").eq("submission_id", submissionId!);
    expect((files ?? []).map((f) => f.name)).toContain("Main.java");

    // The candidate link auto-confirmed.
    const { data: link } = await supabase
      .from("submission_pr_links")
      .select("confirmed")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", student.private_profile_id)
      .eq("pr_number", PR_NUMBER)
      .maybeSingle();
    expect(link?.confirmed).toBe(true);
  });

  test("synchronize (new head sha) creates a new active version", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const res = await deliverPullRequest(makePrDetail("synchronize", "head-sha-2"), `pr-sync-${SAFE_ID}`);
    expect(res.ok).toBe(true);

    let activeHead: string | null = null;
    for (let i = 0; i < 20 && activeHead !== "head-sha-2"; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("head_sha")
        .eq("assignment_id", assignmentId)
        .eq("profile_id", student.private_profile_id)
        .eq("is_active", true)
        .maybeSingle();
      activeHead = data?.head_sha ?? null;
      if (activeHead !== "head-sha-2") await new Promise((r) => setTimeout(r, 500));
    }
    expect(activeHead).toBe("head-sha-2");

    // Exactly one active submission for this submitter.
    const { count } = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("profile_id", student.private_profile_id)
      .eq("is_active", true);
    expect(count).toBe(1);
  });

  test("closed PR updates pr_state without creating a new version", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const before = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("profile_id", student.private_profile_id);

    const res = await deliverPullRequest(
      makePrDetail("closed", "head-sha-2", {
        state: "closed",
        merged: true,
        merged_at: new Date().toISOString(),
        head: { ref: "feature", sha: "head-sha-2", repo: { full_name: FORK } }
      }),
      `pr-closed-${SAFE_ID}`
    );
    expect(res.ok).toBe(true);

    let merged = false;
    for (let i = 0; i < 20 && !merged; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("pr_state")
        .eq("assignment_id", assignmentId)
        .eq("pr_number", PR_NUMBER)
        .eq("head_sha", "head-sha-2")
        .maybeSingle();
      merged = data?.pr_state === "merged";
      if (!merged) await new Promise((r) => setTimeout(r, 500));
    }
    expect(merged).toBe(true);

    // No new version was created by the close event.
    const after = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("profile_id", student.private_profile_id);
    expect(after.count).toBe(before.count);
  });

  test("author spoofing: a PR whose author maps to NO Pawtograder user is not ingested", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const spoofPr = 8401;
    const res = await deliverPullRequest(
      makePrDetail("opened", "spoof-unknown-sha", {
        number: spoofPr,
        user: { login: UNKNOWN_LOGIN }
      }),
      `pr-spoof-unknown-${SAFE_ID}`
    );
    // The webhook still returns ok; it just declines to create anything.
    expect(res.ok).toBe(true);

    // Give the handler a beat to run, then assert nothing was created for this PR.
    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("pr_number", spoofPr);
    expect(subs ?? []).toHaveLength(0);

    const { data: links } = await supabase
      .from("submission_pr_links")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("pr_number", spoofPr);
    expect(links ?? []).toHaveLength(0);
  });

  test("author spoofing: a PR whose author is NOT a student in this class is not ingested", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const spoofPr = 8402;
    // OUT_OF_CLASS_LOGIN maps to a real user, but that user is a student in a
    // DIFFERENT class -> the user_roles gate rejects them for this assignment.
    const res = await deliverPullRequest(
      makePrDetail("opened", "spoof-outsider-sha", {
        number: spoofPr,
        user: { login: OUT_OF_CLASS_LOGIN }
      }),
      `pr-spoof-outsider-${SAFE_ID}`
    );
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("pr_number", spoofPr);
    expect(subs ?? []).toHaveLength(0);

    const { data: links } = await supabase
      .from("submission_pr_links")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("pr_number", spoofPr);
    expect(links ?? []).toHaveLength(0);
  });

  test("branch_convention: a PR whose head ref matches the convention is ingested", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const prNumber = 9101;
    const res = await deliverPullRequest(
      makeBcPrDetail(prNumber, "submission/part1", "bc-match-sha"),
      `pr-bc-match-${SAFE_ID}`
    );
    expect(res.ok).toBe(true);

    let submissionId: number | null = null;
    for (let i = 0; i < 20 && submissionId === null; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("id")
        .eq("assignment_id", bcAssignmentId)
        .eq("pr_number", prNumber)
        .eq("head_sha", "bc-match-sha")
        .maybeSingle();
      submissionId = data?.id ?? null;
      if (submissionId === null) await new Promise((r) => setTimeout(r, 500));
    }
    expect(submissionId).not.toBeNull();
  });

  test("branch_convention: a PR whose head ref does NOT match the convention is not ingested", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const prNumber = 9102;
    // head ref "feature/x" does not match ^submission/.+$.
    const res = await deliverPullRequest(
      makeBcPrDetail(prNumber, "feature/part1", "bc-nomatch-sha"),
      `pr-bc-nomatch-${SAFE_ID}`
    );
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 1500));
    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", bcAssignmentId)
      .eq("pr_number", prNumber);
    expect(subs ?? []).toHaveLength(0);
  });

  test("branch_convention: an invalid regex does not crash the webhook and ingests nothing", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    // Temporarily set a malformed regex on the branch_convention assignment.
    const { error: setBadErr } = await supabase
      .from("assignments")
      .update({ pr_branch_convention: "^submission/[" })
      .eq("id", bcAssignmentId);
    expect(setBadErr).toBeNull();

    try {
      const prNumber = 9103;
      const res = await deliverPullRequest(
        makeBcPrDetail(prNumber, "submission/part1", "bc-badregex-sha"),
        `pr-bc-badregex-${SAFE_ID}`
      );
      // The handler catches the RegExp construction error and skips this
      // assignment rather than throwing -> the delivery still succeeds.
      expect(res.ok).toBe(true);

      await new Promise((r) => setTimeout(r, 1500));
      const { data: subs } = await supabase
        .from("submissions")
        .select("id")
        .eq("assignment_id", bcAssignmentId)
        .eq("pr_number", prNumber);
      expect(subs ?? []).toHaveLength(0);
    } finally {
      // Restore the valid convention so later runs/assertions aren't affected.
      const { error: restoreErr } = await supabase
        .from("assignments")
        .update({ pr_branch_convention: "^submission/.+$" })
        .eq("id", bcAssignmentId);
      expect(restoreErr).toBeNull();
    }
  });

  test("unmerged closed PR sets pr_state='closed' without creating a new version", async () => {
    test.skip(!EVENTBRIDGE_SECRET, "EVENTBRIDGE_SECRET not set.");
    const prNumber = 7301;
    const headSha = "closed-unmerged-sha";

    // First open the PR (dedicated student -> sole candidate -> auto-confirms)
    // so there is a version to transition.
    const openRes = await deliverPullRequest(makeClosedPrDetail("opened", headSha), `pr-closeunmerged-open-${SAFE_ID}`);
    expect(openRes.ok).toBe(true);

    let submissionId: number | null = null;
    for (let i = 0; i < 20 && submissionId === null; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("id")
        .eq("assignment_id", closedAssignmentId)
        .eq("pr_number", prNumber)
        .eq("head_sha", headSha)
        .maybeSingle();
      submissionId = data?.id ?? null;
      if (submissionId === null) await new Promise((r) => setTimeout(r, 500));
    }
    expect(submissionId).not.toBeNull();

    const beforeCount = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", closedAssignmentId)
      .eq("profile_id", closedStudent.private_profile_id);

    // Now close it WITHOUT merging (merged:false, merged_at:null) -> state 'closed'
    // (distinct from the existing merged case, which asserts pr_state='merged').
    const closeRes = await deliverPullRequest(
      makeClosedPrDetail("closed", headSha, {
        state: "closed",
        merged: false,
        merged_at: null
      }),
      `pr-closeunmerged-close-${SAFE_ID}`
    );
    expect(closeRes.ok).toBe(true);

    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      const { data } = await supabase
        .from("submissions")
        .select("pr_state")
        .eq("assignment_id", closedAssignmentId)
        .eq("pr_number", prNumber)
        .eq("head_sha", headSha)
        .maybeSingle();
      closed = data?.pr_state === "closed";
      if (!closed) await new Promise((r) => setTimeout(r, 500));
    }
    expect(closed).toBe(true);

    // The close event created no new version (distinct from a synchronize).
    const afterCount = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", closedAssignmentId)
      .eq("profile_id", closedStudent.private_profile_id);
    expect(afterCount.count).toBe(beforeCount.count);
  });
});
