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

async function insertCheckRun(sha: string, message: string, daysAgo: number) {
  const { error } = await ADMIN()
    .from("repository_check_runs")
    .insert({
      class_id: course.id,
      repository_id: repoId,
      check_run_id: Math.floor(Math.random() * 1_000_000),
      sha,
      commit_message: message,
      profile_id: student.private_profile_id,
      status: { commit_date: subDays(new Date(), daysAgo).toISOString() }
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
    p_old_due_date: oldDue
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
      p_old_due_date: oldDue
    });
    expect(blocked.error).not.toBeNull();

    // Instructor enumerates -> exactly the in-window commit.
    const { data: batchId, error } = await instructorClient.rpc("enumerate_deadline_regrade_candidates", {
      p_assignment_id: assignment.id,
      p_old_due_date: oldDue
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
      p_old_due_date: oldDue
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
      p_old_due_date: oldDue
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
});
