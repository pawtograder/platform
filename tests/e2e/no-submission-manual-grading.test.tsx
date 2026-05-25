import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { createManualSubmission } from "@/lib/edgeFunctions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

type AssignmentWithRubric = Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

/**
 * Direct RPC caller for `create_manual_submission`. The wrapper in
 * lib/edgeFunctions wraps errors in EdgeFunctionError, but a number of tests
 * here want to assert on the raw PostgREST/PostgreSQL error message, so we
 * call the RPC directly and surface the result/error pair.
 *
 * The generated `Database` type doesn't yet include the new RPC (the typegen
 * runs against the schema in `utils/supabase/SupabaseTypes.d.ts`), so we cast
 * `rpc` to a callable to mirror what edgeFunctions.ts does internally.
 */
async function rpcCreateManualSubmission(
  client: SupabaseClient<Database>,
  params: { assignment_id: number; profile_id?: string | null; assignment_group_id?: number | null }
): Promise<{ data: number | null; error: { message: string; code?: string } | null }> {
  const { data, error } = await (client.rpc as CallableFunction)("create_manual_submission", {
    p_assignment_id: params.assignment_id,
    p_profile_id: params.profile_id ?? null,
    p_assignment_group_id: params.assignment_group_id ?? null
  });
  return { data: data as number | null, error: error as { message: string; code?: string } | null };
}

// The generated `Database` type predates this PR, so it doesn't yet include
// the `submitted_via` column on `submissions`. The migration in this PR adds
// the column; once `npm run client-local` is run post-merge the cast can be
// removed. Until then we shape the result manually.
type ManualSubmissionRow = {
  id: number;
  assignment_id: number;
  class_id: number;
  profile_id: string | null;
  assignment_group_id: number | null;
  repository: string | null;
  sha: string | null;
  is_active: boolean;
  submitted_via: string | null;
  ordinal: number;
  run_number: number;
};

async function fetchSubmission(submissionId: number): Promise<ManualSubmissionRow> {
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", submissionId)
    .single();
  if (error) throw new Error(`Failed to fetch submission ${submissionId}: ${error.message}`);
  return data as unknown as ManualSubmissionRow;
}

async function fetchActiveSubmissionsFor(params: {
  assignment_id: number;
  profile_id?: string;
  assignment_group_id?: number;
}): Promise<Array<Pick<ManualSubmissionRow, "id" | "profile_id" | "assignment_group_id" | "is_active" | "submitted_via">>> {
  let q = supabase
    .from("submissions")
    .select("id, profile_id, assignment_group_id, is_active")
    .eq("assignment_id", params.assignment_id)
    .eq("is_active", true);
  if (params.profile_id !== undefined) q = q.eq("profile_id", params.profile_id);
  if (params.assignment_group_id !== undefined) q = q.eq("assignment_group_id", params.assignment_group_id);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list active submissions: ${error.message}`);
  return (data ?? []) as unknown as Array<
    Pick<ManualSubmissionRow, "id" | "profile_id" | "assignment_group_id" | "is_active" | "submitted_via">
  >;
}

test.describe("Manual submission RPC (repo_mode='no_submission')", () => {
  test.describe.configure({ mode: "serial" });

  const runPrefix = getTestRunPrefix();
  // getTestRunPrefix() embeds the current date with "/" and ":" — not valid in
  // email local-parts. Use a clean alphanumeric identifier for emails/slugs.
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let course: Course;
  let otherCourse: Course;
  let instructor: TestingUser;
  let otherInstructor: TestingUser;
  let grader: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser;
  let studentC: TestingUser;
  let instructorClient: SupabaseClient<Database>;
  let otherInstructorClient: SupabaseClient<Database>;
  let graderClient: SupabaseClient<Database>;
  let studentAClient: SupabaseClient<Database>;

  test.beforeAll(async () => {
    course = await createClass({ name: `Manual Submission RPC ${runPrefix}` });
    otherCourse = await createClass({ name: `Manual Submission RPC Other ${runPrefix}` });

    [instructor, grader, studentA, studentB, studentC] = await createUsersInClass([
      {
        name: "Manual Sub Instructor",
        public_profile_name: "Manual Sub Pseudonym Instructor",
        email: `manual-sub-instructor-${SAFE_ID}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Manual Sub Grader",
        public_profile_name: "Manual Sub Pseudonym Grader",
        email: `manual-sub-grader-${SAFE_ID}@pawtograder.net`,
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Manual Sub Student A",
        public_profile_name: "Manual Sub Pseudonym Student A",
        email: `manual-sub-student-a-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Manual Sub Student B",
        public_profile_name: "Manual Sub Pseudonym Student B",
        email: `manual-sub-student-b-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Manual Sub Student C",
        public_profile_name: "Manual Sub Pseudonym Student C",
        email: `manual-sub-student-c-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    [otherInstructor] = await createUsersInClass([
      {
        name: "Manual Sub Other Instructor",
        public_profile_name: "Manual Sub Pseudonym Other Instructor",
        email: `manual-sub-other-instructor-${SAFE_ID}@pawtograder.net`,
        role: "instructor",
        class_id: otherCourse.id,
        useMagicLink: true
      }
    ]);

    instructorClient = await createAuthenticatedClient(instructor);
    otherInstructorClient = await createAuthenticatedClient(otherInstructor);
    graderClient = await createAuthenticatedClient(grader);
    studentAClient = await createAuthenticatedClient(studentA);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([instructor, grader, studentA, studentB, studentC, otherInstructor]);
  });

  // ──────────────── 1. Happy path — per-profile ────────────────

  test.describe("Per-profile happy path & idempotency", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let submissionId: number;

    test("setup: assignment with repo_mode='no_submission'", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `No-Submission Individual ${runPrefix}`,
        repo_mode: "no_submission"
      });
      expect(assignment.repo_mode).toBe("no_submission");
    });

    test("instructor can create a per-profile manual submission", async () => {
      const { data: returnedId, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(error).toBeNull();
      expect(typeof returnedId).toBe("number");
      expect(returnedId).toBeGreaterThan(0);
      submissionId = returnedId as number;

      const sub = await fetchSubmission(submissionId);
      expect(sub.assignment_id).toBe(assignment.id);
      expect(sub.class_id).toBe(course.id);
      expect(sub.profile_id).toBe(studentA.private_profile_id);
      expect(sub.assignment_group_id).toBeNull();
      expect(sub.repository).toBeNull();
      expect(sub.sha).toBeNull();
      expect(sub.is_active).toBe(true);
      expect(sub.submitted_via).toBe("manual");
    });

    test("no submission_files rows are created for a manual submission", async () => {
      const { data, error } = await supabase
        .from("submission_files")
        .select("id")
        .eq("submission_id", submissionId);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    test("calling again with the same (assignment, profile) returns the existing id (idempotent)", async () => {
      const { data: secondId, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(error).toBeNull();
      expect(secondId).toBe(submissionId);

      const active = await fetchActiveSubmissionsFor({
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      // The migration short-circuits on an existing active row, so there
      // should still be exactly one active submission for this profile/assignment.
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(submissionId);
    });

    test("createManualSubmission wrapper returns the same id (smoke-test the wrapper)", async () => {
      const id = await createManualSubmission(
        { assignment_id: assignment.id, profile_id: studentA.private_profile_id },
        instructorClient
      );
      expect(id).toBe(submissionId);
    });

    test("stub submission can be graded end-to-end via rubric check comment", async () => {
      // The submission auto-spawns two reviews (grading + self-review), so use
      // submissions.grading_review_id to grab the grading one specifically.
      const { data: submissionRow, error: submissionErr } = await supabase
        .from("submissions")
        .select("grading_review_id")
        .eq("id", submissionId)
        .single();
      expect(submissionErr).toBeNull();
      expect(submissionRow?.grading_review_id).not.toBeNull();
      const reviewId = submissionRow!.grading_review_id!;
      const { data: review, error: reviewError } = await supabase
        .from("submission_reviews")
        .select("id, total_score")
        .eq("id", reviewId)
        .single();
      expect(reviewError).toBeNull();
      expect(review).not.toBeNull();

      const gradingCheck = assignment.rubricChecks.find((c) => c.name === "Grading Review Check 2");
      expect(gradingCheck).toBeDefined();

      // Apply an instructor-authored rubric comment with points; the
      // submission_reviews trigger should recompute total_score.
      const { error: insertError } = await supabase.from("submission_comments").insert({
        submission_id: submissionId,
        submission_review_id: reviewId,
        rubric_check_id: gradingCheck!.id,
        class_id: course.id,
        author: instructor.private_profile_id,
        comment: "Manual grading comment for stub submission",
        points: 9,
        released: false,
        eventually_visible: true,
        regrade_request_id: null
      });
      expect(insertError).toBeNull();

      // Allow the recompute trigger to settle.
      await new Promise((r) => setTimeout(r, 750));

      const { data: updatedReview, error: refreshError } = await supabase
        .from("submission_reviews")
        .select("total_score")
        .eq("id", reviewId)
        .single();
      expect(refreshError).toBeNull();
      expect(updatedReview!.total_score).toBeGreaterThanOrEqual(9);
    });
  });

  // ──────────────── 2. Happy path — per-group ────────────────

  test.describe("Per-group happy path", () => {
    test.describe.configure({ mode: "serial" });

    let assignment: AssignmentWithRubric;
    let groupId: number;
    let submissionId: number;

    test("setup: group-mode no_submission assignment + 2-student group", async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `No-Submission Group ${runPrefix}`,
        repo_mode: "no_submission",
        group_config: "groups"
      });

      const { data: groupData, error: groupErr } = await supabase
        .from("assignment_groups")
        .insert({
          name: `Manual Sub Group ${runPrefix}`,
          class_id: course.id,
          assignment_id: assignment.id
        })
        .select("id")
        .single();
      if (groupErr) throw new Error(`Failed to create group: ${groupErr.message}`);
      groupId = groupData.id;

      for (const student of [studentB, studentC]) {
        const { error } = await supabase.from("assignment_groups_members").insert({
          assignment_group_id: groupId,
          profile_id: student.private_profile_id,
          assignment_id: assignment.id,
          class_id: course.id,
          added_by: instructor.private_profile_id
        });
        if (error) throw new Error(`Failed to add group member: ${error.message}`);
      }
    });

    test("instructor can create a per-group manual submission", async () => {
      const { data: returnedId, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        assignment_group_id: groupId
      });
      expect(error).toBeNull();
      expect(typeof returnedId).toBe("number");
      submissionId = returnedId as number;

      const sub = await fetchSubmission(submissionId);
      expect(sub.assignment_id).toBe(assignment.id);
      expect(sub.assignment_group_id).toBe(groupId);
      expect(sub.profile_id).toBeNull();
      expect(sub.repository).toBeNull();
      expect(sub.sha).toBeNull();
      expect(sub.is_active).toBe(true);
      expect(sub.submitted_via).toBe("manual");
    });

    test("calling again with the same (assignment, group) is idempotent", async () => {
      const { data: secondId, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        assignment_group_id: groupId
      });
      expect(error).toBeNull();
      expect(secondId).toBe(submissionId);

      const active = await fetchActiveSubmissionsFor({
        assignment_id: assignment.id,
        assignment_group_id: groupId
      });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(submissionId);
    });

    test("group from a different assignment is rejected (assignment_group ↔ assignment cross-check)", async () => {
      // Make a second no_submission assignment in the same class…
      const otherAssignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `No-Submission Group Other ${runPrefix}`,
        repo_mode: "no_submission",
        group_config: "groups"
      });
      // …and try to register the first assignment's group against it.
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: otherAssignment.id,
        assignment_group_id: groupId
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/belongs to assignment|group/);
    });
  });

  // ──────────────── 3. Wrong-mode rejection ────────────────

  test.describe("Wrong repo_mode is rejected", () => {
    test("repo_mode='none' rejects create_manual_submission", async () => {
      const a = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `Wrong Mode None ${runPrefix}`,
        repo_mode: "none"
      });
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: a.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // Migration uses: "Assignment % is not in no_submission mode (repo_mode=%)"
      expect(error!.message.toLowerCase()).toMatch(/no_submission|repo_mode/);
    });

    test("repo_mode='template_only_staff' rejects create_manual_submission", async () => {
      const a = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `Wrong Mode Template ${runPrefix}`,
        repo_mode: "template_only_staff"
      });
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: a.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/no_submission|repo_mode/);
    });

    test("nonexistent assignment id fails with 'not found'", async () => {
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: 2_147_483_000,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/not found/);
    });
  });

  // ──────────────── 4. Non-instructor cannot call the RPC ────────────────

  test.describe("Authorization", () => {
    let assignment: AssignmentWithRubric;

    test.beforeAll(async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `No-Submission AuthZ ${runPrefix}`,
        repo_mode: "no_submission"
      });
    });

    test("student in the class cannot call create_manual_submission", async () => {
      const { data, error } = await rpcCreateManualSubmission(studentAClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // Migration raises with errcode '42501' and message containing "only instructors"
      expect(error!.message.toLowerCase()).toMatch(/instructor|access denied|permission/);
    });

    test("grader in the class cannot call create_manual_submission (instructor-only)", async () => {
      // authorizeforclassinstructor() checks role='instructor' only — graders
      // are explicitly excluded. If a future migration relaxes this, update
      // both the migration AND this expectation.
      const { data, error } = await rpcCreateManualSubmission(graderClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/instructor|access denied|permission/);
    });

    test("instructor of a DIFFERENT class cannot call the RPC for this assignment", async () => {
      const { data, error } = await rpcCreateManualSubmission(otherInstructorClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/instructor|access denied|permission/);
    });

    test("anonymous (unauthenticated) caller fails with auth error", async () => {
      const anonClient = (await import("@supabase/supabase-js")).createClient<Database>(
        process.env.SUPABASE_URL!,
        (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!
      );
      const { data, error } = await rpcCreateManualSubmission(anonClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // Migration: `raise exception 'Must be authenticated' using errcode = '42501'`.
      // PostgREST may surface this as either the SQLSTATE 42501 path
      // ("permission denied") or the raw RAISE message; both indicate auth gating.
      expect(error!.message.toLowerCase()).toMatch(/authenticated|permission|denied|jwt/);
    });
  });

  // ──────────────── 5. Argument XOR ────────────────

  test.describe("Argument XOR (exactly one of profile_id / assignment_group_id)", () => {
    let assignment: AssignmentWithRubric;
    let groupId: number;

    test.beforeAll(async () => {
      assignment = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `No-Submission XOR ${runPrefix}`,
        repo_mode: "no_submission",
        group_config: "groups"
      });
      const { data: groupData, error: groupErr } = await supabase
        .from("assignment_groups")
        .insert({
          name: `XOR Group ${runPrefix}`,
          class_id: course.id,
          assignment_id: assignment.id
        })
        .select("id")
        .single();
      if (groupErr) throw new Error(`Failed to create XOR group: ${groupErr.message}`);
      groupId = groupData.id;
      const { error: memberErr } = await supabase.from("assignment_groups_members").insert({
        assignment_group_id: groupId,
        profile_id: studentA.private_profile_id,
        assignment_id: assignment.id,
        class_id: course.id,
        added_by: instructor.private_profile_id
      });
      if (memberErr) throw new Error(`Failed to add XOR group member: ${memberErr.message}`);
    });

    test("both null → error", async () => {
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        profile_id: null,
        assignment_group_id: null
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // Migration: "Exactly one of p_profile_id or p_assignment_group_id must be provided"
      expect(error!.message.toLowerCase()).toMatch(/exactly one|p_profile_id|p_assignment_group_id/);
    });

    test("both set → error", async () => {
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: assignment.id,
        profile_id: studentA.private_profile_id,
        assignment_group_id: groupId
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message.toLowerCase()).toMatch(/exactly one|p_profile_id|p_assignment_group_id/);
    });
  });
});
