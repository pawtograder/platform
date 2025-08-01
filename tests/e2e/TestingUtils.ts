import { Assignment, Course, RubricCheck } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { addDays, format } from "date-fns";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

export const supabase = createClient<Database>(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!);
export function getTestRunPrefix(randomSuffix?: string) {
  const suffix = randomSuffix ?? Math.random().toString(36).substring(2, 6);
  const test_run_batch = format(new Date(), "dd/MM/yy HH:mm:ss") + "#" + suffix;
  const workerIndex = process.env["TEST_WORKER_INDEX"] || "";
  return `e2e-${test_run_batch}-${workerIndex}`;
}
export type TestingUser = {
  private_profile_name: string;
  public_profile_name: string;
  email: string;
  password: string;
  user_id: string;
  private_profile_id: string;
  public_profile_id: string;
  class_id: number;
};

export async function createClass() {
  const className = `E2E Test Class`;
  const { data: classData, error: classError } = await supabase
    .from("classes")
    .insert({
      name: className,
      slug: className.toLowerCase().replace(/ /g, "-"),
      start_date: addDays(new Date(), -30).toISOString(),
      end_date: addDays(new Date(), 180).toISOString(),
      late_tokens_per_student: 10,
      time_zone: "America/New_York"
    })
    .select("*")
    .single();
  if (classError) {
    throw new Error(`Failed to create class: ${classError.message}`);
  }
  if (!classData) {
    throw new Error("Failed to create class");
  }
  return classData;
}
let sectionIdx = 1;
export async function createClassSection({ class_id }: { class_id: number }) {
  const { data: sectionData, error: sectionError } = await supabase
    .from("class_sections")
    .insert({
      class_id: class_id,
      name: `Section #${sectionIdx}Test`
    })
    .select("*")
    .single();
  sectionIdx++;
  if (sectionError) {
    throw new Error(`Failed to create class section: ${sectionError.message}`);
  }
  if (!sectionData) {
    throw new Error("Failed to create class section");
  }
  return sectionData;
}
export async function updateClassSettings({
  class_id,
  start_date,
  end_date,
  late_tokens_per_student
}: {
  class_id: number;
  start_date: string;
  end_date: string;
  late_tokens_per_student?: number;
}) {
  await supabase
    .from("classes")
    .update({ start_date: start_date, end_date: end_date, late_tokens_per_student: late_tokens_per_student })
    .eq("id", class_id);
}
export async function loginAsUser(page: Page, testingUser: TestingUser, course?: Course) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Sign in email" }).click();
  await page.getByRole("textbox", { name: "Sign in email" }).fill(testingUser.email);
  await page.getByRole("textbox", { name: "Sign in email" }).press("Tab");
  await page.getByRole("textbox", { name: "Sign in password" }).fill(testingUser.password);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  if (course) {
    await page.getByRole("link", { name: course.name! }).click();
  }
}

const userIdx = {
  student: 1,
  instructor: 1,
  grader: 1
};
export async function createUserInClass({
  role,
  class_id,
  section_id,
  lab_section_id,
  randomSuffix
}: {
  role: "student" | "instructor" | "grader";
  class_id: number;
  section_id?: number;
  lab_section_id?: number;
  randomSuffix?: string;
}): Promise<TestingUser> {
  const password = process.env["TEST_PASSWORD"] || "change-it";
  const extra_randomness = randomSuffix ?? Math.random().toString(36).substring(2, 15);
  const workerIndex = process.env["TEST_WORKER_INDEX"] || "undefined-worker-index";
  const email = `${role}-${workerIndex}-${extra_randomness}-${userIdx[role]}@pawtograder.net`;
  const name = `${role.charAt(0).toUpperCase()}${role.slice(1)} #${userIdx[role]}Test`;
  const public_profile_name = `Pseudonym #${userIdx[role]} ${role.charAt(0).toUpperCase()}${role.slice(1)}`;
  const private_profile_name = `${name}`;
  userIdx[role]++;
  const { data: userData, error: userError } = await supabase.auth.admin.createUser({
    email: email,
    password: password,
    email_confirm: true
  });
  if (userError) {
    console.error(userError);
    throw new Error(`Failed to create user: ${userError.message}`);
  }
  if (class_id !== 1) {
    const { data: publicProfileData, error: publicProfileError } = await supabase
      .from("profiles")
      .insert({
        name: public_profile_name,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(email)}`,
        class_id: class_id,
        is_private_profile: false
      })
      .select("id")
      .single();
    if (publicProfileError) {
      throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
    }
    const { data: privateProfileData, error: privateProfileError } = await supabase
      .from("profiles")
      .insert({
        name: private_profile_name,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(email)}`,
        class_id: class_id,
        is_private_profile: true
      })
      .select("id")
      .single();
    if (privateProfileError) {
      throw new Error(`Failed to create private profile: ${privateProfileError.message}`);
    }
    if (!publicProfileData || !privateProfileData) {
      throw new Error("Failed to create public or private profile");
    }
    await supabase.from("user_roles").insert({
      user_id: userData.user.id,
      class_id: class_id,
      private_profile_id: privateProfileData.id,
      public_profile_id: publicProfileData.id,
      role: role,
      class_section_id: section_id,
      lab_section_id: lab_section_id
    });
  } else if (section_id || lab_section_id) {
    await supabase
      .from("user_roles")
      .update({
        class_section_id: section_id,
        lab_section_id: lab_section_id
      })
      .eq("user_id", userData.user.id)
      .eq("class_id", class_id);
  }
  const { data: profileData, error: profileError } = await supabase
    .from("user_roles")
    .select("private_profile_id, public_profile_id")
    .eq("user_id", userData.user.id)
    .eq("class_id", class_id)
    .single();
  if (!profileData || profileError) {
    throw new Error(`Failed to get profile: ${profileError?.message}`);
  }
  return {
    private_profile_name: private_profile_name,
    public_profile_name: public_profile_name,
    email: email,
    user_id: userData.user.id,
    private_profile_id: profileData.private_profile_id,
    public_profile_id: profileData.public_profile_id,
    password: password,
    class_id: class_id
  };
}

let repoCounter = 0;
export async function insertPreBakedSubmission({
  student_profile_id,
  assignment_group_id,
  assignment_id,
  class_id,
  repositorySuffix
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  assignment_id: number;
  class_id: number;
  repositorySuffix?: string;
}): Promise<{
  submission_id: number;
  repository_name: string;
}> {
  const test_run_prefix = repositorySuffix ?? getTestRunPrefix();
  const repository = `not-actually/repository-${test_run_prefix}-${repoCounter}`;
  repoCounter++;
  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment_id,
      repository: repository,
      class_id: class_id,
      assignment_group_id,
      profile_id: student_profile_id,
      synced_handout_sha: "none"
    })
    .select("id")
    .single();
  if (repositoryError) {
    throw new Error(`Failed to create repository: ${repositoryError.message}`);
  }
  const repository_id = repositoryData?.id;

  const { data: checkRunData, error: checkRunError } = await supabase
    .from("repository_check_runs")
    .insert({
      class_id: class_id,
      repository_id: repository_id,
      check_run_id: 1,
      status: "{}",
      sha: "none",
      commit_message: "none"
    })
    .select("id")
    .single();
  if (checkRunError) {
    console.error(checkRunError);
    throw new Error("Failed to create check run");
  }
  const check_run_id = checkRunData?.id;
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .insert({
      assignment_id: assignment_id,
      profile_id: student_profile_id,
      assignment_group_id: assignment_group_id,
      sha: "none",
      repository: repository,
      run_attempt: 1,
      run_number: 1,
      class_id: class_id,
      repository_check_run_id: check_run_id,
      repository_id: repository_id
    })
    .select("id")
    .single();
  if (submissionError) {
    console.error(submissionError);
    throw new Error("Failed to create submission");
  }
  const submission_id = submissionData?.id;
  const { error: submissionFileError } = await supabase.from("submission_files").insert({
    name: "sample.java",
    contents: `package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

  /*
   * This method takes two integers and returns their sum.
   * 
   * @param a the first integer
   * @param b the second integer
   * @return the sum of a and b
   */
  public int doMath(int a, int b) {
      return a+b;
  }

  /**
   * This method returns a message, "Hello, World!"
   * @return
   */
  public String getMessage() {
      
      return "Hello, World!";
  }
}`,
    class_id: class_id,
    submission_id: submission_id,
    profile_id: student_profile_id,
    assignment_group_id: assignment_group_id
  });
  if (submissionFileError) {
    console.error(submissionFileError);
    throw new Error("Failed to create submission file");
  }
  const { data: graderResultData, error: graderResultError } = await supabase
    .from("grader_results")
    .insert({
      submission_id: submission_id,
      score: 5,
      class_id: class_id,
      profile_id: student_profile_id,
      assignment_group_id: assignment_group_id,
      lint_passed: true,
      lint_output: "no lint output",
      lint_output_format: "markdown",
      max_score: 10
    })
    .select("id")
    .single();
  if (graderResultError) {
    console.error(graderResultError);
    throw new Error("Failed to create grader result");
  }
  const { error: graderResultTestError } = await supabase.from("grader_result_tests").insert([
    {
      score: 5,
      max_score: 5,
      name: "test 1",
      name_format: "text",
      output: "here is a bunch of output\n**wow**",
      output_format: "markdown",
      class_id: class_id,
      student_id: student_profile_id,
      assignment_group_id,
      grader_result_id: graderResultData.id,
      is_released: true
    },
    {
      score: 5,
      max_score: 5,
      name: "test 2",
      name_format: "text",
      output: "here is a bunch of output\n**wow**",
      output_format: "markdown",
      class_id: class_id,
      student_id: student_profile_id,
      assignment_group_id,
      grader_result_id: graderResultData.id,
      is_released: true
    }
  ]);
  if (graderResultTestError) {
    console.error(graderResultTestError);
    throw new Error("Failed to create grader result test");
  }
  return {
    submission_id: submission_id,
    repository_name: repository
  };
}

let labSectionIdx = 1;
export async function createLabSectionWithStudents({
  class_id,
  lab_leader,
  day_of_week,
  students,
  start_time,
  end_time
}: {
  class_id?: number;
  lab_leader: TestingUser;
  day_of_week: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  students: TestingUser[];
  start_time?: string;
  end_time?: string;
}) {
  const lab_section_name = `Lab #${labSectionIdx} (${day_of_week})`;
  labSectionIdx++;
  const { data: labSectionData, error: labSectionError } = await supabase
    .from("lab_sections")
    .insert({
      lab_leader_id: lab_leader.private_profile_id,
      name: lab_section_name,
      day_of_week: day_of_week,
      class_id: class_id || 1,
      start_time: start_time ?? "10:00",
      end_time: end_time ?? "11:00"
    })
    .select("*")
    .single();
  if (labSectionError) {
    throw new Error(`Failed to create lab section: ${labSectionError.message}`);
  }
  const lab_section_id = labSectionData.id;
  for (const student of students) {
    await supabase
      .from("user_roles")
      .update({
        lab_section_id: lab_section_id
      })
      .eq("private_profile_id", student.private_profile_id);
  }
  return labSectionData;
}

const assignmentIdx = {
  lab: 1,
  assignment: 1
};
export async function insertAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions,
  class_id
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
  class_id: number;
}): Promise<Assignment & { rubricChecks: RubricCheck[] }> {
  const title = `Assignment #${assignmentIdx.assignment}Test`;
  assignmentIdx.assignment++;
  const { data: selfReviewSettingData, error: selfReviewSettingError } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: class_id,
      enabled: true,
      deadline_offset: 2,
      allow_early: true
    })
    .select("id")
    .single();
  if (selfReviewSettingError) {
    throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
  }
  const self_review_setting_id = selfReviewSettingData.id;
  const { data: insertedAssignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is a test assignment for E2E testing",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: "pawtograder-playground/test-e2e-handout-repo-java",
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: class_id,
      slug: `assignment-${assignmentIdx.assignment}`,
      group_config: "individual",
      allow_not_graded_submissions: allow_not_graded_submissions || false,
      self_review_setting_id: self_review_setting_id
    })
    .select("id")
    .single();
  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }
  const { data: assignmentData } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", insertedAssignmentData.id)
    .single();
  if (!assignmentData) {
    throw new Error("Failed to get assignment");
  }
  await supabase
    .from("autograder")
    .update({
      config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
    })
    .eq("id", assignmentData.id);

  const partsData = await supabase
    .from("rubric_parts")
    .insert([
      {
        class_id: class_id,
        name: "Self Review",
        description: "Self review rubric",
        ordinal: 0,
        rubric_id: assignmentData.self_review_rubric_id || 0
      },
      {
        class_id: class_id,
        name: "Grading Review",
        description: "Grading review rubric",
        ordinal: 1,
        rubric_id: assignmentData.grading_rubric_id || 0
      }
    ])
    .select("id");
  if (partsData.error) {
    throw new Error(`Failed to create rubric parts: ${partsData.error.message}`);
  }
  const self_review_part_id = partsData.data?.[0]?.id;
  const grading_review_part_id = partsData.data?.[1]?.id;
  const criteriaData = await supabase
    .from("rubric_criteria")
    .insert([
      {
        class_id: class_id,
        name: "Self Review Criteria",
        description: "Criteria for self review evaluation",
        ordinal: 0,
        total_points: 10,
        is_additive: true,
        rubric_part_id: self_review_part_id || 0,
        rubric_id: assignmentData.self_review_rubric_id || 0
      },
      {
        class_id: class_id,
        name: "Grading Review Criteria",
        description: "Criteria for grading review evaluation",
        ordinal: 0,
        total_points: 20,
        is_additive: true,
        rubric_part_id: grading_review_part_id || 0,
        rubric_id: assignmentData.grading_rubric_id || 0
      }
    ])
    .select("id");
  if (criteriaData.error) {
    throw new Error(`Failed to create rubric criteria: ${criteriaData.error.message}`);
  }
  const selfReviewCriteriaId = criteriaData.data?.[0]?.id;
  const gradingReviewCriteriaId = criteriaData.data?.[1]?.id;
  const { data: rubricChecksData, error: rubricChecksError } = await supabase
    .from("rubric_checks")
    .insert([
      {
        rubric_criteria_id: selfReviewCriteriaId || 0,
        name: "Self Review Check 1",
        description: "First check for self review",
        ordinal: 0,
        points: 5,
        is_annotation: true,
        is_comment_required: false,
        class_id: class_id,
        is_required: true
      },
      {
        rubric_criteria_id: selfReviewCriteriaId || 0,
        name: "Self Review Check 2",
        description: "Second check for self review",
        ordinal: 1,
        points: 5,
        is_annotation: false,
        is_comment_required: false,
        class_id: class_id,
        is_required: true
      },
      {
        rubric_criteria_id: gradingReviewCriteriaId || 0,
        name: "Grading Review Check 1",
        description: "First check for grading review",
        ordinal: 0,
        points: 10,
        is_annotation: true,
        is_comment_required: false,
        class_id: class_id,
        is_required: true
      },
      {
        rubric_criteria_id: gradingReviewCriteriaId || 0,
        name: "Grading Review Check 2",
        description: "Second check for grading review",
        ordinal: 1,
        points: 10,
        is_annotation: false,
        is_comment_required: false,
        class_id: class_id,
        is_required: true
      }
    ])
    .select("*");
  if (rubricChecksError) {
    throw new Error(`Failed to create rubric checks: ${rubricChecksError.message}`);
  }

  return { ...assignmentData, rubricChecks: rubricChecksData };
}

export async function insertSubmissionViaAPI({
  student_profile_id,
  assignment_group_id,
  sha,
  commit_message,
  assignment_id = 1,
  class_id,
  repositorySuffix,
  timestampOverride
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  sha?: string;
  commit_message?: string;
  assignment_id?: number;
  class_id: number;
  repositorySuffix?: string;
  timestampOverride?: number;
}): Promise<{
  submission_id: number;
  repository_name: string;
}> {
  const test_run_batch = repositorySuffix ?? "abcd" + Math.random().toString(36).substring(2, 15);
  const workerIndex = process.env["TEST_WORKER_INDEX"] || "undefined-worker-index";
  const timestamp = timestampOverride ?? Date.now();
  const studentId = student_profile_id?.slice(0, 8) || "no-student";
  const assignmentStr = assignment_id || 1;
  const repository = `pawtograder-playground/test-e2e-student-repo-java--${test_run_batch}-${workerIndex}-${assignmentStr}-${studentId}-${timestamp}`;
  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment_id,
      repository: repository,
      class_id: class_id,
      assignment_group_id,
      profile_id: student_profile_id,
      synced_handout_sha: "none"
    })
    .select("id")
    .single();
  if (repositoryError) {
    throw new Error(`Failed to create repository: ${repositoryError.message}`);
  }
  const repository_id = repositoryData?.id;

  const { error: checkRunError } = await supabase
    .from("repository_check_runs")
    .insert({
      class_id: class_id,
      repository_id: repository_id,
      check_run_id: 1,
      status: "{}",
      sha: sha || "HEAD",
      commit_message: commit_message || "none"
    })
    .select("id")
    .single();
  if (checkRunError) {
    console.error(checkRunError);
    throw new Error("Failed to create check run");
  }
  // Prepare a JWT token to invoke the edge function
  const payload = {
    repository: repository,
    sha: sha || "HEAD",
    workflow_ref: ".github/workflows/grade.yml-e2e-test",
    run_id: 1,
    run_attempt: 1
  };
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: process.env["END_TO_END_SECRET"] || "not-a-secret"
  };
  const token_str =
    Buffer.from(JSON.stringify(header)).toString("base64") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64") +
    ".";
  const { data } = await supabase.functions.invoke("autograder-create-submission", {
    headers: {
      Authorization: token_str
    }
  });
  if (data == null) {
    throw new Error("Failed to create submission, no data returned");
  }
  if ("error" in data) {
    if ("details" in data.error) {
      throw new Error(data.error.details);
    }
    throw new Error("Failed to create submission");
  }
  return {
    repository_name: repository,
    submission_id: data.submission_id
  };
}

export async function createDueDateException(
  assignment_id: number,
  student_profile_id: string,
  class_id: number,
  hoursExtension: number
) {
  const { data: exceptionData, error: exceptionError } = await supabase
    .from("assignment_due_date_exceptions")
    .insert({
      class_id: class_id,
      assignment_id: assignment_id,
      student_id: student_profile_id,
      creator_id: student_profile_id,
      hours: hoursExtension,
      minutes: 0,
      tokens_consumed: Math.ceil(hoursExtension / 24)
    })
    .select("*")
    .single();

  if (exceptionError) {
    throw new Error(`Failed to create due date exception: ${exceptionError.message}`);
  }
  return exceptionData;
}

export async function createRegradeRequest(
  submission_id: number,
  assignment_id: number,
  student_profile_id: string,
  grader_profile_id: string,
  rubric_check_id: number,
  class_id: number,
  status: "opened" | "resolved" | "closed",
  options?: {
    commentPoints?: number;
    initialPoints?: number;
    resolvedPoints?: number;
    closedPoints?: number;
  }
) {
  // First create a submission comment to reference
  const { data: commentData, error: commentError } = await supabase
    .from("submission_comments")
    .insert({
      submission_id: submission_id,
      author: grader_profile_id,
      comment: "Test comment for regrade request",
      points: options?.commentPoints ?? Math.floor(Math.random() * 10),
      class_id: class_id,
      rubric_check_id,
      released: true
    })
    .select("*")
    .single();

  if (commentError) {
    throw new Error(`Failed to create submission comment: ${commentError.message}`);
  }

  const { data: regradeData, error: regradeError } = await supabase
    .from("submission_regrade_requests")
    .insert({
      submission_id: submission_id,
      class_id: class_id,
      assignment_id: assignment_id,
      opened_at: new Date().toISOString(),
      created_by: student_profile_id,
      assignee: grader_profile_id,
      closed_by: status === "closed" ? grader_profile_id : null,
      closed_at: status === "closed" ? new Date().toISOString() : null,
      status: status,
      resolved_by: status === "resolved" || status === "closed" ? grader_profile_id : null,
      resolved_at: status === "resolved" || status === "closed" ? new Date().toISOString() : null,
      submission_comment_id: commentData.id, // Reference the comment we just created
      initial_points: options?.initialPoints ?? Math.floor(Math.random() * 100),
      resolved_points:
        status === "resolved" || status === "closed"
          ? (options?.resolvedPoints ?? Math.floor(Math.random() * 100))
          : null,
      closed_points: status === "closed" ? (options?.closedPoints ?? Math.floor(Math.random() * 100)) : null,
      last_updated_at: new Date().toISOString()
    })
    .select("*")
    .single();

  if (regradeError) {
    throw new Error(`Failed to create regrade request: ${regradeError.message}`);
  }
  //Update the comment to reference the regrade request
  const { error: commentUpdateError } = await supabase
    .from("submission_comments")
    .update({ regrade_request_id: regradeData.id })
    .eq("id", commentData.id);
  if (commentUpdateError) {
    throw new Error(`Failed to update submission comment: ${commentUpdateError.message}`);
  }

  return regradeData;
}

export async function gradeSubmission(
  grading_review_id: number,
  grader_profile_id: string,
  isCompleted: boolean,
  options?: {
    checkApplyChance?: number; // Probability (0-1) that non-required checks are applied
    pointsRandomizer?: () => number; // Function to generate random points (0-1)
    fileSelectionRandomizer?: () => number; // Function to select file index (0-1)
    lineNumberRandomizer?: () => number; // Function to generate line numbers (returns 1-5)
    totalScoreOverride?: number;
    totalAutogradeScoreOverride?: number;
  }
) {
  // Get the submission review details to find the rubric and submission
  const { data: reviewInfo, error: reviewError } = await supabase
    .from("submission_reviews")
    .select("id, submission_id, rubric_id, class_id")
    .eq("id", grading_review_id)
    .single();

  if (reviewError || !reviewInfo) {
    throw new Error(`Failed to get submission review: ${reviewError?.message}`);
  }

  if (isCompleted) {
    // Get all rubric checks for this rubric
    const { data: rubricChecks, error: checksError } = await supabase
      .from("rubric_checks")
      .select(
        `
        id, name, is_annotation, points, is_required, file,
        rubric_criteria!inner(id, rubric_id)
      `
      )
      .eq("rubric_criteria.rubric_id", reviewInfo.rubric_id);

    if (checksError) {
      throw new Error(`Failed to get rubric checks: ${checksError.message}`);
    }

    // Get submission files for annotation comments
    const { data: submissionFiles } = await supabase
      .from("submission_files")
      .select("id, name")
      .eq("submission_id", reviewInfo.submission_id);

    // Create comments for each rubric check
    for (const check of rubricChecks || []) {
      // Use provided chance or default 80% chance to apply non-required checks, 100% for required ones
      const applyChance = options?.checkApplyChance ?? 0.8;
      const shouldApply = check.is_required || Math.random() < applyChance;

      if (shouldApply) {
        const randomValue = options?.pointsRandomizer?.() ?? Math.random();
        const pointsAwarded = Math.floor(randomValue * (check.points + 1)); // 0 to max points

        if (check.is_annotation) {
          // Create submission file comment (annotation)
          let file_id = null;

          if (check.file && submissionFiles) {
            const matchingFile = submissionFiles.find((f) => f.name === check.file);
            file_id = matchingFile?.id || submissionFiles[0]?.id; // Use specified file or first available
          } else if (submissionFiles && submissionFiles.length > 0) {
            const fileRandomValue = options?.fileSelectionRandomizer?.() ?? Math.random();
            file_id = submissionFiles[Math.floor(fileRandomValue * submissionFiles.length)]?.id;
          }

          if (file_id) {
            const lineRandomValue = options?.lineNumberRandomizer?.() ?? Math.random();
            const lineNumber = Math.floor(lineRandomValue * 5) + 1; // Random line number 1-5

            await supabase.from("submission_file_comments").insert({
              submission_id: reviewInfo.submission_id,
              submission_file_id: file_id,
              author: grader_profile_id,
              comment: `${check.name}: Grading comment for this check`,
              points: pointsAwarded,
              line: lineNumber,
              class_id: reviewInfo.class_id,
              released: true,
              rubric_check_id: check.id,
              submission_review_id: grading_review_id
            });
          }
        } else {
          // Create submission comment (general comment)
          await supabase.from("submission_comments").insert({
            submission_id: reviewInfo.submission_id,
            author: grader_profile_id,
            comment: `${check.name}: ${pointsAwarded}/${check.points} points - ${check.name.includes("quality") ? "Good work on this aspect!" : "Applied this grading criteria"}`,
            points: pointsAwarded,
            class_id: reviewInfo.class_id,
            released: true,
            rubric_check_id: check.id,
            submission_review_id: grading_review_id
          });
        }
      }
    }
  }

  // Update the submission review
  const totalScore = options?.totalScoreOverride ?? (isCompleted ? Math.floor(Math.random() * 100) : 0);
  const totalAutogradeScore = options?.totalAutogradeScoreOverride ?? Math.floor(Math.random() * 100);

  const updateData = {
    grader: grader_profile_id,
    total_score: totalScore,
    released: isCompleted,
    completed_by: isCompleted ? grader_profile_id : null,
    completed_at: isCompleted ? new Date().toISOString() : null,
    total_autograde_score: totalAutogradeScore
  };

  const { data: reviewResult, error: updateError } = await supabase
    .from("submission_reviews")
    .update(updateData)
    .eq("id", grading_review_id)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Failed to update submission review: ${updateError.message}`);
  }

  return reviewResult;
}
