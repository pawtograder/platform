import { Course } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { addDays, subHours } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createRegradeRequest,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";
import { SupabaseClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let student: TestingUser | undefined;
let grader: TestingUser | undefined;
let instructor: TestingUser | undefined;
let studentClient: SupabaseClient<Database>;
let graderClient: SupabaseClient<Database>;

test.beforeAll(async () => {
  course = await createClass();
  [student, grader, instructor] = await createUsersInClass([
    {
      name: "Regrade Unapplied Student",
      email: "regrade-unapplied-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Regrade Unapplied Grader",
      email: "regrade-unapplied-grader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Regrade Unapplied Instructor",
      email: "regrade-unapplied-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  studentClient = await createAuthenticatedClient(student!);
  graderClient = await createAuthenticatedClient(grader!);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, grader, instructor]);
});

// Resolves the grading review id for a submission (the review tied to the assignment's
// grading rubric — prebake also creates a self-review whose rubric differs).
async function getGradingReviewId(submission_id: number, grading_rubric_id: number): Promise<number> {
  const { data, error } = await supabase
    .from("submission_reviews")
    .select("id, rubric_id")
    .eq("submission_id", submission_id)
    .eq("rubric_id", grading_rubric_id);
  expect(error).toBeNull();
  expect(data).not.toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  return data![0].id;
}

// Returns the id of a rubric check that belongs to the given rubric. insertAssignment
// creates self-review checks first and grading checks after, so we must look the check
// up by rubric rather than relying on rubricChecks[0].
async function getCheckIdForRubric(grading_rubric_id: number): Promise<number> {
  const { data, error } = await supabase
    .from("rubric_checks")
    .select("id, rubric_criteria!inner(rubric_id)")
    .eq("rubric_criteria.rubric_id", grading_rubric_id);
  expect(error).toBeNull();
  expect(data).not.toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  return data![0].id;
}

test.describe("Regrade requests for un-applied checks (#457)", () => {
  test.describe.configure({ mode: "serial" });

  test("Creates a draft request for an un-applied check, then runs the full lifecycle", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Unapplied Check Lifecycle Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const reviewId = await getGradingReviewId(submission_res.submission_id, assignment.grading_rubric_id!);
    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    // Student creates a regrade request for a rubric check with NO comment.
    const { data: requestId, error: createError } = await studentClient.rpc("create_regrade_request_for_check", {
      private_profile_id: student!.private_profile_id,
      p_submission_review_id: reviewId,
      p_rubric_check_id: rubricCheckId
    });

    expect(createError).toBeNull();
    expect(requestId).not.toBeNull();

    // Inspect the created row.
    const { data: createdRow, error: rowError } = await supabase
      .from("submission_regrade_requests")
      .select("*")
      .eq("id", requestId!)
      .single();

    expect(rowError).toBeNull();
    expect(createdRow!.status).toBe("draft");
    expect(createdRow!.rubric_check_id).toBe(rubricCheckId);
    expect(createdRow!.submission_review_id).toBe(reviewId);
    expect(createdRow!.submission_comment_id).toBeNull();
    expect(createdRow!.submission_file_comment_id).toBeNull();
    expect(createdRow!.submission_artifact_comment_id).toBeNull();
    expect(createdRow!.initial_points).toBe(0);

    // Duplicate open request for the same review + check should fail.
    const { data: dupData, error: dupError } = await studentClient.rpc("create_regrade_request_for_check", {
      private_profile_id: student!.private_profile_id,
      p_submission_review_id: reviewId,
      p_rubric_check_id: rubricCheckId
    });
    expect(dupError).not.toBeNull();
    expect(dupError!.message).toContain("An open regrade request already exists");
    expect(dupData).toBeNull();

    // Lifecycle: draft -> opened (by student) -> resolved (by grader) with points.
    const { data: openedData, error: openedError } = await studentClient.rpc("update_regrade_request_status", {
      regrade_request_id: requestId!,
      new_status: "opened",
      profile_id: student!.private_profile_id
    });
    expect(openedError).toBeNull();
    expect(openedData).toBe(true);

    const resolvedPoints = 3;
    const { data: resolvedData, error: resolvedError } = await graderClient.rpc("update_regrade_request_status", {
      regrade_request_id: requestId!,
      new_status: "resolved",
      profile_id: grader!.private_profile_id,
      resolved_points: resolvedPoints
    });
    expect(resolvedError).toBeNull();
    expect(resolvedData).toBe(true);

    // A real submission_comment should now exist, backing the request.
    const { data: comment, error: commentError } = await supabase
      .from("submission_comments")
      .select("*")
      .eq("regrade_request_id", requestId!)
      .single();
    expect(commentError).toBeNull();
    expect(comment!.rubric_check_id).toBe(rubricCheckId);
    expect(comment!.submission_review_id).toBe(reviewId);
    expect(comment!.points).toBe(resolvedPoints);

    // The request should now link back to that comment.
    const { data: resolvedRow, error: resolvedRowError } = await supabase
      .from("submission_regrade_requests")
      .select("status, submission_comment_id, resolved_points, resolution_reason")
      .eq("id", requestId!)
      .single();
    expect(resolvedRowError).toBeNull();
    expect(resolvedRow!.status).toBe("resolved");
    expect(resolvedRow!.submission_comment_id).toBe(comment!.id);
    expect(resolvedRow!.resolved_points).toBe(resolvedPoints);
  });

  test("Rejects a rubric check from a different assignment's rubric", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Unapplied Check Target Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });
    const otherAssignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Unapplied Check Other Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const reviewId = await getGradingReviewId(submission_res.submission_id, assignment.grading_rubric_id!);
    // A valid grading check, but from a different assignment's rubric.
    const foreignRubricCheckId = await getCheckIdForRubric(otherAssignment.grading_rubric_id!);

    const { data, error } = await studentClient.rpc("create_regrade_request_for_check", {
      private_profile_id: student!.private_profile_id,
      p_submission_review_id: reviewId,
      p_rubric_check_id: foreignRubricCheckId
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("does not belong");
    expect(data).toBeNull();
  });

  test("Rejects a request when the regrade deadline has passed", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Unapplied Check Expired Assignment",
      regrade_deadline: subHours(new Date(), 24).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const reviewId = await getGradingReviewId(submission_res.submission_id, assignment.grading_rubric_id!);
    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    const { data, error } = await studentClient.rpc("create_regrade_request_for_check", {
      private_profile_id: student!.private_profile_id,
      p_submission_review_id: reviewId,
      p_rubric_check_id: rubricCheckId
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("regrade request deadline has passed");
    expect(data).toBeNull();
  });

  test("Rejects a check that is already applied (a live comment exists)", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Unapplied Check Already-Applied Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const reviewId = await getGradingReviewId(submission_res.submission_id, assignment.grading_rubric_id!);
    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    // Apply the check with a live grading comment.
    const { error: commentError } = await supabase.from("submission_comments").insert({
      submission_id: submission_res.submission_id,
      author: grader!.private_profile_id,
      comment: "Applied check",
      points: 2,
      class_id: course.id,
      rubric_check_id: rubricCheckId,
      submission_review_id: reviewId,
      released: true
    });
    expect(commentError).toBeNull();

    const { data, error } = await studentClient.rpc("create_regrade_request_for_check", {
      private_profile_id: student!.private_profile_id,
      p_submission_review_id: reviewId,
      p_rubric_check_id: rubricCheckId
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("already applied");
    expect(data).toBeNull();
  });
});

test.describe("Auto-resolve dangling regrade requests on comment delete (#517)", () => {
  test.describe.configure({ mode: "serial" });

  test("Soft-deleting the backing comment auto-resolves an open request; student can then escalate", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Dangling Auto-Resolve Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    // Comment-backed request in 'opened' status.
    const request = await createRegradeRequest(
      submission_res.submission_id,
      assignment.id,
      student!.private_profile_id,
      grader!.private_profile_id,
      rubricCheckId,
      course.id,
      "opened"
    );
    expect(request.submission_comment_id).not.toBeNull();

    // Soft-delete the backing comment.
    const { error: deleteError } = await supabase
      .from("submission_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", request.submission_comment_id!);
    expect(deleteError).toBeNull();

    // The request should have auto-resolved with reason 'comment_deleted'.
    const { data: resolvedRow, error: resolvedRowError } = await supabase
      .from("submission_regrade_requests")
      .select("status, resolution_reason")
      .eq("id", request.id)
      .single();
    expect(resolvedRowError).toBeNull();
    expect(resolvedRow!.status).toBe("resolved");
    expect(resolvedRow!.resolution_reason).toBe("comment_deleted");

    // An 'auto_resolved' notification should have been created for the submission's student.
    const { data: notifications, error: notifError } = await supabase
      .from("notifications")
      .select("body")
      .eq("class_id", course.id)
      .contains("body", { type: "regrade_request", action: "auto_resolved", regrade_request_id: request.id });
    expect(notifError).toBeNull();
    expect(notifications!.length).toBeGreaterThan(0);

    // Auto-resolve is NOT terminal: the student can escalate.
    const { data: escalatedData, error: escalatedError } = await studentClient.rpc("update_regrade_request_status", {
      regrade_request_id: request.id,
      new_status: "escalated",
      profile_id: student!.private_profile_id
    });
    expect(escalatedError).toBeNull();
    expect(escalatedData).toBe(true);

    const { data: escalatedRow, error: escalatedRowError } = await supabase
      .from("submission_regrade_requests")
      .select("status")
      .eq("id", request.id)
      .single();
    expect(escalatedRowError).toBeNull();
    expect(escalatedRow!.status).toBe("escalated");
  });

  test("Does not change an already-closed request when its comment is soft-deleted", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Dangling Closed Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    // Comment-backed request already in 'closed' status.
    const request = await createRegradeRequest(
      submission_res.submission_id,
      assignment.id,
      student!.private_profile_id,
      grader!.private_profile_id,
      rubricCheckId,
      course.id,
      "closed"
    );
    expect(request.submission_comment_id).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("submission_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", request.submission_comment_id!);
    expect(deleteError).toBeNull();

    const { data: row, error: rowError } = await supabase
      .from("submission_regrade_requests")
      .select("status, resolution_reason")
      .eq("id", request.id)
      .single();
    expect(rowError).toBeNull();
    expect(row!.status).toBe("closed");
    expect(row!.resolution_reason).not.toBe("comment_deleted");
  });

  test("Does not de-escalate an escalated request when its comment is soft-deleted", async () => {
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Dangling Escalated Assignment",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const rubricCheckId = await getCheckIdForRubric(assignment.grading_rubric_id!);

    // Comment-backed request already escalated to an instructor.
    const request = await createRegradeRequest(
      submission_res.submission_id,
      assignment.id,
      student!.private_profile_id,
      grader!.private_profile_id,
      rubricCheckId,
      course.id,
      "escalated"
    );
    expect(request.submission_comment_id).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("submission_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", request.submission_comment_id!);
    expect(deleteError).toBeNull();

    // It must stay in the instructor queue, not get pulled back to 'resolved'.
    const { data: row, error: rowError } = await supabase
      .from("submission_regrade_requests")
      .select("status, resolution_reason")
      .eq("id", request.id)
      .single();
    expect(rowError).toBeNull();
    expect(row!.status).toBe("escalated");
    expect(row!.resolution_reason).not.toBe("comment_deleted");
  });
});
