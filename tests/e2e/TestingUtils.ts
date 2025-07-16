import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { addDays, format } from "date-fns";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

export const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export function getTestRunPrefix() {
  const test_run_batch = format(new Date(), "yyyy-MM-dd.HH.mm.ss") + "#" + Math.random().toString(36).substring(2, 6);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined";
  return `e2e-${test_run_batch}-${workerIndex}`;
}
export type TestingUser = {
  email: string;
  password: string;
  user_id: string;
  private_profile_id: string;
  public_profile_id: string;
};

export async function createClass() {
  const className = `E2E Test Class ${getTestRunPrefix()}`;
  const { data: classData, error: classError } = await supabase.from("classes").insert({
    name: className,
    start_date: new Date().toISOString(),
    end_date: addDays(new Date(), 180).toISOString(),
    late_tokens_per_student: 10,
    time_zone: "America/New_York"
  }).select("*").single();
  if (classError) {
    throw new Error(`Failed to create class: ${classError.message}`);
  }
  if (!classData) {
    throw new Error("Failed to create class");
  }
  return classData;
}

export async function createClassSection({
  class_id
}: {
  class_id: number;
}) {
  const { data: sectionData, error: sectionError } = await supabase.from("class_sections").insert({
    class_id: class_id,
    name: `E2E Test Section ${getTestRunPrefix()}`
  }).select("*").single();
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
  await supabase.from("classes").update({ start_date: start_date, end_date: end_date, late_tokens_per_student: late_tokens_per_student }).eq("id", class_id);
}
export async function loginAsUser(page: Page, testingUser: TestingUser) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Sign in email" }).click();
  await page.getByRole("textbox", { name: "Sign in email" }).fill(testingUser.email);
  await page.getByRole("textbox", { name: "Sign in email" }).press("Tab");
  await page.getByRole("textbox", { name: "Sign in password" }).fill(testingUser.password);
  await page.getByRole("button", { name: "Sign in with email" }).click();
}
export async function createUserInDemoClass({
  role
}: {
  role: "student" | "instructor" | "grader";
}) {
  const class_id = 1;
  return createUserInClass({ role, class_id });
}
export async function createUserInClass({
  role,
  class_id,
  section_id,
  lab_section_id
}: {
  role: "student" | "instructor" | "grader";
  class_id: number;
  section_id?: number;
  lab_section_id?: number;
}): Promise<TestingUser> {
  const password = "test";
  const extra_randomness = Math.random().toString(36).substring(2, 15);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
  const email = `${role}-${workerIndex}-${extra_randomness}@pawtograder.net`;
  const { data: userData, error: userError } = await supabase.auth.admin.createUser({
    email: email,
    password: password,
    email_confirm: true
  });
  if (userError) {
    throw new Error(`Failed to create user: ${userError.message}`);
  }
  if (class_id !== 1) {
    const { data: publicProfileData, error: publicProfileError } = await supabase.from("profiles").insert({
      name: `E2E Test User ${getTestRunPrefix()} Public Profile`,
      avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(email)}`,
      class_id: class_id,
      is_private_profile: false
    }).select("id").single();
    if (publicProfileError) {
      throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
    }
    const { data: privateProfileData, error: privateProfileError } = await supabase.from("profiles").insert({
      name: `E2E Test User ${getTestRunPrefix()} Private Profile`,
      avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(email)}`,
      class_id: class_id,
      is_private_profile: true
    }).select("id").single();
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
    await supabase.from("user_roles").update({
      class_section_id: section_id,
      lab_section_id: lab_section_id
    }).eq("user_id", userData.user.id)
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
  console.log(`Created ${role} ${email}, private_profile_id: ${profileData.private_profile_id}, public_profile_id: ${profileData.public_profile_id}`)
  return {
    email: email,
    user_id: userData.user.id,
    private_profile_id: profileData.private_profile_id,
    public_profile_id: profileData.public_profile_id,
    password: password
  };
}

export async function insertPreBakedSubmission({
  student_profile_id,
  assignment_group_id,
  assignment_id
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  assignment_id: number;
}): Promise<{
  submission_id: number;
  repository_name: string;
}> {
  const test_run_prefix = getTestRunPrefix();
  const repository = `not-actually/repository-${test_run_prefix}`;
  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment_id,
      repository: repository,
      class_id: 1,
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
      class_id: 1,
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
      class_id: 1,
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
    class_id: 1,
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
      class_id: 1,
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
      class_id: 1,
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
      class_id: 1,
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
  const lab_section_name = `E2E Test Lab Section ${getTestRunPrefix()} on ${day_of_week}`;
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

let assignmentIdx = 0;
export async function insertAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
}): Promise<Assignment> {
  const test_run_prefix = getTestRunPrefix() + "#" + assignmentIdx;
  const title = `Test ${test_run_prefix}`;
  assignmentIdx++;
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
      class_id: 1,
      slug: test_run_prefix,
      group_config: "individual",
      self_review_setting_id: 1,
      allow_not_graded_submissions: allow_not_graded_submissions || false
    })
    .select("id")
    .single();
  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }
  const { data: assignmentData } = await supabase.from("assignments").select("*").eq("id", insertedAssignmentData.id).single();
  if (!assignmentData) {
    throw new Error("Failed to get assignment");
  }
  await supabase.from("autograder").update({
    config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
  }).eq("id", assignmentData.id);

  const partsData = await supabase.from("rubric_parts").insert([{
    class_id: 1,
    name: "Self Review",
    description: "Self review rubric",
    ordinal: 0,
    rubric_id: assignmentData.self_review_rubric_id || 0
  }, {
    class_id: 1,
    name: "Grading Review",
    description: "Grading review rubric",
    ordinal: 1,
    rubric_id: assignmentData.grading_rubric_id || 0
  }]).select("id");
  if (partsData.error) {
    throw new Error(`Failed to create rubric parts: ${partsData.error.message}`);
  }
  const self_review_part_id = partsData.data?.[0]?.id;
  const grading_review_part_id = partsData.data?.[1]?.id;
  const criteriaData = await supabase.from("rubric_criteria").insert([{
    class_id: 1,
    name: "Self Review Criteria",
    description: "Criteria for self review evaluation",
    ordinal: 0,
    total_points: 10,
    is_additive: true,
    rubric_part_id: self_review_part_id || 0,
    rubric_id: assignmentData.self_review_rubric_id || 0
  }, {
    class_id: 1,
    name: "Grading Review Criteria",
    description: "Criteria for grading review evaluation",
    ordinal: 0,
    total_points: 20,
    is_additive: true,
    rubric_part_id: grading_review_part_id || 0,
    rubric_id: assignmentData.grading_rubric_id || 0
  }]).select("id");
  if (criteriaData.error) {
    throw new Error(`Failed to create rubric criteria: ${criteriaData.error.message}`);
  }
  const selfReviewCriteriaId = criteriaData.data?.[0]?.id;
  const gradingReviewCriteriaId = criteriaData.data?.[1]?.id;
  await supabase.from("rubric_checks").insert([{
    rubric_criteria_id: selfReviewCriteriaId || 0,
    name: "Self Review Check 1",
    description: "First check for self review",
    ordinal: 0,
    points: 5,
    is_annotation: true,
    is_comment_required: false,
    class_id: 1,
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
    class_id: 1,
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
    class_id: 1,
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
    class_id: 1,
    is_required: true
  }
  ]).select("id");

  return assignmentData;
}

export async function insertSubmissionViaAPI({
  student_profile_id,
  assignment_group_id,
  sha,
  commit_message,
  assignment_id = 1
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
  sha?: string;
  commit_message?: string;
  assignment_id?: number;
}): Promise<{
  submission_id: number;
  repository_name: string;
}> {
  const test_run_batch = "abcd" + Math.random().toString(36).substring(2, 15);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
  const repository = `pawtograder-playground/test-e2e-student-repo-java--${test_run_batch}-${workerIndex}`;
  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: assignment_id,
      repository: repository,
      class_id: 1,
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
      class_id: 1,
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
    sha: "HEAD",
    workflow_ref: ".github/workflows/grade.yml-e2e-test",
    run_id: 1,
    run_attempt: 1
  };
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: process.env.END_TO_END_SECRET || "not-a-secret"
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
  if ('error' in data) {
    if ('details' in data.error) {
      throw new Error(data.error.details);
    }
    throw new Error("Failed to create submission");
  }
  return {
    repository_name: repository,
    submission_id: data.submission_id
  };
}