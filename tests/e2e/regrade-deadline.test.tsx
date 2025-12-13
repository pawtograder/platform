import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays, addHours, subHours } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local" });

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;

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
});

test.describe("Regrade request deadline enforcement", () => {
  test.describe.configure({ mode: "serial" });

  test("Regrade request succeeds when no deadline is set", async () => {
    // Create assignment without regrade deadline
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "No Deadline Assignment",
      regrade_deadline_hours: null // No deadline
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
    const { data: regradeData, error: regradeError } = await supabase.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request succeeds when deadline has not passed", async () => {
    // Create assignment with a deadline far in the future (1000 hours from release)
    // Release was 1 day ago, so deadline is ~1000 hours - 24 hours = 976 hours in the future
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Future Deadline Assignment",
      regrade_deadline_hours: 1000 // 1000 hours from release
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
    const { data: regradeData, error: regradeError } = await supabase.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request fails when deadline has passed", async () => {
    // Create assignment with a deadline that has already passed
    // Release was 1 day ago (24 hours ago), deadline is 1 hour after release
    // So deadline was 23 hours ago
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Expired Deadline Assignment",
      regrade_deadline_hours: 1 // 1 hour after release (which was 1 day ago)
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
    const { data: regradeData, error: regradeError } = await supabase.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).not.toBeNull();
    expect(regradeError!.message).toContain("regrade request deadline has passed");
    expect(regradeData).toBeNull();
  });

  test("Regrade request with explicit release date - deadline not passed", async () => {
    // Create assignment with release date 1 hour ago and 48 hour deadline
    // So deadline is 47 hours in the future
    const releaseDate = subHours(new Date(), 1);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Recent Release Assignment",
      regrade_deadline_hours: 48, // 48 hours from release
      release_date: releaseDate.toISOString()
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
    const { data: regradeData, error: regradeError } = await supabase.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).toBeNull();
    expect(regradeData).not.toBeNull();
  });

  test("Regrade request with explicit release date - deadline passed", async () => {
    // Create assignment with release date 100 hours ago and 24 hour deadline
    // So deadline was 76 hours ago
    const releaseDate = subHours(new Date(), 100);
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Old Release Assignment",
      regrade_deadline_hours: 24, // 24 hours from release (which was 100 hours ago)
      release_date: releaseDate.toISOString()
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
    const { data: regradeData, error: regradeError } = await supabase.rpc("create_regrade_request", {
      private_profile_id: student!.private_profile_id,
      submission_comment_id: commentData!.id
    });

    expect(regradeError).not.toBeNull();
    expect(regradeError!.message).toContain("regrade request deadline has passed");
    expect(regradeData).toBeNull();
  });
});
