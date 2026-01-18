import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays, addMinutes } from "date-fns";
import { createHash } from "crypto";
import {
  createClass,
  insertAssignment,
  insertSubmissionViaAPI,
  loginAsUser,
  supabase,
  TestingUser,
  createUsersInClass
} from "./TestingUtils";
import { argosScreenshot } from "@argos-ci/playwright";

let course: Course;
let student: TestingUser | undefined;

let assignmentInFuture: Assignment | undefined;
let assignmentInPast: Assignment | undefined;
let assignmentExtended: Assignment | undefined;
let assignmentWithNotGraded: Assignment | undefined;
let assignmentWithGradedAndNotGraded: Assignment | undefined;
let assignmentEmptyAllowed: Assignment | undefined;
let assignmentEmptyProhibited: Assignment | undefined;
let assignmentProhibitedButNotEmpty: Assignment | undefined;

function sha256Hex(buf: Buffer): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function computeCombinedHashFromSubmissionFiles(files: { name: string; contents: string }[]): {
  file_hashes: Record<string, string>;
  combined_hash: string;
} {
  const file_hashes: Record<string, string> = {};
  for (const f of files) {
    file_hashes[f.name] = sha256Hex(Buffer.from(f.contents, "utf-8"));
  }
  const combinedInput = Object.keys(file_hashes)
    .sort()
    .map((name) => `${name}\0${file_hashes[name]}\n`)
    .join("");
  return {
    file_hashes,
    combined_hash: sha256Hex(Buffer.from(combinedInput, "utf-8"))
  };
}

test.beforeAll(async () => {
  course = await createClass();
  [student] = await createUsersInClass([
    {
      name: "Create Submission Student",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignmentInFuture = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Future"
  });
  assignmentInPast = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Past"
  });
  assignmentExtended = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Extended"
  });
  assignmentWithGradedAndNotGraded = await insertAssignment({
    due_date: addMinutes(new Date(), 5).toUTCString(),
    allow_not_graded_submissions: true,
    class_id: course.id,
    name: "Create Submission Assignment Graded and Not Graded"
  });

  assignmentEmptyAllowed = await insertAssignment({
    due_date: addMinutes(new Date(), 5).toUTCString(),
    permit_empty_submissions: true,
    class_id: course.id,
    name: "Create Submission Assignment Empty Allowed"
  });
  assignmentEmptyProhibited = await insertAssignment({
    due_date: addMinutes(new Date(), 5).toUTCString(),
    permit_empty_submissions: false,
    class_id: course.id,
    name: "Create Submission Assignment Empty Prohibited"
  });
  assignmentProhibitedButNotEmpty = await insertAssignment({
    due_date: addMinutes(new Date(), 5).toUTCString(),
    permit_empty_submissions: false,
    class_id: course.id,
    name: "Create Submission Assignment Prohibited But Not Empty"
  });
  await supabase.from("assignment_due_date_exceptions").insert({
    assignment_id: assignmentExtended.id,
    class_id: course.id,
    creator_id: student.private_profile_id,
    student_id: student.private_profile_id,
    hours: 24,
    minutes: 0,
    tokens_consumed: 1,
    note: "Test note"
  });

  // Create assignment for NOT-GRADED testing
  assignmentWithNotGraded = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    allow_not_graded_submissions: true,
    class_id: course.id,
    name: "Create Submission Assignment Not Graded"
  });
});
test.describe("Create submission", () => {
  test("If the deadline is in the future, the student can create a submission", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentInFuture!.id,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });
  test("If the deadline has passed, the student cannot create a submission", async () => {
    const submission = insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentInPast!.id,
      class_id: course.id
    });
    await expect(submission).rejects.toThrow("You cannot submit after the due date");
  });
  test("If the student has extended their due date, they can create a submission", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentExtended!.id,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });

  test("Student can create NOT-GRADED submission after deadline when assignment allows it", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithNotGraded!.id,
      commit_message: "#NOT-GRADED",
      class_id: course.id
    });
    expect(submission).toBeDefined();

    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentWithNotGraded!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });

  test("NOT-GRADED submission does not become active", async ({ page }) => {
    const activeSHA = "active";
    const notGradedSHA = "not-gra";
    await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithGradedAndNotGraded!.id,
      commit_message: "here's my submission!",
      sha: activeSHA,
      class_id: course.id
    });
    await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithGradedAndNotGraded!.id,
      commit_message: "#NOT-GRADED",
      sha: notGradedSHA,
      class_id: course.id
    });
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const assignmentPage = `/course/${course.id}/assignments/${assignmentWithGradedAndNotGraded!.id}`;
    await page.goto(assignmentPage);

    // Expect to see one active and one pending submission
    const activeRow = page.getByRole("row").filter({ hasText: activeSHA });
    const notGradedRow = page.getByRole("row").filter({ hasText: notGradedSHA });
    await expect(activeRow).toBeVisible();
    await expect(notGradedRow).toBeVisible();
    await expect(activeRow.getByText("Pending")).toBeVisible();
    await expect(notGradedRow.getByText("Not for grading")).toBeVisible();
    await argosScreenshot(page, "Showing active and not-graded submissions");
    await page.getByRole("link", { name: "Not for grading" }).click();
    await expect(page.getByText("Viewing a not-for-grading submission")).toBeVisible();
  });

  test("Empty submission is accepted when permitted, and flagged", async () => {
    // First submission: succeeds even if no handout hashes exist yet.
    const first = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentEmptyAllowed!.id,
      class_id: course.id
    });

    // Use the first submission's expected files as the "handout" fingerprint for this test run.
    const { data: submissionFiles, error: submissionFilesError } = await supabase
      .from("submission_files")
      .select("name, contents")
      .eq("submission_id", first.submission_id)
      .limit(1000);
    if (submissionFilesError || !submissionFiles) {
      throw new Error(`Failed to load submission files: ${submissionFilesError?.message}`);
    }
    const { combined_hash, file_hashes } = computeCombinedHashFromSubmissionFiles(
      submissionFiles.map((f) => ({ name: f.name, contents: f.contents }))
    );

    // Store as a handout version for multiple assignments.
    await supabase.from("assignment_handout_file_hashes").insert([
      {
        assignment_id: assignmentEmptyAllowed!.id,
        sha: "e2e-handout",
        combined_hash,
        file_hashes,
        class_id: course.id
      },
      {
        assignment_id: assignmentEmptyProhibited!.id,
        sha: "e2e-handout",
        combined_hash,
        file_hashes,
        class_id: course.id
      }
    ]);

    // Second submission should now match the handout hash and be marked empty (but allowed).
    const second = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentEmptyAllowed!.id,
      class_id: course.id
    });
    const { data: submissionRow, error: submissionRowError } = await supabase
      .from("submissions")
      .select("is_empty_submission")
      .eq("id", second.submission_id)
      .single();
    if (submissionRowError || !submissionRow) {
      throw new Error(`Failed to load submission: ${submissionRowError?.message}`);
    }
    expect(submissionRow.is_empty_submission).toBe(true);
  });

  test("Empty submission is rejected when prohibited", async () => {
    const submission = insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentEmptyProhibited!.id,
      class_id: course.id
    });
    await expect(submission).rejects.toThrow("Empty submissions are not permitted for this assignment");
  });

  test("Submission is accepted when prohibited but not empty (no handout match)", async () => {
    // Insert a non-matching handout hash so this submission is considered NOT empty.
    await supabase.from("assignment_handout_file_hashes").insert({
      assignment_id: assignmentProhibitedButNotEmpty!.id,
      sha: "e2e-nonmatch",
      combined_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      file_hashes: {},
      class_id: course.id
    });

    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentProhibitedButNotEmpty!.id,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    const { data: submissionRow } = await supabase
      .from("submissions")
      .select("is_empty_submission")
      .eq("id", submission.submission_id)
      .single();
    expect(submissionRow?.is_empty_submission).toBe(false);
  });
});
