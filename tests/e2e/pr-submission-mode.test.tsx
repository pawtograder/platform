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

// Tests for PR submission mode (feat/pr-submission-mode, Phases 1-3):
//   * ingest_pr_submission RPC semantics (auto-confirm, versioning, idempotency)
//   * submission_pr_links RLS: the client may read its own links but NOT write
//     them (confirmation goes through the pr-link-confirm edge function as
//     service_role). This is the security fix for the missing-WITH-CHECK gap.
//
// These exercise the DB/RPC layer directly via service-role + student-scoped
// clients; the PR head-fork file ingestion (PrSubmissionFiles.ts) runs in the
// edge function and is covered by typecheck + the autograder ingestion parity.

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

async function ingest(args: IngestArgs) {
  return (await (supabase.rpc as CallableFunction)("ingest_pr_submission", args)) as {
    data: number | null;
    error: { message: string; code?: string } | null;
  };
}

test.describe.configure({ mode: "serial" });

test.describe("PR submission mode (ingest + RLS)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const UPSTREAM = `pawtograder-playground/pr-upstream-${SAFE_ID}`;

  let classId: number;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let prAssignmentId: number;
  let manualAssignmentId: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR Submission ${RUN_PREFIX}` });
    classId = cls.id;

    studentA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Student A ${RUN_PREFIX}`,
      email: `e2e-pr-a-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Student B ${RUN_PREFIX}`,
      email: `e2e-pr-b-${SAFE_ID}@pawtograder.net`
    });

    // base_branch identification (auto-confirms a sole candidate).
    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR base_branch ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-base-${SAFE_ID}`
    });
    prAssignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "base_branch"
      })
      .eq("id", prAssignmentId);
    expect(cfgErr).toBeNull();

    // manual identification (never auto-confirms).
    const m = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR manual ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-manual-${SAFE_ID}`
    });
    manualAssignmentId = m.id;
    await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: `${UPSTREAM}-manual`,
        upstream_base_branch: "main",
        pr_identification: "manual"
      })
      .eq("id", manualAssignmentId);
  });

  test("sole candidate auto-confirms and creates an active pr submission version", async () => {
    const { data: subId, error } = await ingest({
      p_assignment_id: prAssignmentId,
      p_profile_id: studentA.private_profile_id,
      p_pr_repo: UPSTREAM,
      p_pr_number: 1,
      p_base_sha: "base000",
      p_head_sha: "head001",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();
    expect(typeof subId).toBe("number");

    const { data: sub } = await supabase
      .from("submissions")
      .select(
        "id, pr_number, base_sha, head_sha, sha, pr_state, is_active, submitted_via, ordinal, run_number, run_attempt"
      )
      .eq("id", subId!)
      .single();
    expect(sub).toMatchObject({
      pr_number: 1,
      base_sha: "base000",
      head_sha: "head001",
      sha: "head001", // sha mirrors head for back-compat
      pr_state: "open",
      is_active: true,
      submitted_via: "pr",
      // PR-mode submissions are not backed by a GitHub Actions run: run_number is the
      // 0 sentinel (matching the push-direct path) and is NOT overloaded with the PR
      // number — that lives in pr_number. run_attempt carries the version ordinal so
      // the (repository, sha, run_number, run_attempt) unique constraint stays distinct.
      run_number: 0,
      run_attempt: sub!.ordinal
    });

    const { data: link } = await supabase
      .from("submission_pr_links")
      .select("confirmed")
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id)
      .eq("pr_number", 1)
      .single();
    expect(link?.confirmed).toBe(true);
  });

  test("re-delivery of the same head sha is idempotent (no new version)", async () => {
    const before = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id);

    const { data: subId, error } = await ingest({
      p_assignment_id: prAssignmentId,
      p_profile_id: studentA.private_profile_id,
      p_pr_repo: UPSTREAM,
      p_pr_number: 1,
      p_base_sha: "base000",
      p_head_sha: "head001",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();
    expect(typeof subId).toBe("number");

    const after = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id);
    expect(after.count).toBe(before.count);
  });

  test("a new head sha creates a new active version and deactivates the prior one", async () => {
    const { data: newId, error } = await ingest({
      p_assignment_id: prAssignmentId,
      p_profile_id: studentA.private_profile_id,
      p_pr_repo: UPSTREAM,
      p_pr_number: 1,
      p_base_sha: "base000",
      p_head_sha: "head002",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();

    const { data: active } = await supabase
      .from("submissions")
      .select("id, head_sha, is_active")
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id)
      .eq("is_active", true);
    expect(active).toHaveLength(1);
    expect(active![0]).toMatchObject({ id: newId, head_sha: "head002" });
  });

  test("manual identification never auto-confirms (no submission until confirmed)", async () => {
    const { data: subId, error } = await ingest({
      p_assignment_id: manualAssignmentId,
      p_profile_id: studentB.private_profile_id,
      p_pr_repo: `${UPSTREAM}-manual`,
      p_pr_number: 7,
      p_base_sha: "b",
      p_head_sha: "h",
      p_pr_state: "open",
      p_auto_confirm: false
    });
    expect(error).toBeNull();
    expect(subId).toBeNull(); // not confirmed -> nothing ingested

    const { data: link } = await supabase
      .from("submission_pr_links")
      .select("confirmed")
      .eq("assignment_id", manualAssignmentId)
      .eq("profile_id", studentB.private_profile_id)
      .eq("pr_number", 7)
      .single();
    expect(link?.confirmed).toBe(false);

    const { count } = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", manualAssignmentId)
      .eq("profile_id", studentB.private_profile_id);
    expect(count ?? 0).toBe(0);
  });

  test("RLS: a student can read their own pr links", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { data, error } = await studentClient
      .from("submission_pr_links")
      .select("id, pr_number, confirmed")
      .eq("assignment_id", prAssignmentId);
    expect(error).toBeNull();
    expect((data ?? []).some((l) => l.pr_number === 1)).toBe(true);
  });

  test("RLS: a student CANNOT write pr links directly (no client UPDATE grant)", async () => {
    const studentClient = await createAuthenticatedClient(studentA);

    const { data: link } = await supabase
      .from("submission_pr_links")
      .select("id, pr_repo, confirmed")
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id)
      .eq("pr_number", 1)
      .single();
    const linkId = link!.id;

    // Attempt to repoint the link at an arbitrary PR and confirm it.
    const { error: updErr } = await studentClient
      .from("submission_pr_links")
      .update({ pr_repo: "attacker/secret-repo", confirmed: true })
      .eq("id", linkId);
    // SELECT-only grant => PostgREST returns a permission error.
    expect(updErr).not.toBeNull();

    // Defense in depth: the row is unchanged regardless of how the client behaves.
    const { data: afterRow } = await supabase
      .from("submission_pr_links")
      .select("pr_repo, confirmed")
      .eq("id", linkId)
      .single();
    expect(afterRow?.pr_repo).toBe(link!.pr_repo);
    expect(afterRow?.pr_repo).not.toBe("attacker/secret-repo");
  });

  test("RLS: a student cannot read another student's pr links", async () => {
    // studentB has no link in prAssignmentId; confirm they can't see studentA's.
    const studentClient = await createAuthenticatedClient(studentB);
    const { data } = await studentClient
      .from("submission_pr_links")
      .select("id")
      .eq("assignment_id", prAssignmentId)
      .eq("profile_id", studentA.private_profile_id);
    expect(data ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A1 — group PR submissions
// ---------------------------------------------------------------------------
// Exercises the per-group branch of ingest_pr_submission (the `p_assignment_group_id`
// path) plus the cross-scope deactivation guard at lines 196-210 of
// 20260605010000_pr_submission_ingest.sql: a group submission must deactivate any
// active *individual* submission held by a member (and vice-versa) so a student
// never ends up with two active submissions on one assignment. Group links key on
// (assignment_group_id, profile_id IS NULL) and auto-confirm as the sole candidate.
test.describe("PR submission mode (group ingest + cross-scope deactivation)", () => {
  test.describe.configure({ timeout: 180_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const UPSTREAM = `pawtograder-playground/pr-group-upstream-${SAFE_ID}`;
  const PR_NUMBER = 11;

  let classId: number;
  let instructor: TestingUser;
  let memberA: TestingUser;
  let memberB: TestingUser;
  let assignmentId: number;
  let groupId: number;

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E PR Group ${RUN_PREFIX}` });
    classId = cls.id;

    // An instructor is required for assignment_groups_members.added_by.
    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `PR Group Instructor ${RUN_PREFIX}`,
      email: `e2e-pr-grp-inst-${SAFE_ID}@pawtograder.net`
    });
    memberA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Group Member A ${RUN_PREFIX}`,
      email: `e2e-pr-grp-a-${SAFE_ID}@pawtograder.net`
    });
    memberB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `PR Group Member B ${RUN_PREFIX}`,
      email: `e2e-pr-grp-b-${SAFE_ID}@pawtograder.net`
    });

    // base_branch identification (auto-confirms a sole candidate), groups enabled.
    const a = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Group base_branch ${RUN_PREFIX}`,
      assignment_slug: `e2e-pr-grp-${SAFE_ID}`
    });
    assignmentId = a.id;
    const { error: cfgErr } = await supabase
      .from("assignments")
      .update({
        submission_mode: "pr",
        upstream_repo: UPSTREAM,
        upstream_base_branch: "main",
        pr_identification: "base_branch",
        group_config: "groups"
      })
      .eq("id", assignmentId);
    expect(cfgErr).toBeNull();
  });

  test("a member's pre-existing individual submission becomes inactive when the group submits", async () => {
    // memberA submits individually FIRST (sole candidate auto-confirms), so there
    // is a live per-profile active submission before the group is formed.
    const { data: indivId, error: indivErr } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: memberA.private_profile_id,
      p_pr_repo: UPSTREAM,
      p_pr_number: 99,
      p_base_sha: "ibase",
      p_head_sha: "ihead",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(indivErr).toBeNull();
    expect(typeof indivId).toBe("number");

    const { data: indivBefore } = await supabase.from("submissions").select("is_active").eq("id", indivId!).single();
    expect(indivBefore?.is_active).toBe(true);

    // Form the group AFTER the individual submission exists.
    const { data: groupData, error: groupErr } = await supabase
      .from("assignment_groups")
      .insert({ name: `PR Group ${RUN_PREFIX}`, class_id: classId, assignment_id: assignmentId })
      .select("id")
      .single();
    expect(groupErr).toBeNull();
    groupId = groupData!.id;

    for (const member of [memberA, memberB]) {
      const { error } = await supabase.from("assignment_groups_members").insert({
        assignment_group_id: groupId,
        profile_id: member.private_profile_id,
        assignment_id: assignmentId,
        class_id: classId,
        added_by: instructor.private_profile_id
      });
      expect(error).toBeNull();
    }

    // Group ingest: profile_id undefined, assignment_group_id set.
    const { data: groupSubId, error } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: undefined,
      p_assignment_group_id: groupId,
      p_pr_repo: UPSTREAM,
      p_pr_number: PR_NUMBER,
      p_base_sha: "gbase0",
      p_head_sha: "ghead0",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();
    expect(typeof groupSubId).toBe("number");

    // The group submission row is keyed on the group, not a profile.
    const { data: groupSub } = await supabase
      .from("submissions")
      .select("assignment_group_id, profile_id, is_active, submitted_via, pr_number, head_sha")
      .eq("id", groupSubId!)
      .single();
    expect(groupSub).toMatchObject({
      assignment_group_id: groupId,
      profile_id: null,
      is_active: true,
      submitted_via: "pr",
      pr_number: PR_NUMBER,
      head_sha: "ghead0"
    });

    // Cross-scope deactivation: the member's prior individual submission is now inactive.
    const { data: indivAfter } = await supabase.from("submissions").select("is_active").eq("id", indivId!).single();
    expect(indivAfter?.is_active).toBe(false);

    // Exactly one active submission across the whole group scope (the members'
    // individual rows + the group row): only the group row.
    const { data: activeRows } = await supabase
      .from("submissions")
      .select("id, assignment_group_id, profile_id")
      .eq("assignment_id", assignmentId)
      .eq("is_active", true);
    expect(activeRows ?? []).toHaveLength(1);
    expect(activeRows![0]).toMatchObject({ id: groupSubId, assignment_group_id: groupId, profile_id: null });
  });

  test("the group's pr link keys on assignment_group_id (profile_id null) and auto-confirmed", async () => {
    const { data: link } = await supabase
      .from("submission_pr_links")
      .select("profile_id, assignment_group_id, confirmed")
      .eq("assignment_id", assignmentId)
      .eq("assignment_group_id", groupId)
      .eq("pr_number", PR_NUMBER)
      .single();
    expect(link).toMatchObject({ profile_id: null, assignment_group_id: groupId, confirmed: true });
  });

  test("a new head sha for the group creates a new active version; prior group version deactivated", async () => {
    const { data: newId, error } = await ingest({
      p_assignment_id: assignmentId,
      p_profile_id: undefined,
      p_assignment_group_id: groupId,
      p_pr_repo: UPSTREAM,
      p_pr_number: PR_NUMBER,
      p_base_sha: "gbase0",
      p_head_sha: "ghead1",
      p_pr_state: "open",
      p_auto_confirm: true
    });
    expect(error).toBeNull();
    expect(typeof newId).toBe("number");

    // Exactly one active row for the group, at the new head; the prior group
    // version (ghead0) is deactivated.
    const { data: active } = await supabase
      .from("submissions")
      .select("id, head_sha, is_active")
      .eq("assignment_id", assignmentId)
      .eq("assignment_group_id", groupId)
      .eq("is_active", true);
    expect(active).toHaveLength(1);
    expect(active![0]).toMatchObject({ id: newId, head_sha: "ghead1" });

    // And still exactly one active row across the entire group scope.
    const { data: allActive } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("is_active", true);
    expect(allActive ?? []).toHaveLength(1);
    expect(allActive![0].id).toBe(newId);
  });
});
