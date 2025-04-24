import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CheckRunStatus, GradingScriptResult, OutputVisibility, RepositoryCheckRun } from "../_shared/FunctionTypes.d.ts";
import { resolveRef, updateCheckRun, validateOIDCToken } from "../_shared/GitHubWrapper.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  UserVisibleError,
  SecurityError,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
async function handleRequest(req: Request) {
  const token = req.headers.get("Authorization");
  const requestBody = await req.json() as GradingScriptResult;
  const url = new URL(req.url);
  const autograder_regression_test_id = url.searchParams.get("autograder_regression_test_id") ? 
    parseInt(url.searchParams.get("autograder_regression_test_id")!) : 
    undefined;
  console.log(req.url)
  console.log(`autograder_regression_test_id: ${autograder_regression_test_id}`)
  if (!token) {
    throw new UserVisibleError("No token provided");
  }
  const decoded = await validateOIDCToken(token);
  // Find the corresponding submission
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );
  const { repository, sha } = decoded;
  let class_id, assignment_id: number;
  let submission_id: number | null = null;
  let profile_id: string | null = null;
  let assignment_group_id: number | null = null;
  let checkRun: RepositoryCheckRun | null = null;
  if (autograder_regression_test_id) {
    //It's a regression test run
    const { data: regressionTestRun } = await adminSupabase.from(
      "autograder_regression_test",
    ).select("*,autograder(assignments(id, class_id))").eq(
      "id",
      autograder_regression_test_id,
    )
      .eq("autograder.grader_repo", repository)
      .single();
    if (!regressionTestRun) {
      throw new SecurityError(
        `Regression test run not found: ${autograder_regression_test_id}, grader repo: ${repository}`,
      );
    }
    if (!regressionTestRun.autograder.assignments.class_id) {
      throw new UserVisibleError(
        `Regression test class ID not found: ${autograder_regression_test_id}, grader repo: ${repository}`,
      );
    }
    class_id = regressionTestRun.autograder.assignments.class_id;
    assignment_id = regressionTestRun.autograder.assignments.id;
  } else {
    const { data: submission } = await adminSupabase.from("submissions")
      .select("*, repository_check_runs(*)").eq("repository", repository).eq("sha", sha)
      .eq("run_attempt", Number.parseInt(decoded.run_attempt))
      .eq("run_number", Number.parseInt(decoded.run_id)).single();
    if (!submission) {
      throw new SecurityError(
        `Submission not found: ${repository} ${sha} ${decoded.run_id}`,
      );
    }
    class_id = submission.class_id;
    submission_id = submission.id;
    profile_id = submission.profile_id;
    assignment_group_id = submission.assignment_group_id;
    assignment_id = submission.assignment_id;
    checkRun = submission.repository_check_runs as RepositoryCheckRun;
  }

  //Resolve the action SHA
  const action_sha = await resolveRef(
    requestBody.action_repository,
    requestBody.action_ref,
  );
  console.log("Action SHA", action_sha);
  console.log("Submission ID", submission_id);
  const score = requestBody.feedback.score ||
  requestBody.feedback.tests.filter((test) => !test.hide_until_released).reduce(
    (acc, test) => acc + (test.score || 0),
    0,
  );
  const max_score = requestBody.feedback.max_score ||
  requestBody.feedback.tests.reduce(
    (acc, test) => acc + (test.max_score || 0),
    0,
  );
  const { error, data: resultID } = await adminSupabase.from(
    "grader_results",
  ).insert({
    submission_id,
    profile_id,
    class_id,
    assignment_group_id,
    ret_code: requestBody.ret_code,
    grader_sha: requestBody.grader_sha,
    score,
    max_score,
    lint_output: requestBody.feedback.lint.output,
    lint_output_format: requestBody.feedback.lint.output_format ||
      "text",
    lint_passed: requestBody.feedback.lint.status === "pass",
    execution_time: requestBody.execution_time,
    autograder_regression_test: autograder_regression_test_id,
    grader_action_sha: action_sha,
  }).select("id").single();
  if (error) {
    console.error(error);
    throw new UserVisibleError(
      `Failed to insert feedback: ${error.message}`,
    );
  }
  // Insert feedback for each visibility level
  for (
    const visibility of [
      "hidden",
      "visible",
      "after_due_date",
      "after_published",
    ]
  ) {
    //Insert output if it exists
    console.log(`Received this output:`);
    console.log(`Grader result ID: ${resultID.id}`);
    if (requestBody.feedback.output[visibility as OutputVisibility]) {
      const output =
        requestBody.feedback.output[visibility as OutputVisibility];
      if (output) {
        console.log(`${visibility}: ${output?.output_format} ${output?.output.substring(0, 100)}...`);
        const { error: outputError } = await adminSupabase.from("grader_result_output").insert({
          class_id,
          student_id: profile_id,
          assignment_group_id,
          grader_result_id: resultID.id,
          visibility: visibility as OutputVisibility,
          format: output.output_format || "text",
          output: output.output,
        });
        console.log(`Inserted output: ${outputError}`);
        if (outputError) {
          console.error(outputError);
          throw new UserVisibleError(
            `Failed to insert output: ${outputError.message}`,
          );
        }
      }
    }
  }
  //Insert test results
  const { error: testResultsError } = await adminSupabase
    .from("grader_result_tests").insert(
      requestBody.feedback.tests.map((test) => ({
        class_id: class_id,
        student_id: profile_id,
        assignment_group_id,
        grader_result_id: resultID.id,
        name: test.name,
        output: test.output,
        output_format: test.output_format || "text",
        name_format: test.name_format || "text",
        score: test.score,
        max_score: test.max_score,
        part: test.part,
        extra_data: test.extra_data,
        is_released: !test.hide_until_released,
      })),
    );
  if (testResultsError) {
    throw new UserVisibleError(
      `Failed to insert test results: ${testResultsError.message}`,
    );
  }
  // Update the check run status to completed
  // await GitHubController.getInstance().completeCheckRun(submission, requestBody.feedback);
  if (submission_id) {
    if(checkRun){
      const newStatus: CheckRunStatus = {
        ...((checkRun.status) as CheckRunStatus),
        completed_at: new Date().toISOString(),
      }
      await adminSupabase.from("repository_check_runs").update({
        status: newStatus,
      }).eq("id", checkRun.id);
      await updateCheckRun({
        owner: repository.split("/")[0],
        repo: repository.split("/")[1],
        check_run_id: checkRun.check_run_id,
        status: "completed",
        conclusion: "success",
        details_url: `https://${Deno.env.get("APP_URL")}/course/${class_id}/assignments/${assignment_id}/submissions/${submission_id}`,
        output: { 
          title: "Grading complete",
          summary: "Pawtograder has finished grading the submission",
          text: `Autograder score: ${score} / ${max_score}. See more details in Pawtograder.`
        }
      });
    }
    return {
      is_ok: true,
      message: `Submission ${submission_id} registered`,
      details_url:
        `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/assignments/${assignment_id}/submissions/${submission_id}`,
    };
  } else {
    return {
      is_ok: true,
      message: `Regression test run ${resultID} registered`,
      details_url:
        `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/manage/assignments/${assignment_id}/autograder/regression-test-run/${resultID}`,
    };
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
