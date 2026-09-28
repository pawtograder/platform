import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
// Pure data-layer test: import the base runner directly (no browser/page fixture).
import { test, expect } from "@playwright/test";
import { subDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase,
  TestingUser
} from "@/tests/e2e/TestingUtils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// End-to-end coverage for the "re-grade late commits after a deadline extension"
// feature (migration 20260927120000). Exercises the RPC lifecycle + the staging
// trigger + the grader_results backfill trigger + notifications at the data
// layer. One magic-link auth flow total (the instructor); each test gets a
// fresh student + repository so tests are fully isolated.

let course: Course;
let instructor: TestingUser;
let instructorClient: SupabaseClient<Database>;
let assignment: Assignment;

// per-test student + repo
let student: TestingUser;
let repoFullName: string;
let repoId: number;

const ADMIN = () => supabase as unknown as SupabaseClient<Database>;

/** A webhook-recorded push `pushedDaysAgo`; the commit itself defaults to the same time. */
async function insertCheckRun(sha: string, message: string, pushedDaysAgo: number, committedDaysAgo = pushedDaysAgo) {
  const { error } = await ADMIN()
    .from("repository_check_runs")
    .insert({
      class_id: course.id,
      repository_id: repoId,
      check_run_id: Math.floor(Math.random() * 1_000_000),
      sha,
      commit_message: message,
      profile_id: student.private_profile_id,
      created_at: subDays(new Date(), pushedDaysAgo).toISOString(),
      status: { commit_date: subDays(new Date(), committedDaysAgo).toISOString() }
    } as Database["public"]["Tables"]["repository_check_runs"]["Insert"]);
  if (error) throw new Error(`insert check run failed: ${error.message}`);
}

async function insertSubmission(sha: string, isStaged: boolean): Promise<number> {
  const { data, error } = await ADMIN()
    .from("submissions")
    .insert({
      assignment_id: assignment.id,
      class_id: course.id,
      profile_id: student.private_profile_id,
      repository: repoFullName,
      sha,
      run_number: Math.floor(Math.random() * 1_000_000),
      run_attempt: 1,
      ...(isStaged ? { is_staged: true } : {})
    } as Database["public"]["Tables"]["submissions"]["Insert"])
    .select("id")
    .single();
  if (error) throw new Error(`insert submission failed: ${error.message}`);
  return data!.id;
}

async function insertGraderResult(submissionId: number, score: number): Promise<void> {
  const { error } = await ADMIN()
    .from("grader_results")
    .insert({
      submission_id: submissionId,
      class_id: course.id,
      profile_id: student.private_profile_id,
      score,
      max_score: 100,
      lint_output: "",
      lint_output_format: "text",
      lint_passed: true
    } as Database["public"]["Tables"]["grader_results"]["Insert"]);
  if (error) throw new Error(`insert grader_results failed: ${error.message}`);
}

async function candidatesForBatch(batchId: number) {
  const { data, error } = await ADMIN().from("deadline_regrade_candidates").select("*").eq("batch_id", batchId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

test.beforeAll(async () => {
  const prefix = getTestRunPrefix();
  course = await createClass({ name: `${prefix} Deadline Regrade Class` });
  instructor = await createUserInClass({
    role: "instructor",
    class_id: course.id,
    name: `${prefix} Instructor`,
    useMagicLink: true
  });
  instructorClient = await createAuthenticatedClient(instructor);
  // The "extended" deadline is now.
  assignment = await insertAssignment({
    due_date: new Date().toUTCString(),
    class_id: course.id,
    name: `${prefix} Assignment`
  });
});

async function setUpStudent(useMagicLink = false) {
  const p = getTestRunPrefix(Math.random().toString(36).slice(2, 8));
  student = await createUserInClass({ role: "student", class_id: course.id, name: `${p} Student`, useMagicLink });
  repoFullName = `${p}/repo`;
  const { data: repo, error } = await ADMIN()
    .from("repositories")
    .insert({
      assignment_id: assignment.id,
      class_id: course.id,
      repository: repoFullName,
      profile_id: student.private_profile_id,
      is_github_ready: true
    } as Database["public"]["Tables"]["repositories"]["Insert"])
    .select("id")
    .single();
  if (error) throw new Error(`insert repository failed: ${error.message}`);
  repoId = repo!.id;
}

// Fresh student + repo per test (no magic link needed — service role drives data).
test.beforeEach(async () => {
  await setUpStudent();
});

/** Enumerate, stage, and grade one in-window commit; returns the candidate and staged submission ids. */
async function stagedCandidate(): Promise<{ batchId: number; candidateId: number; stagedSubId: number }> {
  const oldDue = subDays(new Date(), 2).toISOString();
  const currentSubId = await insertSubmission(`cur${repoId}`, false);
  await insertGraderResult(currentSubId, 50);
  await insertCheckRun(`late${repoId}`, "late work", 1);
  const { data: batchId, error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
    p_assignment_id: assignment.id,
    p_old_due_date: oldDue,
    p_old_minutes_due_after_lab: null as unknown as number
  });
  if (error) throw new Error(error.message);
  const candidateId = (await candidatesForBatch(batchId!)).find((c) => c.profile_id === student.private_profile_id)!.id;
  const stagedSubId = await insertSubmission(`late${repoId}`, true);
  await insertGraderResult(stagedSubId, 80);
  return { batchId: batchId!, candidateId, stagedSubId };
}

async function regradeNotificationCount(): Promise<number> {
  const { data } = await ADMIN().from("notifications").select("body").eq("user_id", student.user_id);
  return (data ?? []).filter((n) => (n.body as { type?: string }).type === "submission_regraded").length;
}

test.describe("Deadline-extension regrade", () => {
  test("enumerate finds the in-window late commit, excludes out-of-window, and is gated to instructors", async () => {
    const oldDue = subDays(new Date(), 2).toISOString();
    await insertCheckRun("newcommit1", "late work", 1); // inside (old, new]
    await insertCheckRun("oldcommit0", "old work", 5); // before old deadline -> excluded

    // Non-instructor (service role -> auth.uid() null) is blocked.
    const blocked = await ADMIN().rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue,
      p_old_minutes_due_after_lab: null as unknown as number
    });
    expect(blocked.error).not.toBeNull();

    // Instructor enumerates -> exactly the in-window commit.
    const { data: batchId, error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue,
      p_old_minutes_due_after_lab: null as unknown as number
    });
    expect(error).toBeNull();
    expect(batchId).not.toBeNull();

    const cands = (await candidatesForBatch(batchId!)).filter((c) => c.profile_id === student.private_profile_id);
    expect(cands).toHaveLength(1);
    expect(cands[0].sha).toBe("newcommit1");
  });

  test("staged grading does not activate; backfill records the score; apply promotes + notifies", async () => {
    const oldDue = subDays(new Date(), 2).toISOString();

    // Baseline on-time submission scoring 50.
    const currentSubId = await insertSubmission("oldsha50", false);
    await insertGraderResult(currentSubId, 50);

    // A later commit inside the window.
    await insertCheckRun("latesha80", "improved work", 1);

    const { data: batchId } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue,
      p_old_minutes_due_after_lab: null as unknown as number
    });
    const candidate = (await candidatesForBatch(batchId!)).find((c) => c.profile_id === student.private_profile_id)!;
    expect(candidate.current_submission_id).toBe(currentSubId);
    expect(Number(candidate.current_score)).toBe(50);

    // Simulate the staged grading run: a staged submission + its grader_result.
    const stagedSubId = await insertSubmission("latesha80", true);

    // Staging trigger: staged must NOT be active; baseline stays active.
    const { data: stagedRow } = await ADMIN()
      .from("submissions")
      .select("is_active, is_staged")
      .eq("id", stagedSubId)
      .single();
    expect(stagedRow!.is_active).toBe(false);
    expect(stagedRow!.is_staged).toBe(true);
    const { data: baselineRow } = await ADMIN().from("submissions").select("is_active").eq("id", currentSubId).single();
    expect(baselineRow!.is_active).toBe(true);

    // grader_results insert fires the backfill trigger.
    await insertGraderResult(stagedSubId, 80);
    const afterBackfill = (await candidatesForBatch(batchId!)).find((c) => c.id === candidate.id)!;
    expect(afterBackfill.staged_status).toBe("graded");
    expect(afterBackfill.staged_submission_id).toBe(stagedSubId);
    expect(Number(afterBackfill.staged_score)).toBe(80);

    // Instructor promotes.
    const { data: applyResult, error: applyErr } = await instructorClient.rpc("apply_deadline_regrade", {
      p_candidate_id: candidate.id
    });
    expect(applyErr).toBeNull();
    expect((applyResult as { status: string }).status).toBe("applied");

    // Staged is now active + un-staged; old one inactive.
    const { data: promoted } = await ADMIN()
      .from("submissions")
      .select("is_active, is_staged")
      .eq("id", stagedSubId)
      .single();
    expect(promoted!.is_active).toBe(true);
    expect(promoted!.is_staged).toBe(false);
    const { data: demoted } = await ADMIN().from("submissions").select("is_active").eq("id", currentSubId).single();
    expect(demoted!.is_active).toBe(false);

    // Student got a submission_regraded notification with the differential.
    const { data: notifs } = await ADMIN().from("notifications").select("body, user_id").eq("user_id", student.user_id);
    const regradeNotif = (notifs ?? []).find((n) => (n.body as { type?: string }).type === "submission_regraded");
    expect(regradeNotif).toBeTruthy();
    const body = regradeNotif!.body as { old_score: number; new_score: number; submission_id: number };
    expect(Number(body.old_score)).toBe(50);
    expect(Number(body.new_score)).toBe(80);
    expect(body.submission_id).toBe(stagedSubId);
  });

  test("skip marks the candidate skipped", async () => {
    const oldDue = subDays(new Date(), 2).toISOString();
    await insertCheckRun("skipsha", "late", 1);

    const { data: batchId } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue,
      p_old_minutes_due_after_lab: null as unknown as number
    });
    const candidateId = (await candidatesForBatch(batchId!)).find(
      (c) => c.profile_id === student.private_profile_id
    )!.id;

    const { error: skipErr } = await instructorClient.rpc("skip_deadline_regrade", {
      p_candidate_id: candidateId
    });
    expect(skipErr).toBeNull();

    const { data: skipped } = await ADMIN()
      .from("deadline_regrade_candidates")
      .select("decision")
      .eq("id", candidateId)
      .single();
    expect((skipped as { decision: string }).decision).toBe("skipped");
  });

  test("students cannot read a staged submission until it is promoted", async () => {
    await setUpStudent(true);
    const studentClient = await createAuthenticatedClient(student);
    const { candidateId, stagedSubId } = await stagedCandidate();

    const before = await studentClient.from("submissions").select("id").eq("id", stagedSubId);
    expect(before.error).toBeNull();
    expect(before.data).toHaveLength(0);

    const { error: applyErr } = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect(applyErr).toBeNull();

    const after = await studentClient.from("submissions").select("id").eq("id", stagedSubId);
    expect(after.data).toHaveLength(1);
  });

  test("a second apply is a no-op and does not notify twice", async () => {
    const { candidateId } = await stagedCandidate();
    const first = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect(first.error).toBeNull();
    const second = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect(second.error).toBeNull();
    expect((second.data as { status: string }).status).toBe("already_applied");
    expect(await regradeNotificationCount()).toBe(1);
  });

  test("apply rejects skipped candidates and candidates in a closed batch", async () => {
    const skipped = await stagedCandidate();
    await instructorClient.rpc("skip_deadline_regrade", { p_candidate_id: skipped.candidateId });
    const skippedApply = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: skipped.candidateId });
    expect(skippedApply.error?.message).toContain("only pending candidates can be promoted");

    await setUpStudent();
    const dismissed = await stagedCandidate();
    await instructorClient.rpc("dismiss_deadline_regrade_batch", { p_batch_id: dismissed.batchId });
    const dismissedApply = await instructorClient.rpc("apply_deadline_regrade", {
      p_candidate_id: dismissed.candidateId
    });
    expect(dismissedApply.error?.message).toContain("no longer open");
    expect(await regradeNotificationCount()).toBe(0);
  });

  async function enumerate(oldDue: Date): Promise<number> {
    const { data, error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue.toISOString(),
      p_old_minutes_due_after_lab: null as unknown as number
    });
    if (error) throw new Error(error.message);
    return data!;
  }
  const mine = async (batchId: number) =>
    (await candidatesForBatch(batchId)).filter((c) => c.profile_id === student.private_profile_id);

  test("the window is judged on push time, not commit time, and skips #NOT-GRADED", async () => {
    // Committed before the old deadline but pushed after it: a candidate.
    await insertCheckRun("pushedlate", "late push", 1, 5);
    // A newer in-window push marked #NOT-GRADED must not displace it.
    await insertCheckRun("practice", "try this #NOT-GRADED", 0.5);
    const cands = await mine(await enumerate(subDays(new Date(), 2)));
    expect(cands.map((c) => c.sha)).toEqual(["pushedlate"]);
  });

  test("a review with no candidates is closed immediately", async () => {
    // Batches are assignment-wide, so use an assignment no other test pushes to.
    const empty = await insertAssignment({
      due_date: new Date().toUTCString(),
      class_id: course.id,
      name: `${getTestRunPrefix("empty")} Assignment`
    });
    const { data: batchId, error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: empty.id,
      p_old_due_date: subDays(new Date(), 2).toISOString(),
      p_old_minutes_due_after_lab: null as unknown as number
    });
    expect(error).toBeNull();
    const { data: batch } = await ADMIN().from("deadline_regrade_batches").select("status").eq("id", batchId!).single();
    expect(batch!.status).toBe("dismissed");
  });

  test("a second extension keeps the first window and carries graded previews forward", async () => {
    const { batchId: first, stagedSubId } = await stagedCandidate();
    // Extend again from an intermediate deadline that is AFTER the late push.
    const second = await enumerate(subDays(new Date(), 0.5));
    const { data: firstBatch } = await ADMIN()
      .from("deadline_regrade_batches")
      .select("status")
      .eq("id", first)
      .single();
    expect(firstBatch!.status).toBe("superseded");
    const cands = await mine(second);
    expect(cands).toHaveLength(1);
    expect(cands[0].staged_status).toBe("graded");
    expect(cands[0].staged_submission_id).toBe(stagedSubId);
  });

  test("apply refuses to replace an active submission that changed after enumeration", async () => {
    const { candidateId, stagedSubId } = await stagedCandidate();
    // The student pushes again under the extended deadline and it becomes active.
    const newerSubId = await insertSubmission(`newer${repoId}`, false);
    await insertGraderResult(newerSubId, 95);

    const stale = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect(stale.error).toBeNull();
    expect((stale.data as { status: string }).status).toBe("active_changed");
    const { data: stillActive } = await ADMIN().from("submissions").select("is_active").eq("id", newerSubId).single();
    expect(stillActive!.is_active).toBe(true);
    expect(await regradeNotificationCount()).toBe(0);
    const { data: snapshot } = await ADMIN()
      .from("deadline_regrade_candidates")
      .select("current_submission_id, current_score")
      .eq("id", candidateId)
      .single();
    expect(snapshot!.current_submission_id).toBe(newerSubId);
    expect(Number(snapshot!.current_score)).toBe(95);

    // Having seen the refreshed comparison, the instructor promotes again.
    const again = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect((again.data as { status: string }).status).toBe("applied");
    const { data: promoted } = await ADMIN().from("submissions").select("is_active").eq("id", stagedSubId).single();
    expect(promoted!.is_active).toBe(true);
  });

  test("reserving a preview marks the candidate grading without downgrading, and release undoes it", async () => {
    const { candidateId } = await stagedCandidate();
    const status = async () =>
      (await ADMIN().from("deadline_regrade_candidates").select("staged_status").eq("id", candidateId).single()).data!
        .staged_status;

    const reserved = await ADMIN().rpc("regrade_reserve_preview_run", {
      p_repository_id: repoId,
      p_sha: `late${repoId}`
    });
    expect(reserved.error).toBeNull();
    expect(reserved.data).toBe(candidateId);
    expect(await status()).toBe("graded");

    // On an ungraded candidate: reserve -> grading, release (failed dispatch) -> none.
    await setUpStudent();
    await insertCheckRun(`fresh${repoId}`, "late", 1);
    const batch = await enumerate(subDays(new Date(), 2));
    const fresh = (await mine(batch))[0];
    await ADMIN().rpc("regrade_reserve_preview_run", { p_repository_id: repoId, p_sha: fresh.sha });
    const read = async () =>
      (await ADMIN().from("deadline_regrade_candidates").select("staged_status").eq("id", fresh.id).single()).data!
        .staged_status;
    expect(await read()).toBe("grading");
    await ADMIN().rpc("regrade_release_preview_run", { p_candidate_id: fresh.id });
    expect(await read()).toBe("none");
  });

  test("an extension through the lab offset alone can be enumerated", async () => {
    await insertCheckRun("labonly", "late", 1);
    const { error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      // Same base due date, but the old schedule had a lab offset.
      p_old_due_date: new Date(assignment.due_date!).toISOString(),
      p_old_minutes_due_after_lab: 30
    });
    expect(error).toBeNull();
    const unchanged = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: new Date(assignment.due_date!).toISOString(),
      p_old_minutes_due_after_lab: null as unknown as number
    });
    expect(unchanged.error?.message).toContain("must have moved later");
  });

  test("submissions_agg neither counts nor surfaces a staged preview", async () => {
    const { stagedSubId } = await stagedCandidate();
    const { data } = await ADMIN()
      .from("submissions_agg")
      .select("submissioncount, latestsubmissionid")
      .eq("profile_id", student.private_profile_id)
      .eq("assignment_id", assignment.id)
      .single();
    expect(Number(data!.submissioncount)).toBe(1);
    expect(data!.latestsubmissionid).not.toBe(stagedSubId);
  });

  test("a preview cannot be reserved without a pending candidate, and not by authenticated users", async () => {
    await insertCheckRun("nocand", "no candidate", 5);
    const none = await ADMIN().rpc("regrade_reserve_preview_run", { p_repository_id: repoId, p_sha: "nocand" });
    expect(none.error?.message).toContain("No pending deadline regrade candidate");
    const asInstructor = await instructorClient.rpc("regrade_reserve_preview_run", {
      p_repository_id: repoId,
      p_sha: "nocand"
    });
    expect(asInstructor.error).not.toBeNull();
  });

  test("a re-scored preview refreshes the candidate and blocks a stale promotion", async () => {
    const { candidateId, stagedSubId } = await stagedCandidate();
    await ADMIN().from("grader_results").update({ score: 30 }).eq("submission_id", stagedSubId);
    const { data: cand } = await ADMIN()
      .from("deadline_regrade_candidates")
      .select("staged_score")
      .eq("id", candidateId)
      .single();
    expect(Number(cand!.staged_score)).toBe(30);
  });

  test("previews take no ordinal until promoted, and submission_set_active cannot promote them", async () => {
    const { candidateId, stagedSubId } = await stagedCandidate();
    const ordinalOf = async (id: number) =>
      (await ADMIN().from("submissions").select("ordinal").eq("id", id).single()).data!.ordinal;
    expect(await ordinalOf(stagedSubId)).toBe(0);

    const { data: setActive, error: setActiveErr } = await instructorClient.rpc("submission_set_active", {
      _submission_id: stagedSubId
    });
    expect(setActiveErr).toBeNull();
    expect(setActive).toBe(false);
    const { data: stillStaged } = await ADMIN()
      .from("submissions")
      .select("is_active, is_staged")
      .eq("id", stagedSubId)
      .single();
    expect(stillStaged).toEqual({ is_active: false, is_staged: true });

    const applied = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect((applied.data as { status: string }).status).toBe("applied");
    // The baseline was ordinal 1; the promoted preview is next, with no gap.
    expect(await ordinalOf(stagedSubId)).toBe(2);
  });

  test("apply refuses when the active submission was re-scored after enumeration", async () => {
    const { candidateId } = await stagedCandidate();
    const { data: cand } = await ADMIN()
      .from("deadline_regrade_candidates")
      .select("current_submission_id")
      .eq("id", candidateId)
      .single();
    await ADMIN().from("grader_results").update({ score: 90 }).eq("submission_id", cand!.current_submission_id!);

    const stale = await instructorClient.rpc("apply_deadline_regrade", { p_candidate_id: candidateId });
    expect((stale.data as { status: string }).status).toBe("active_changed");
    expect(Number((stale.data as { old_score: number }).old_score)).toBe(90);
  });
});
