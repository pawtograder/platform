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
  createUserInClass,
  createUsersInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase,
  TestingUser
} from "./TestingUtils";
import { randomBytes } from "node:crypto";

dotenv.config({ path: ".env.local", quiet: true });

type AssignmentWithRubric = Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] };

/**
 * Direct RPC caller for `create_manual_submission`. The wrapper in
 * lib/edgeFunctions wraps errors in EdgeFunctionError, but a number of tests
 * here want to assert on the raw PostgREST/PostgreSQL error message, so we
 * call the RPC directly and surface the result/error pair.
 *
 * We cast `rpc` to a callable to mirror what edgeFunctions.ts does internally:
 * it lets us pass explicit `null` arguments without fighting the strict
 * generated arg typing.
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

// A trimmed-down view of the `submissions` row shape that these tests assert
// against. We keep a local type (rather than deriving from the generated
// `Database` type) so the tests document exactly which columns they rely on.
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
  const { data, error } = await supabase.from("submissions").select("*").eq("id", submissionId).single();
  if (error) throw new Error(`Failed to fetch submission ${submissionId}: ${error.message}`);
  return data as unknown as ManualSubmissionRow;
}

async function fetchActiveSubmissionsFor(params: {
  assignment_id: number;
  profile_id?: string;
  assignment_group_id?: number;
}): Promise<Array<Pick<ManualSubmissionRow, "id" | "profile_id" | "assignment_group_id" | "is_active">>> {
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
    Pick<ManualSubmissionRow, "id" | "profile_id" | "assignment_group_id" | "is_active">
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
      const { data, error } = await supabase.from("submission_files").select("id").eq("submission_id", submissionId);
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

  // ──────────────── 3. Any repo_mode is allowed (submission-optional) ────────────────

  // Grading a student without a submission is now supported for ANY assignment
  // type, not just repo_mode='no_submission' — the stub is created lazily when
  // an instructor/grader chooses to "grade anyway". These assignments have no
  // repo/upload for the target student, so a manual stub is created.

  test.describe("Any repo_mode is allowed", () => {
    test("repo_mode='none' allows create_manual_submission", async () => {
      const a = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `Any Mode None ${runPrefix}`,
        repo_mode: "none"
      });
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: a.id,
        profile_id: studentA.private_profile_id
      });
      expect(error).toBeNull();
      expect(typeof data).toBe("number");
      const sub = await fetchSubmission(data as number);
      expect(sub.submitted_via).toBe("manual");
      expect(sub.is_active).toBe(true);
    });

    test("repo_mode='template_only_staff' allows create_manual_submission", async () => {
      const a = await insertAssignment({
        due_date: addDays(new Date(), 7).toUTCString(),
        release_date: addDays(new Date(), -1).toUTCString(),
        class_id: course.id,
        name: `Any Mode Template ${runPrefix}`,
        repo_mode: "template_only_staff"
      });
      const { data, error } = await rpcCreateManualSubmission(instructorClient, {
        assignment_id: a.id,
        profile_id: studentA.private_profile_id
      });
      expect(error).toBeNull();
      expect(typeof data).toBe("number");
      const sub = await fetchSubmission(data as number);
      expect(sub.submitted_via).toBe("manual");
      expect(sub.is_active).toBe(true);
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

  // ──────────────── 4. Authorization (instructors + graders) ────────────────

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
      // Migration raises with errcode '42501' and message containing "only instructors and graders"
      expect(error!.message.toLowerCase()).toMatch(/instructor|grader|access denied|permission/);
    });

    test("grader in the class can call create_manual_submission (instructors + graders permitted)", async () => {
      // The generalized RPC allows admins, instructors, AND graders to grade a
      // student who has not submitted. If a future migration tightens this,
      // update both the migration AND this expectation.
      const { data, error } = await rpcCreateManualSubmission(graderClient, {
        assignment_id: assignment.id,
        profile_id: studentB.private_profile_id
      });
      expect(error).toBeNull();
      expect(typeof data).toBe("number");
      const sub = await fetchSubmission(data as number);
      expect(sub.submitted_via).toBe("manual");
      expect(sub.profile_id).toBe(studentB.private_profile_id);
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

// The stub submissions are created automatically (not by an instructor calling
// the RPC) when a no_submission assignment is released, when a student enrolls
// afterwards, and when a group forms — so graders see a row for everyone.
test.describe("Auto-create stub submissions for no_submission (PR #781 follow-up)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const APREFIX = getTestRunPrefix();
  const AID = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  let acClassId: number;
  let acInstructor: TestingUser;
  let s1: TestingUser;
  let s2: TestingUser;
  let indAssignment: AssignmentWithRubric;

  async function activeSubmissionsFor(assignmentId: number, profileId: string) {
    const { data } = await supabase
      .from("submissions")
      .select("id, is_active, submitted_via, repository, sha, assignment_group_id, grading_review_id")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", profileId)
      .is("assignment_group_id", null);
    return (data ?? []).filter((r) => r.is_active);
  }

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E AutoCreate ${APREFIX}` });
    acClassId = cls.id;
    acInstructor = await createUserInClass({
      role: "instructor",
      class_id: acClassId,
      name: `AC Instr ${APREFIX}`,
      email: `e2e-ac-instr-${AID}@pawtograder.net`
    });
    s1 = await createUserInClass({
      role: "student",
      class_id: acClassId,
      name: `AC S1 ${APREFIX}`,
      email: `e2e-ac-s1-${AID}@pawtograder.net`
    });
    s2 = await createUserInClass({
      role: "student",
      class_id: acClassId,
      name: `AC S2 ${APREFIX}`,
      email: `e2e-ac-s2-${AID}@pawtograder.net`
    });
  });

  test("releasing a no_submission assignment auto-creates one active stub per student", async () => {
    indAssignment = await insertAssignment({
      class_id: acClassId,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `AC Individual ${APREFIX}`,
      repo_mode: "no_submission"
    });
    await new Promise((r) => setTimeout(r, 300));

    for (const s of [s1, s2]) {
      const active = await activeSubmissionsFor(indAssignment.id, s.private_profile_id);
      expect(active).toHaveLength(1);
      expect(active[0].submitted_via).toBe("manual");
      expect(active[0].repository).toBeNull();
      expect(active[0].sha).toBeNull();
    }
  });

  test("a student enrolled after release gets a stub", async () => {
    const s3 = await createUserInClass({
      role: "student",
      class_id: acClassId,
      name: `AC S3 ${APREFIX}`,
      email: `e2e-ac-s3-${AID}@pawtograder.net`
    });
    await new Promise((r) => setTimeout(r, 500));
    const active = await activeSubmissionsFor(indAssignment.id, s3.private_profile_id);
    expect(active).toHaveLength(1);
    expect(active[0].submitted_via).toBe("manual");
  });

  test("group no_submission: one active stub per group; members' individual stubs deactivated", async () => {
    const groupAssignment = await insertAssignment({
      class_id: acClassId,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `AC Group ${APREFIX}`,
      repo_mode: "no_submission",
      group_config: "groups"
    });

    const { data: grp, error: grpErr } = await supabase
      .from("assignment_groups")
      .insert({ name: `AC Grp ${APREFIX}`, class_id: acClassId, assignment_id: groupAssignment.id })
      .select("id")
      .single();
    expect(grpErr).toBeNull();
    const groupId = grp!.id;

    for (const s of [s1, s2]) {
      const { error } = await supabase.from("assignment_groups_members").insert({
        assignment_group_id: groupId,
        profile_id: s.private_profile_id,
        assignment_id: groupAssignment.id,
        class_id: acClassId,
        added_by: acInstructor.private_profile_id
      });
      expect(error).toBeNull();
    }
    await new Promise((r) => setTimeout(r, 500));

    const { data: groupSubs } = await supabase
      .from("submissions")
      .select("id, is_active, submitted_via, profile_id")
      .eq("assignment_id", groupAssignment.id)
      .eq("assignment_group_id", groupId);
    const activeGroup = (groupSubs ?? []).filter((r) => r.is_active);
    expect(activeGroup).toHaveLength(1);
    expect(activeGroup[0].submitted_via).toBe("manual");
    expect(activeGroup[0].profile_id).toBeNull();

    // The members' individual stubs (auto-created at insert) are now inactive.
    for (const s of [s1, s2]) {
      const active = await activeSubmissionsFor(groupAssignment.id, s.private_profile_id);
      expect(active).toHaveLength(0);
    }
  });

  test("auto-created stub: grade + release; student reads released grade, hidden before", async () => {
    const sub = (await activeSubmissionsFor(indAssignment.id, s1.private_profile_id))[0];
    expect(sub).toBeDefined();
    const reviewId = sub.grading_review_id!;
    const studentClient = await createAuthenticatedClient(s1);

    const { data: pre } = await studentClient
      .from("submission_reviews")
      .select("released")
      .eq("id", reviewId)
      .maybeSingle();
    expect(pre?.released ?? false).toBe(false);

    const gradingCheck = indAssignment.rubricChecks.find((c) => c.name === "Grading Review Check 2");
    expect(gradingCheck).toBeDefined();
    const { error: commentErr } = await supabase.from("submission_comments").insert({
      submission_id: sub.id,
      submission_review_id: reviewId,
      rubric_check_id: gradingCheck!.id,
      class_id: acClassId,
      author: acInstructor.private_profile_id,
      comment: "Auto-created stub graded",
      points: 8,
      released: true,
      eventually_visible: true,
      regrade_request_id: null
    });
    expect(commentErr).toBeNull();
    await new Promise((r) => setTimeout(r, 750));
    const { error: releaseErr } = await supabase
      .from("submission_reviews")
      .update({
        released: true,
        completed_at: new Date().toISOString(),
        completed_by: acInstructor.private_profile_id,
        grader: acInstructor.private_profile_id
      })
      .eq("id", reviewId);
    expect(releaseErr).toBeNull();

    const { data: post, error: postErr } = await studentClient
      .from("submission_reviews")
      .select("released, total_score")
      .eq("id", reviewId)
      .single();
    expect(postErr).toBeNull();
    expect(post!.released).toBe(true);
    expect(post!.total_score).toBeGreaterThanOrEqual(8);
  });
});

// Submission-optional: on ANY assignment type, students without a submission are
// visible on the grader roster and can be graded anyway (a stub is created on
// demand). The bulk-assign flow can stub an explicit list of non-submitters.
test.describe("Submission-optional: grade anyway on any assignment type", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  const SPREFIX = getTestRunPrefix();
  const SIDL = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  let soClassId: number;
  let soInstructor: TestingUser;
  let soGrader: TestingUser;
  let soS1: TestingUser;
  let soS2: TestingUser;
  let soInstructorClient: SupabaseClient<Database>;
  let repoAssignment: AssignmentWithRubric;

  // Query the grader roster view (service role bypasses RLS, so all enrolled
  // students appear — including non-submitters, whose activesubmissionid is null).
  async function rosterRowFor(assignmentId: number, profileId: string) {
    const { data, error } = await supabase
      .from("submissions_with_grades_for_assignment_nice")
      .select("id, student_private_profile_id, activesubmissionid, assignment_group_id")
      .eq("assignment_id", assignmentId)
      .eq("student_private_profile_id", profileId)
      .maybeSingle();
    if (error) throw new Error(`Failed to query roster view: ${error.message}`);
    return data as {
      id: number;
      student_private_profile_id: string;
      activesubmissionid: number | null;
      assignment_group_id: number | null;
    } | null;
  }

  async function rpcCreateStubsForNonSubmitters(
    client: SupabaseClient<Database>,
    params: { assignment_id: number; profile_ids?: string[]; assignment_group_ids?: number[] }
  ): Promise<{ data: number[] | null; error: { message: string } | null }> {
    const { data, error } = await (client.rpc as CallableFunction)("create_manual_submissions_for_non_submitters", {
      p_assignment_id: params.assignment_id,
      p_profile_ids: params.profile_ids ?? [],
      p_assignment_group_ids: params.assignment_group_ids ?? []
    });
    return { data: data as number[] | null, error: error as { message: string } | null };
  }

  test.beforeAll(async () => {
    const cls = await createClass({ name: `E2E SubmissionOptional ${SPREFIX}` });
    soClassId = cls.id;
    soInstructor = await createUserInClass({
      role: "instructor",
      class_id: soClassId,
      name: `SO Instr ${SPREFIX}`,
      email: `e2e-so-instr-${SIDL}@pawtograder.net`
    });
    soGrader = await createUserInClass({
      role: "grader",
      class_id: soClassId,
      name: `SO Grader ${SPREFIX}`,
      email: `e2e-so-grader-${SIDL}@pawtograder.net`
    });
    soS1 = await createUserInClass({
      role: "student",
      class_id: soClassId,
      name: `SO S1 ${SPREFIX}`,
      email: `e2e-so-s1-${SIDL}@pawtograder.net`
    });
    soS2 = await createUserInClass({
      role: "student",
      class_id: soClassId,
      name: `SO S2 ${SPREFIX}`,
      email: `e2e-so-s2-${SIDL}@pawtograder.net`
    });
    soInstructorClient = await createAuthenticatedClient(soInstructor);

    // A normal repo assignment (NOT no_submission) — no stubs are auto-created,
    // so both students start as non-submitters.
    repoAssignment = await insertAssignment({
      class_id: soClassId,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SO Repo Assignment ${SPREFIX}`,
      repo_mode: "template_only_staff"
    });
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([soInstructor, soGrader, soS1, soS2]);
  });

  test("a student with no submission appears on the roster with a null activesubmissionid", async () => {
    const row = await rosterRowFor(repoAssignment.id, soS1.private_profile_id);
    expect(row).not.toBeNull();
    expect(row!.activesubmissionid).toBeNull();
  });

  test("instructor can 'grade anyway' — creates a manual stub on a repo assignment", async () => {
    const { data: submissionId, error } = await rpcCreateManualSubmission(soInstructorClient, {
      assignment_id: repoAssignment.id,
      profile_id: soS1.private_profile_id
    });
    expect(error).toBeNull();
    expect(typeof submissionId).toBe("number");

    const sub = await fetchSubmission(submissionId as number);
    expect(sub.submitted_via).toBe("manual");
    expect(sub.is_active).toBe(true);
    expect(sub.repository).toBeNull();
    expect(sub.sha).toBeNull();

    // The roster now links s1 to the stub; s2 is still a non-submitter.
    const s1Row = await rosterRowFor(repoAssignment.id, soS1.private_profile_id);
    expect(s1Row!.activesubmissionid).toBe(submissionId);
    const s2Row = await rosterRowFor(repoAssignment.id, soS2.private_profile_id);
    expect(s2Row!.activesubmissionid).toBeNull();
  });

  test("a later real submission supersedes the manual stub (stub deactivated)", async () => {
    const stub = (
      await supabase
        .from("submissions")
        .select("id, is_active, submitted_via")
        .eq("assignment_id", repoAssignment.id)
        .eq("profile_id", soS1.private_profile_id)
    ).data?.find((r) => r.submitted_via === "manual");
    expect(stub).toBeDefined();

    // Insert a real (git) submission for the same student; the submissions
    // insert trigger assigns an ordinal, marks it active, and deactivates prior
    // active submissions for this (assignment, profile).
    const { data: real, error: realErr } = await supabase
      .from("submissions")
      .insert({
        assignment_id: repoAssignment.id,
        class_id: soClassId,
        profile_id: soS1.private_profile_id,
        assignment_group_id: null,
        repository: `pawtograder/e2e-so-${SIDL}`,
        sha: randomBytes(20).toString("hex"),
        run_attempt: 1,
        run_number: 1,
        ordinal: 1,
        is_active: true,
        submitted_via: "git"
      })
      .select("id, is_active")
      .single();
    expect(realErr).toBeNull();
    expect(real!.is_active).toBe(true);

    // The manual stub is now inactive; the roster points at the real submission.
    const stubAfter = await fetchSubmission(stub!.id);
    expect(stubAfter.is_active).toBe(false);
    const row = await rosterRowFor(repoAssignment.id, soS1.private_profile_id);
    expect(row!.activesubmissionid).toBe(real!.id);
  });

  test("bulk RPC stubs an explicit list of non-submitters (idempotent)", async () => {
    const bulkAssignment = await insertAssignment({
      class_id: soClassId,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SO Bulk Assignment ${SPREFIX}`,
      repo_mode: "template_only_staff"
    });

    const { data: ids, error } = await rpcCreateStubsForNonSubmitters(soInstructorClient, {
      assignment_id: bulkAssignment.id,
      profile_ids: [soS1.private_profile_id, soS2.private_profile_id]
    });
    expect(error).toBeNull();
    expect(ids).not.toBeNull();
    expect(ids!.length).toBe(2);

    for (const id of ids!) {
      const sub = await fetchSubmission(id);
      expect(sub.submitted_via).toBe("manual");
      expect(sub.is_active).toBe(true);
    }

    // Idempotent: calling again returns the same active submission ids.
    const { data: ids2, error: error2 } = await rpcCreateStubsForNonSubmitters(soInstructorClient, {
      assignment_id: bulkAssignment.id,
      profile_ids: [soS1.private_profile_id, soS2.private_profile_id]
    });
    expect(error2).toBeNull();
    expect([...(ids2 ?? [])].sort()).toEqual([...(ids ?? [])].sort());
  });

  test("grader can call the bulk non-submitter RPC", async () => {
    const graderClientLocal = await createAuthenticatedClient(soGrader);
    const bulkAssignment = await insertAssignment({
      class_id: soClassId,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `SO Bulk Grader Assignment ${SPREFIX}`,
      repo_mode: "template_only_staff"
    });
    const { data: ids, error } = await rpcCreateStubsForNonSubmitters(graderClientLocal, {
      assignment_id: bulkAssignment.id,
      profile_ids: [soS1.private_profile_id]
    });
    expect(error).toBeNull();
    expect(ids!.length).toBe(1);
  });
});
