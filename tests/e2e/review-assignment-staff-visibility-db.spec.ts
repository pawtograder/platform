/**
 * DB-level coverage for 20261003120000_staff_view_review_assignments.sql: staff can see every
 * review assignment in their class, and nothing about who may complete one changes.
 *
 * Every call goes through an authenticated client. The service role bypasses RLS, so a passing
 * assertion through the admin client would prove nothing about the policies.
 *
 * The write-side tests pin existing behaviour on purpose: seeing a colleague's assignment must not
 * become a way to complete or edit it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "date-fns";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type AssignmentWithRubric = Awaited<ReturnType<typeof insertAssignment>>;

test.describe("staff can see each other's review assignments, but only complete their own", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let course: Course;
  let student: TestingUser;
  let otherStudent: TestingUser;
  let graderA: TestingUser;
  let graderB: TestingUser;
  let assignment: AssignmentWithRubric;
  let graderAReviewId: number;
  let graderBReviewId: number;
  const clients = new Map<string, SupabaseClient<Database>>();

  async function clientFor(user: TestingUser) {
    let client = clients.get(user.email);
    if (!client) {
      client = await createAuthenticatedClient(user);
      clients.set(user.email, client);
    }
    return client;
  }

  async function insertReview(assignee: TestingUser, rubricId: number, reviewId: number, partId?: number) {
    const { data, error } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: assignee.private_profile_id,
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: submissionId,
        submission_review_id: reviewId,
        rubric_id: rubricId,
        due_date: addDays(new Date(), 3).toISOString()
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (partId) {
      const { error: partError } = await supabase
        .from("review_assignment_rubric_parts")
        .insert({ review_assignment_id: data.id, rubric_part_id: partId, class_id: course.id });
      if (partError) throw new Error(partError.message);
    }
    return data.id;
  }

  let submissionId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Staff Review Completion" });
    [student, otherStudent, graderA, graderB] = await createUsersInClass([
      {
        role: "student",
        class_id: course.id,
        name: "Rae Reviewed",
        email: `ra-staff-student-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "student",
        class_id: course.id,
        name: "Otto Otherstudent",
        email: `ra-staff-other-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "grader",
        class_id: course.id,
        name: "Ada Grader",
        email: `ra-staff-grader-a-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "grader",
        class_id: course.id,
        name: "Bea Grader",
        email: `ra-staff-grader-b-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
    assignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toISOString(),
      class_id: course.id,
      name: "Staff Review Completion",
      assignment_slug: `ra-staff-${course.id}`
    });
    // The seeded checks are all required. Relax grader A's part, so grader A can complete their own
    // assignment below without seeding comments: that success is the control showing the denied
    // cross-grader completion is RLS, not the completion validation trigger.
    const gradingParts = assignment.rubricParts.filter((p) => p.rubric_id === assignment.grading_rubric_id);
    const { data: partACriteria, error: criteriaError } = await supabase
      .from("rubric_criteria")
      .select("id")
      .eq("rubric_part_id", gradingParts[0]!.id);
    if (criteriaError) throw new Error(criteriaError.message);
    const { error: relaxError } = await supabase
      .from("rubric_checks")
      .update({ is_required: false })
      .in(
        "rubric_criteria_id",
        (partACriteria ?? []).map((c) => c.id)
      );
    if (relaxError) throw new Error(relaxError.message);

    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = submission.submission_id;

    graderAReviewId = await insertReview(
      graderA,
      assignment.grading_rubric_id!,
      submission.grading_review_id!,
      gradingParts[0]!.id
    );
    graderBReviewId = await insertReview(
      graderB,
      assignment.grading_rubric_id!,
      submission.grading_review_id!,
      gradingParts[1]!.id
    );
  });

  test("a grader can read another grader's review assignment and its rubric parts", async () => {
    const client = await clientFor(graderB);
    const { data, error } = await client
      .from("review_assignments")
      .select("id, assignee_profile_id")
      .eq("submission_id", submissionId);
    expect(error).toBeNull();
    const ids = (data ?? []).map((r) => r.id);
    expect(ids, "grader B sees grader A's assignment").toContain(graderAReviewId);
    expect(ids, "grader B still sees their own").toContain(graderBReviewId);

    const { data: parts, error: partsError } = await client
      .from("review_assignment_rubric_parts")
      .select("id")
      .eq("review_assignment_id", graderAReviewId);
    expect(partsError).toBeNull();
    expect(parts?.length ?? 0).toBe(1);
  });

  test("a student cannot read staff review assignments", async () => {
    const client = await clientFor(otherStudent);
    const { data, error } = await client.from("review_assignments").select("id").eq("submission_id", submissionId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  test("a grader still cannot edit another grader's review assignment directly", async () => {
    const client = await clientFor(graderB);
    const newDue = addDays(new Date(), 30).toISOString();
    // RLS matches zero rows, so PostgREST answers without an error; the row is what proves it.
    await client.from("review_assignments").update({ due_date: newDue }).eq("id", graderAReviewId);
    const { data } = await supabase.from("review_assignments").select("due_date").eq("id", graderAReviewId).single();
    expect(new Date(data!.due_date).toISOString()).not.toBe(newDue);
  });

  test("a grader still cannot complete another grader's review assignment", async () => {
    const client = await clientFor(graderB);
    // RLS matches zero rows, so PostgREST answers without an error; the row is what proves it.
    await client
      .from("review_assignments")
      .update({ completed_at: new Date().toISOString(), completed_by: graderB.private_profile_id })
      .eq("id", graderAReviewId);
    const { data } = await supabase
      .from("review_assignments")
      .select("completed_at")
      .eq("id", graderAReviewId)
      .single();
    expect(data!.completed_at).toBeNull();
  });

  test("a grader can still complete their own review assignment", async () => {
    const client = await clientFor(graderA);
    const { error } = await client
      .from("review_assignments")
      .update({ completed_at: new Date().toISOString(), completed_by: graderA.private_profile_id })
      .eq("id", graderAReviewId);
    expect(error).toBeNull();
    const { data } = await supabase
      .from("review_assignments")
      .select("completed_at, completed_by")
      .eq("id", graderAReviewId)
      .single();
    expect(data!.completed_at).not.toBeNull();
    expect(data!.completed_by).toBe(graderA.private_profile_id);
  });
});
