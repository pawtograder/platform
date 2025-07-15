import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { addDays, format } from "date-fns";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
function getTestRunPrefix() {
  const test_run_batch = format(new Date(), "yyyy-MM-dd.HH.mm.ss") + "#" + Math.random().toString(36).substring(2, 6);
  const workerIndex = process.env.TEST_WORKER_INDEX || "undefined";
  return `e2e-${test_run_batch}-${workerIndex}`;
}
export type TestingUser = {
  email: string;
  password: string;
  private_profile_id: string;
  public_profile_id: string;
};

export async function updateClassStartEndDates({
  class_id,
  start_date,
  end_date
}: {
  class_id: number;
  start_date: string;
  end_date: string;
}) {
  await supabase.from("classes").update({ start_date: start_date, end_date: end_date }).eq("id", class_id);
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
  const { data: profileData, error: profileError } = await supabase
    .from("user_roles")
    .select("private_profile_id, public_profile_id")
    .eq("user_id", userData.user.id)
    .single();
  if (!profileData || profileError) {
    throw new Error(`Failed to get profile: ${profileError?.message}`);
  }
  return {
    email: email,
    private_profile_id: profileData.private_profile_id,
    public_profile_id: profileData.public_profile_id,
    password: password
  };
}

export async function insertPreBakedSubmission({
  student_profile_id,
  assignment_group_id,
  assignment_id = 1
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
      assignment_id: 1,
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
  lab_leader,
  day_of_week,
  students,
  start_time,
  end_time
}: {
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
      class_id: 1,
      start_time: start_time ?? "10:00",
      end_time: end_time ?? "11:00"
    })
    .select("id")
    .single();
  if (labSectionError) {
    throw new Error(`Failed to create lab section: ${labSectionError.message}`);
  }
  const lab_section_id = labSectionData.id;
  console.log("Created lab section", lab_section_id);
  for (const student of students) {
    await supabase
      .from("user_roles")
      .update({
        lab_section_id: lab_section_id
      })
      .eq("private_profile_id", student.private_profile_id);
  }
  return {
    lab_section_id: lab_section_id
  };
}

let assignmentIdx = 0;
export async function insertAssignment({
  due_date,
  lab_due_date_offset
}: {
  due_date: string;
  lab_due_date_offset?: number;
}): Promise<Assignment> {
  const test_run_prefix = getTestRunPrefix() + "#" + assignmentIdx;
  const title = `AE2E ${test_run_prefix}`;
  assignmentIdx++;
  const { data: assignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is a test assignment for E2E testing",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: "pawtograder-playground/test-e2e-handout-repo-java",
      autograder_points: 100,
      total_points: 100,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: 1,
      slug: test_run_prefix,
      group_config: "individual",
      self_review_setting_id: 1
    })
    .select("*")
    .single();
  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }
  return assignmentData;
}

export async function insertSubmissionViaAPI({
  student_profile_id,
  assignment_group_id,
  assignment_id = 1
}: {
  student_profile_id?: string;
  assignment_group_id?: number;
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
      sha: "HEAD",
      commit_message: "none"
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
  console.log(token_str);
  const { data } = await supabase.functions.invoke("autograder-create-submission", {
    headers: {
      Authorization: token_str
    }
  });
  console.log(data);
  return {
    repository_name: repository,
    submission_id: 40
  };
}
// async function main() {
//   const student = await createUserInDemoClass({ role: "student" });
//   const submission = await insertSubmissionViaAPI({ student_profile_id: student.private_profile_id, assignment_id: 1 });
//   console.log(submission);
// }
// main();
