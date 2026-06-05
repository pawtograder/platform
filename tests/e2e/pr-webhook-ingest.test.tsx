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
  const FORK = `${END_TO_END_REPO_PREFIX}-fork-${SAFE_ID}`;
  const GH_LOGIN = `e2e-pr-author-${SAFE_ID}`;
  const PR_NUMBER = 42;

  let classId: number;
  let student: TestingUser;
  let assignmentId: number;

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

    // Files were ingested (E2E_MOCK_GITHUB canned file from the head fork).
    const { data: files } = await supabase.from("submission_files").select("name").eq("submission_id", submissionId!);
    expect((files ?? []).length).toBeGreaterThan(0);

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
});
