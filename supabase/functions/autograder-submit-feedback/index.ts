import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  CheckRunStatus,
  FeedbackArtifactComment,
  FeedbackComment,
  FeedbackLineComment,
  GradeResponse,
  GradingScriptResult,
  OutputVisibility,
  RepositoryCheckRun
} from "../_shared/FunctionTypes.d.ts";
import { resolveRef, validateOIDCTokenOrAllowE2E, END_TO_END_REPO_PREFIX } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

type GraderResultErrors = Database["public"]["Tables"]["grader_results"]["Row"]["errors"];

const RESET_WINDOW_MS = 60_000;

async function insertComments({
  adminSupabase,
  class_id,
  submission_id,
  grading_review_id,
  comments,
  scope
}: {
  adminSupabase: SupabaseClient;
  class_id: number;
  submission_id: number;
  grading_review_id: number;
  comments: (FeedbackComment | FeedbackLineComment | FeedbackArtifactComment)[];
  scope: Sentry.Scope;
}) {
  const profileMap = new Map<string, string>();
  for (const comment of comments) {
    if (comment.author) {
      if (!profileMap.has(comment.author.name)) {
        //Check to see if there is a profile with this name in the class
        const { data: profile, error: profileError } = await adminSupabase
          .from("profiles")
          .select("id")
          .eq("name", comment.author.name)
          .eq("class_id", class_id)
          .maybeSingle();
        if (profileError) {
          console.error(profileError);
          Sentry.captureException(profileError, scope);
          throw new UserVisibleError(
            `Failed to find profile for comment: ${comment.author.name}, ${profileError.message}`,
            400
          );
        }
        if (profile) {
          profileMap.set(comment.author.name, profile.id);
        } else {
          //Create a new profile
          const { data: newProfile, error: newProfileError } = await adminSupabase
            .from("profiles")
            .insert({
              name: comment.author.name,
              class_id,
              avatar_url: comment.author.avatar_url,
              flair: comment.author.flair,
              flair_color: comment.author.flair_color,
              is_private_profile: true
            })
            .select("id")
            .single();
          if (newProfile) {
            profileMap.set(comment.author.name, newProfile.id);
          } else {
            console.error(newProfileError);
            Sentry.captureException(newProfileError, scope);
            throw new UserVisibleError(
              `Failed to create profile for comment: ${comment.author.name}, ${newProfileError.message}`
            );
          }
        }
      }
    }
  }
  const submissionLineComments = comments.filter((eachComment) => "line" in eachComment);
  if (submissionLineComments.length > 0) {
    const fileMap = new Map<string, string>();
    for (const comment of submissionLineComments) {
      if (comment.file_name) {
        if (!fileMap.has(comment.file_name)) {
          const { data: file, error: fileError } = await adminSupabase
            .from("submission_files")
            .select("id")
            .eq("name", comment.file_name)
            .eq("submission_id", submission_id)
            .maybeSingle();
          if (file) {
            fileMap.set(comment.file_name, file.id);
          } else {
            console.error(fileError);
            Sentry.captureException(fileError, scope);
            throw new UserVisibleError(`Submission file not found: ${comment.file_name}, ${fileError?.message}`);
          }
        }
      }
    }
    const { error: submissionFileCommentsError } = await adminSupabase.from("submission_file_comments").insert(
      submissionLineComments.map((eachComment) => ({
        submission_file_id: fileMap.get(eachComment.file_name),
        submission_id,
        comment: eachComment.message,
        line: eachComment.line,
        points: eachComment.points,
        rubric_check_id: eachComment.rubric_check_id,
        released: eachComment.released,
        eventually_visible: true,
        submission_review_id: grading_review_id,
        class_id,
        author: profileMap.get(eachComment.author.name)
      }))
    );
    if (submissionFileCommentsError) {
      console.error(submissionFileCommentsError);
      Sentry.captureException(submissionFileCommentsError, scope);
      throw new UserVisibleError(`Failed to insert submission file comments: ${submissionFileCommentsError.message}`);
    }
  }
  const submissionArtifactComments = comments.filter((eachComment) => "artifact_name" in eachComment);
  if (submissionArtifactComments.length > 0) {
    const artifactMap = new Map<string, string>();
    for (const comment of submissionArtifactComments) {
      if (comment.artifact_name) {
        if (!artifactMap.has(comment.artifact_name)) {
          const { data: artifact, error: artifactError } = await adminSupabase
            .from("submission_artifacts")
            .select("id")
            .eq("name", comment.artifact_name)
            .eq("submission_id", submission_id)
            .maybeSingle();
          if (artifact) {
            artifactMap.set(comment.artifact_name, artifact.id);
          } else {
            console.error(artifactError);
            Sentry.captureException(artifactError, scope);
            throw new UserVisibleError(
              `Submission artifact not found: ${comment.artifact_name}, ${artifactError?.message}`
            );
          }
        }
      }
    }
    const { error: submissionArtifactCommentsError } = await adminSupabase.from("submission_artifact_comments").insert(
      submissionArtifactComments.map((eachComment) => ({
        submission_artifact_id: artifactMap.get(eachComment.artifact_name),
        submission_id,
        comment: eachComment.message,
        class_id,
        points: eachComment.points,
        rubric_check_id: eachComment.rubric_check_id,
        author: profileMap.get(eachComment.author.name),
        released: eachComment.released,
        eventually_visible: true,
        submission_review_id: grading_review_id
      }))
    );
    if (submissionArtifactCommentsError) {
      console.error(submissionArtifactCommentsError);
      Sentry.captureException(submissionArtifactCommentsError, scope);
      throw new UserVisibleError(
        `Failed to insert submission artifact comments: ${submissionArtifactCommentsError.message}`
      );
    }
  }
  const submissionComments = comments.filter(
    (eachComment) => !("line" in eachComment) && !("artifact_name" in eachComment)
  );
  if (submissionComments.length > 0) {
    const { error: submissionCommentsError } = await adminSupabase.from("submission_comments").insert(
      submissionComments.map((eachComment) => ({
        submission_id,
        comment: eachComment.message,
        points: eachComment.points,
        rubric_check_id: eachComment.rubric_check_id,
        class_id,
        author: profileMap.get(eachComment.author.name),
        released: eachComment.released,
        eventually_visible: true,
        submission_review_id: grading_review_id
      }))
    );
    if (submissionCommentsError) {
      console.error(submissionCommentsError);
      Sentry.captureException(submissionCommentsError, scope);
      throw new UserVisibleError(`Failed to insert submission comments: ${submissionCommentsError.message}`);
    }
  }
}

async function resetExistingGraderResult({
  adminSupabase,
  grader_result_id,
  submission_id,
  autograder_regression_test_id,
  artifactNames,
  scope
}: {
  adminSupabase: SupabaseClient<Database>;
  grader_result_id: number;
  submission_id: number;
  autograder_regression_test_id?: number | null;
  artifactNames: string[];
  scope: Sentry.Scope;
}) {
  const { data: existingTests, error: existingTestsError } = await adminSupabase
    .from("grader_result_tests")
    .select("id")
    .eq("grader_result_id", grader_result_id);
  if (existingTestsError) {
    console.error(existingTestsError);
    Sentry.captureException(existingTestsError, scope);
    throw new UserVisibleError(
      `Internal error: Failed to load existing grader result tests: ${existingTestsError.message}`
    );
  }

  const existingTestIds = existingTests?.map((test) => test.id) ?? [];
  if (existingTestIds.length > 0) {
    const { error: deleteTestOutputsError } = await adminSupabase
      .from("grader_result_test_output")
      .delete()
      .in("grader_result_test_id", existingTestIds);
    if (deleteTestOutputsError) {
      console.error(deleteTestOutputsError);
      Sentry.captureException(deleteTestOutputsError, scope);
      throw new UserVisibleError(
        `Internal error: Failed to remove previous hidden test outputs: ${deleteTestOutputsError.message}`
      );
    }
  }

  const { error: deleteTestsError } = await adminSupabase
    .from("grader_result_tests")
    .delete()
    .eq("grader_result_id", grader_result_id);
  if (deleteTestsError) {
    console.error(deleteTestsError);
    Sentry.captureException(deleteTestsError, scope);
    throw new UserVisibleError(`Internal error: Failed to remove previous test results: ${deleteTestsError.message}`);
  }

  const { error: deleteOutputsError } = await adminSupabase
    .from("grader_result_output")
    .delete()
    .eq("grader_result_id", grader_result_id);
  if (deleteOutputsError) {
    console.error(deleteOutputsError);
    Sentry.captureException(deleteOutputsError, scope);
    throw new UserVisibleError(
      `Internal error: Failed to remove previous grader outputs: ${deleteOutputsError.message}`
    );
  }

  const { error: deleteWorkflowRunErrorsError } = await adminSupabase
    .from("workflow_run_error")
    .delete()
    .eq("submission_id", submission_id);
  if (deleteWorkflowRunErrorsError) {
    console.error(deleteWorkflowRunErrorsError);
    Sentry.captureException(deleteWorkflowRunErrorsError, scope);
    throw new UserVisibleError(
      `Internal error: Failed to remove previous workflow run errors: ${deleteWorkflowRunErrorsError.message}`
    );
  }

  if (submission_id && artifactNames.length > 0) {
    const artifactSelect = adminSupabase
      .from("submission_artifacts")
      .select("id")
      .eq("submission_id", submission_id)
      .in("name", artifactNames);
    const constrainedArtifactSelect =
      autograder_regression_test_id != null
        ? artifactSelect.eq("autograder_regression_test_id", autograder_regression_test_id)
        : artifactSelect.is("autograder_regression_test_id", null);

    const { data: existingArtifacts, error: existingArtifactsError } = await constrainedArtifactSelect;
    if (existingArtifactsError) {
      console.error(existingArtifactsError);
      Sentry.captureException(existingArtifactsError, scope);
      throw new UserVisibleError(
        `Internal error: Failed to load previous grader artifacts: ${existingArtifactsError.message}`
      );
    }

    const artifactIds = existingArtifacts?.map((artifact) => artifact.id) ?? [];
    if (artifactIds.length > 0) {
      const { error: deleteArtifactsError } = await adminSupabase
        .from("submission_artifacts")
        .delete()
        .in("id", artifactIds);
      if (deleteArtifactsError) {
        console.error(deleteArtifactsError);
        Sentry.captureException(deleteArtifactsError, scope);
        throw new UserVisibleError(
          `Internal error: Failed to remove previous grader artifacts: ${deleteArtifactsError.message}`
        );
      }
    }
  }
}

function isConflictError(response: { error: { code?: string; message?: string } | null }): boolean {
  return (
    !!response.error &&
    response.error.code === "23505" &&
    Boolean(response.error.message?.includes("grader_results_submission_id_key_uniq"))
  );
}
async function handleRequest(req: Request, scope: Sentry.Scope): Promise<GradeResponse> {
  scope?.setTag("function", "autograder-submit-feedback");
  const token = req.headers.get("Authorization");
  const requestBody = (await req.json()) as GradingScriptResult;
  const url = new URL(req.url);
  const autograder_regression_test_id = url.searchParams.get("autograder_regression_test_id")
    ? parseInt(url.searchParams.get("autograder_regression_test_id")!)
    : undefined;

  if (!token) {
    throw new UserVisibleError("No token provided", 400);
  }
  const decoded = await validateOIDCTokenOrAllowE2E(token);
  const isE2ERun = decoded.repository.startsWith(END_TO_END_REPO_PREFIX); //Don't write back to GitHub for E2E runs, just pull
  // Find the corresponding submission
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { repository, sha, run_id, run_attempt } = decoded;
  scope?.setTag("repository", repository);
  scope?.setTag("sha", sha);
  scope?.setTag("run_id", run_id);
  scope?.setTag("run_attempt", run_attempt);
  scope?.setTag("autograder_regression_test_id", autograder_regression_test_id?.toString() || "(null)");
  let class_id: number | null = null;
  let assignment_id: number | null = null;
  let submission_id: number | null = null;
  let profile_id: string | null = null;
  let assignment_group_id: number | null = null;
  let grading_review_id: number | null = null;
  let checkRun: RepositoryCheckRun | null = null;
  let isRegressionRerun = false;
  let rerunTargetSubmissionId: number | null = null;
  let autoPromoteResult = false;
  async function recordWorkflowRunError({ name, data, is_private }: { name: string; data: Json; is_private: boolean }) {
    if (!class_id) {
      throw new SecurityError(
        `Class ID not found for run_number: ${run_id}, run_attempt: ${run_attempt}, repository: ${repository}, sha: ${sha}`
      );
    }
    if (!repository_id) {
      //TODO: if you want to record errors for regression test runs, you need to pass in the repository_id somehow
      return;
    }
    const { error: workflowRunErrorError } = await adminSupabase.from("workflow_run_error").insert({
      run_number: Number.parseInt(run_id),
      run_attempt: Number.parseInt(run_attempt),
      class_id: class_id,
      autograder_regression_test_id: autograder_regression_test_id ?? null,
      submission_id: submission_id ?? null,
      repository_id: repository_id ?? null,
      name,
      data,
      is_private
    });
    if (workflowRunErrorError) {
      console.error(workflowRunErrorError);
      throw new Error(`Internal error: Failed to insert workflow run error: ${workflowRunErrorError.message}`);
    }
  }
  let repository_id: number | null = null;
  if (autograder_regression_test_id) {
    //It's a regression test run
    const { data: regressionTestRun } = await adminSupabase
      .from("autograder_regression_test")
      .select("*,autograder(assignments(id, class_id))")
      .eq("id", autograder_regression_test_id)
      .eq("autograder.grader_repo", repository)
      .single();
    if (!regressionTestRun) {
      throw new SecurityError(
        `Regression test run not found: ${autograder_regression_test_id}, grader repo: ${repository}`
      );
    }
    if (!regressionTestRun.autograder.assignments.class_id) {
      throw new UserVisibleError(
        `Regression test class ID not found: ${autograder_regression_test_id}, grader repo: ${repository}`,
        400
      );
    }
    class_id = regressionTestRun.autograder.assignments.class_id;
    assignment_id = regressionTestRun.autograder.assignments.id;
  } else {
    const { data: submission, error: submissionError } = await adminSupabase
      .from("submissions")
      .select("*, repository_check_runs!submissions_repository_check_run_id_fkey(*)")
      .eq("repository", repository)
      .eq("sha", sha)
      .eq("run_attempt", Number.parseInt(decoded.run_attempt))
      .eq("run_number", Number.parseInt(decoded.run_id))
      .maybeSingle();
    if (submissionError) {
      console.error(submissionError);
      Sentry.captureException(submissionError, scope);
      throw new UserVisibleError(`Internal error: Failed to load submission: ${submissionError.message}`);
    }
    if (!submission) {
      const { data: repositoryRow } = await adminSupabase
        .from("repositories")
        .select("id")
        .eq("repository", repository)
        .maybeSingle();
      if (!repositoryRow) {
        throw new SecurityError(`Repository not found: ${repository}`);
      }

      const { data: rerunCheckRun, error: rerunCheckRunError } = await adminSupabase
        .from("repository_check_runs")
        .select("*")
        .eq("repository_id", repositoryRow.id)
        .eq("sha", sha)
        .eq("is_regression_rerun", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (rerunCheckRunError) {
        console.error(rerunCheckRunError);
        Sentry.captureException(rerunCheckRunError, scope);
        throw new UserVisibleError(`Internal error: Failed to load rerun check run: ${rerunCheckRunError.message}`);
      }
      if (!rerunCheckRun?.target_submission_id) {
        throw new SecurityError(`Submission not found: ${repository} ${sha} ${decoded.run_id}`);
      }

      const { data: targetSubmission, error: targetSubmissionError } = await adminSupabase
        .from("submissions")
        .select("*")
        .eq("id", rerunCheckRun.target_submission_id)
        .maybeSingle();
      if (targetSubmissionError) {
        console.error(targetSubmissionError);
        Sentry.captureException(targetSubmissionError, scope);
        throw new UserVisibleError(
          `Internal error: Failed to load target submission: ${targetSubmissionError.message}`
        );
      }
      if (!targetSubmission) {
        throw new SecurityError(`Target submission not found: ${rerunCheckRun.target_submission_id}`);
      }

      isRegressionRerun = true;
      rerunTargetSubmissionId = rerunCheckRun.target_submission_id;
      autoPromoteResult = rerunCheckRun.auto_promote_result ?? false;
      scope?.setTag("is_regression_rerun", "true");
      scope?.setTag("rerun_target_submission_id", rerunTargetSubmissionId.toString());
      scope?.setTag("auto_promote_result", autoPromoteResult.toString());

      class_id = targetSubmission.class_id;
      submission_id = autoPromoteResult ? targetSubmission.id : null;
      profile_id = targetSubmission.profile_id;
      assignment_group_id = targetSubmission.assignment_group_id;
      grading_review_id = targetSubmission.grading_review_id;
      assignment_id = targetSubmission.assignment_id;
      checkRun = rerunCheckRun as RepositoryCheckRun;
      repository_id = targetSubmission.repository_id;
    } else {
      class_id = submission.class_id;
      submission_id = submission.id;
      profile_id = submission.profile_id;
      assignment_group_id = submission.assignment_group_id;
      grading_review_id = submission.grading_review_id;
      assignment_id = submission.assignment_id;
      checkRun = submission.repository_check_runs as RepositoryCheckRun;
      repository_id = submission.repository_id;
    }
  }
  scope?.setTag("class_id", class_id?.toString() || "(null)");
  scope?.setTag("assignment_id", assignment_id?.toString() || "(null)");
  scope?.setTag("submission_id", submission_id?.toString() || "(null)");
  scope?.setTag("profile_id", profile_id || "(null)");
  scope?.setTag("assignment_group_id", assignment_group_id?.toString() || "(null)");
  scope?.setTag("grading_review_id", grading_review_id?.toString() || "(null)");
  scope?.setTag("checkRun", checkRun ? JSON.stringify(checkRun) : "(null)");
  try {
    //Resolve the action SHA
    let action_sha: string | undefined = undefined;
    try {
      action_sha = await resolveRef(requestBody.action_repository, requestBody.action_ref);
    } catch (e) {
      console.error(e);
    }
    const score =
      requestBody.feedback.score ||
      requestBody.feedback.tests
        .filter((test) => !test.hide_until_released || autograder_regression_test_id)
        .reduce((acc, test) => acc + (test.score || 0), 0);
    const max_score =
      requestBody.feedback.max_score ||
      requestBody.feedback.tests.reduce((acc, test) => acc + (test.max_score || 0), 0);
    const rerunForSubmissionId = isRegressionRerun && !autoPromoteResult ? (rerunTargetSubmissionId ?? null) : null;
    const baseGraderResultPayload = {
      submission_id: submission_id ?? null,
      profile_id: profile_id ?? null,
      class_id: class_id!,
      assignment_group_id: assignment_group_id ?? null,
      ret_code: requestBody.ret_code ?? null,
      grader_sha: requestBody.grader_sha ?? null,
      score,
      max_score,
      lint_output: requestBody.feedback.lint.output ?? "",
      lint_output_format: requestBody.feedback.lint.output_format || "text",
      lint_passed: requestBody.feedback.lint.status === "pass",
      execution_time: requestBody.execution_time ?? null,
      autograder_regression_test: autograder_regression_test_id ?? null,
      grader_action_sha: action_sha ?? null,
      rerun_for_submission_id: rerunForSubmissionId
    } satisfies Omit<Database["public"]["Tables"]["grader_results"]["Insert"], "errors">;

    const graderResultPayload: Database["public"]["Tables"]["grader_results"]["Insert"] = {
      ...baseGraderResultPayload,
      errors: null
    };

    const insertResponse = await adminSupabase.from("grader_results").insert(graderResultPayload).select("id").single();

    let resultID = insertResponse.data;
    let reusedExistingResult = false;
    const allowStaleOverwrite = isRegressionRerun && autoPromoteResult;

    if (insertResponse.error) {
      if (isConflictError(insertResponse) && submission_id != null) {
        const { data: existingResult, error: existingResultError } = await adminSupabase
          .from("grader_results")
          .select("id, created_at")
          .eq("submission_id", submission_id)
          .single();
        if (existingResultError || !existingResult) {
          console.error(existingResultError);
          Sentry.captureException(existingResultError, scope);
          throw new UserVisibleError(
            `Internal error: Failed to reuse existing feedback record: ${existingResultError?.message}`
          );
        }

        const existingCreatedAt = new Date(existingResult.created_at ?? "").getTime();
        if (!Number.isFinite(existingCreatedAt)) {
          Sentry.captureException(new Error("Internal error: Existing grader result timestamp missing"), scope);
          throw new UserVisibleError("Internal error: Existing grader result timestamp missing");
        }

        if (!allowStaleOverwrite && Date.now() - existingCreatedAt > RESET_WINDOW_MS) {
          throw new SecurityError("Request to rewrite submission feedback is too old");
        }

        const { error: updateExistingError } = await adminSupabase
          .from("grader_results")
          .update({
            ...baseGraderResultPayload,
            errors: null
          })
          .eq("id", existingResult.id);
        if (updateExistingError) {
          console.error(updateExistingError);
          Sentry.captureException(updateExistingError, scope);
          throw new UserVisibleError(
            `Internal error: Failed to update existing feedback: ${updateExistingError.message}`
          );
        }
        resultID = { id: existingResult.id };
        reusedExistingResult = true;
      } else {
        console.error(insertResponse.error);
        Sentry.captureException(insertResponse.error, scope);
        throw new UserVisibleError(`Internal error: Failed to insert feedback: ${insertResponse.error.message}`);
      }
    }

    if (!resultID) {
      Sentry.captureException(new Error("Internal error: Missing grader result identifier after insert"), scope);
      throw new UserVisibleError("Internal error: Missing grader result identifier after insert");
    }

    let artifactUploadLinks: { name: string; token: string; path: string }[] = [];

    try {
      const artifactNames =
        requestBody.feedback.artifacts?.map((artifact) => artifact.name).filter((name): name is string => !!name) ?? [];
      if (reusedExistingResult && submission_id) {
        await resetExistingGraderResult({
          adminSupabase,
          grader_result_id: resultID.id,
          submission_id,
          autograder_regression_test_id,
          artifactNames,
          scope
        });
      }
      // Insert feedback for each visibility level
      for (const visibility of ["hidden", "visible", "after_due_date", "after_published"]) {
        //Insert output if it exists
        if (requestBody.feedback.output[visibility as OutputVisibility]) {
          const output = requestBody.feedback.output[visibility as OutputVisibility];
          if (output) {
            const { error: outputError } = await adminSupabase.from("grader_result_output").insert({
              class_id,
              student_id: profile_id,
              assignment_group_id,
              grader_result_id: resultID.id,
              visibility: visibility as OutputVisibility,
              format: output.output_format || "text",
              output: output.output
            });
            if (outputError) {
              Sentry.captureException(outputError, scope);
              console.error(outputError);
              throw new UserVisibleError(`Internal error: Failed to insert output: ${outputError.message}`);
            }
          }
        }
      }
      //Insert test results
      const { error: testResultsError, data: testResultIDs } = await adminSupabase
        .from("grader_result_tests")
        .insert(
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
            submission_id
          }))
        )
        .select("id");
      if (testResultsError) {
        Sentry.captureException(testResultsError, scope);
        throw new UserVisibleError(`Internal error: Failed to insert test results: ${testResultsError.message}`);
      }
      //Insert any hidden output
      const hiddenTestOutputs = requestBody.feedback.tests
        .map((eachTest, idx) => {
          return {
            grader_result_test_id: testResultIDs[idx].id,
            class_id,
            output: eachTest.hidden_output || "",
            output_format: eachTest.hidden_output_format || "text",
            extra_data: eachTest.hidden_extra_data
          };
        })
        .filter((eachTest) => eachTest.output.length > 0 || eachTest.extra_data != null);
      if (hiddenTestOutputs.length > 0) {
        const { error: hiddenTestOutputsError } = await adminSupabase
          .from("grader_result_test_output")
          .insert(hiddenTestOutputs);
        if (hiddenTestOutputsError) {
          console.error(hiddenTestOutputsError);
          Sentry.captureException(hiddenTestOutputsError, scope);
          throw new UserVisibleError(
            `Internal error: Failed to insert hidden test outputs: ${hiddenTestOutputsError.message}`
          );
        }
      }
      if (requestBody.feedback.artifacts && submission_id) {
        // Prepare artifact uploads
        const { error: artifactError, data: artifactIDs } = await adminSupabase
          .from("submission_artifacts")
          .insert(
            requestBody.feedback.artifacts.map((artifact) => ({
              class_id: class_id,
              profile_id: profile_id,
              assignment_group_id,
              submission_id: submission_id,
              autograder_regression_test_id,
              name: artifact.name,
              data: artifact.data as Json
            }))
          )
          .select("id");
        if (artifactError) {
          console.error(artifactError);
          Sentry.captureException(artifactError, scope);
          throw new UserVisibleError(`Internal error: Failed to insert artifact: ${artifactError.message}`);
        }

        artifactUploadLinks = await Promise.all(
          requestBody.feedback.artifacts.map(async (artifact, idx) => {
            //Insert to grader_result_artifacts
            const artifactID = artifactIDs[idx].id;
            const aritfactPath = `classes/${class_id}/profiles/${profile_id ? profile_id : assignment_group_id}/submissions/${submission_id}/${artifactID}`;
            const signedLink = await adminSupabase.storage
              .from("submission-artifacts")
              .createSignedUploadUrl(aritfactPath);
            if (!signedLink.data?.signedUrl) {
              console.error(signedLink.error);
              Sentry.captureException(signedLink.error, scope);
              throw new UserVisibleError(`Internal error: Failed to create signed URL for artifact: ${artifact.name}`);
            }
            return {
              name: artifact.name,
              token: signedLink.data?.token,
              path: aritfactPath
            };
          })
        );
      }

      if (submission_id && grading_review_id && requestBody.feedback.annotations) {
        //Insert any comments
        await insertComments({
          adminSupabase,
          class_id,
          submission_id,
          grading_review_id,
          comments: requestBody.feedback.annotations,
          scope
        });
      }

      //Insert any errors
      if (requestBody.errors && repository_id) {
        await adminSupabase.from("workflow_run_error").insert(
          requestBody.errors.map((error) => {
            return {
              class_id,
              submission_id,
              assignment_group_id,
              repository_id: repository_id,
              name: error.name,
              data: { type: "grader", data: error.data },
              is_private: error.is_private
            };
          })
        );
      }
    } catch (e) {
      console.error(e);
      if (submission_id) {
        const normalizedError: GraderResultErrors =
          e instanceof UserVisibleError
            ? { user_visible_message: e.details }
            : { error: JSON.parse(JSON.stringify(e)) };

        await adminSupabase.from("grader_results").update({ errors: normalizedError }).eq("id", resultID.id);
      }
      Sentry.captureException(e, scope);
      throw new UserVisibleError(`Internal error: Failed to insert feedback: ${(e as Error).message}`);
    }

    // Update the repository_check_runs status to completed (DB state only)
    if (submission_id && !isRegressionRerun && !isE2ERun) {
      if (checkRun) {
        const newStatus: CheckRunStatus = {
          ...(checkRun.status as CheckRunStatus),
          completed_at: new Date().toISOString()
        };
        await adminSupabase
          .from("repository_check_runs")
          .update({
            status: newStatus
          })
          .eq("id", checkRun.id);
      }
    }
    if (submission_id) {
      return {
        is_ok: true,
        message: `Submission ${submission_id} registered`,
        details_url: `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/assignments/${assignment_id}/submissions/${submission_id}`,
        artifacts: artifactUploadLinks,
        supabase_url: Deno.env.get("SUPABASE_URL") || "",
        supabase_anon_key: Deno.env.get("SUPABASE_ANON_KEY") || ""
      };
    } else {
      const detailsUrl = isRegressionRerun
        ? `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/manage/assignments/${assignment_id}/rerun-autograder`
        : `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/manage/assignments/${assignment_id}/autograder/regression-test-run/${resultID}`;
      const message = isRegressionRerun
        ? `Rerun result ${resultID.id} registered`
        : `Regression test run ${resultID.id} registered`;
      return {
        is_ok: true,
        message,
        details_url: detailsUrl,
        artifacts: artifactUploadLinks,
        supabase_url: Deno.env.get("SUPABASE_URL") || "",
        supabase_anon_key: Deno.env.get("SUPABASE_ANON_KEY") || ""
      };
    }
  } catch (err) {
    if (err instanceof UserVisibleError) {
      await recordWorkflowRunError({
        name: err.details,
        data: { type: "user_visible_error" },
        is_private: false
      });
    } else {
      if (err instanceof SecurityError) {
        await recordWorkflowRunError({
          name: err.message,
          data: { type: "security_error" },
          is_private: true
        });
      } else {
        if (err instanceof Error) {
          await recordWorkflowRunError({
            name: err.message,
            data: { error: JSON.parse(JSON.stringify(err)) },
            is_private: true
          });
        } else {
          await recordWorkflowRunError({
            name: "Internal error",
            data: { error: JSON.parse(JSON.stringify(err)) },
            is_private: true
          });
        }
      }
    }
    throw err;
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest, {
    recordUserVisibleErrors: false,
    recordSecurityErrors: false
  });
});
