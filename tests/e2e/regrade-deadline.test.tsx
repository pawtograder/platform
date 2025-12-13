import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { addDays, addHours, subHours } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";
import { SupabaseClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let studentClient: SupabaseClient<Database>;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Regrade Deadline Student",
      email: "regrade-deadline-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Regrade Deadline Instructor",
      email: "regrade-deadline-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  // Create an authenticated client for the student to use for RPC calls
  studentClient = await createAuthenticatedClient(student!);
});

test.describe("Regrade request deadline enforcement", () => {
  test.describe.configure({ mode: "serial" });

  test("Regrade request succeeds when no deadline is set", async () => {
    // Create assignment without regrade deadline
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "No Deadline Assignment",
      regrade_deadline: null // No deadline
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a grading comment on the submission
    const { data: commentData, error: commentError } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission_res.submission_id,
        author: instructor!.private_profile_id,
        comment: "Test comment for regrade",
        points: 5,
        class_id: course.id,
        rubric_check_id: assignment.rubricChecks[0].id,
        released: true
      })
      .select("*")
      .single();

    expect(commentError).toBeNull();
    expect(commentData).not.toBeNull();

    // Try to create a regrade request - should succeed
    // Use the student's authenticated client so auth.uid() works correctly
    const { data: regradeData, error: regradeError } = await studentClient.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request succeeds when deadline has not passed", async () => {
    // Create assignment with a deadline far in the future (7 days from now)
    const futureDeadline = addDays(new Date(), 7);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Future Deadline Assignment",
      regrade_deadline: futureDeadline.toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a grading comment on the submission
    const { data: commentData, error: commentError } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission_res.submission_id,
        author: instructor!.private_profile_id,
        comment: "Test comment for regrade",
        points: 5,
        class_id: course.id,
        rubric_check_id: assignment.rubricChecks[0].id,
        released: true
      })
      .select("*")
      .single();

    expect(commentError).toBeNull();
    expect(commentData).not.toBeNull();

    // Try to create a regrade request - should succeed (deadline hasn't passed)
    // Use the student's authenticated client so auth.uid() works correctly
    const { data: regradeData, error: regradeError } = await studentClient.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request fails when deadline has passed", async () => {
    // Create assignment with a deadline that has already passed (1 day ago)
    const pastDeadline = subHours(new Date(), 24);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Expired Deadline Assignment",
      regrade_deadline: pastDeadline.toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a grading comment on the submission
    const { data: commentData, error: commentError } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission_res.submission_id,
        author: instructor!.private_profile_id,
        comment: "Test comment for regrade",
        points: 5,
        class_id: course.id,
        rubric_check_id: assignment.rubricChecks[0].id,
        released: true
      })
      .select("*")
      .single();

    expect(commentError).toBeNull();
    expect(commentData).not.toBeNull();

    // Try to create a regrade request - should fail (deadline has passed)
    // Use the student's authenticated client so auth.uid() works correctly
    const { data: regradeData, error: regradeError } = await studentClient.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).not.toBeNull();
    expect(regradeError!.message).toContain("regrade request deadline has passed");
    expect(regradeData).toBeNull();
  });

  test("Regrade request succeeds just before deadline", async () => {
    // Create assignment with a deadline 2 hours in the future
    const nearFutureDeadline = addHours(new Date(), 2);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Near Future Deadline Assignment",
      regrade_deadline: nearFutureDeadline.toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a grading comment on the submission
    const { data: commentData, error: commentError } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission_res.submission_id,
        author: instructor!.private_profile_id,
        comment: "Test comment for regrade",
        points: 5,
        class_id: course.id,
        rubric_check_id: assignment.rubricChecks[0].id,
        released: true
      })
      .select("*")
      .single();

    expect(commentError).toBeNull();
    expect(commentData).not.toBeNull();

    // Try to create a regrade request - should succeed (deadline hasn't passed yet)
    // Use the student's authenticated client so auth.uid() works correctly
    const { data: regradeData, error: regradeError } = await studentClient.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request fails just after deadline", async () => {
    // Create assignment with a deadline that just passed (1 minute ago)
    const justPastDeadline = subHours(new Date(), 1);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Just Past Deadline Assignment",
      regrade_deadline: justPastDeadline.toISOString()
    });

    const submission_res = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a grading comment on the submission
    const { data: commentData, error: commentError } = await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission_res.submission_id,
        author: instructor!.private_profile_id,
        comment: "Test comment for regrade",
        points: 5,
        class_id: course.id,
        rubric_check_id: assignment.rubricChecks[0].id,
        released: true
      })
      .select("*")
      .single();

    expect(commentError).toBeNull();
    expect(commentData).not.toBeNull();

    // Try to create a regrade request - should fail (deadline just passed)
    // Use the student's authenticated client so auth.uid() works correctly
    const { data: regradeData, error: regradeError } = await studentClient.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).not.toBeNull();
    expect(regradeError!.message).toContain("regrade request deadline has passed");
    expect(regradeData).toBeNull();
  });
});
