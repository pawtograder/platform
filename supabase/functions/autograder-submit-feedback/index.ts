import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
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
import { resolveRef, updateCheckRun, validateOIDCToken } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function insertComments({
  adminSupabase,
  class_id,
  submission_id,
  grading_review_id,
  comments
}: {
  adminSupabase: SupabaseClient;
  class_id: number;
  submission_id: number;
  grading_review_id: number;
  comments: (FeedbackComment | FeedbackLineComment | FeedbackArtifactComment)[];
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
          throw new UserVisibleError(
            `Failed to find profile for comment: ${comment.author.name}, ${profileError.message}`
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
      throw new UserVisibleError(`Failed to insert submission comments: ${submissionCommentsError.message}`);
    }
  }
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
    throw new UserVisibleError("No token provided");
  }
  const decoded = await validateOIDCToken(token);
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
      regression_test_id: autograder_regression_test_id ?? null,
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
        `Regression test class ID not found: ${autograder_regression_test_id}, grader repo: ${repository}`
      );
    }
    class_id = regressionTestRun.autograder.assignments.class_id;
    assignment_id = regressionTestRun.autograder.assignments.id;
  } else {
    const { data: submission } = await adminSupabase
      .from("submissions")
      .select("*, repository_check_runs(*)")
      .eq("repository", repository)
      .eq("sha", sha)
      .eq("run_attempt", Number.parseInt(decoded.run_attempt))
      .eq("run_number", Number.parseInt(decoded.run_id))
      .single();
    if (!submission) {
      throw new SecurityError(`Submission not found: ${repository} ${sha} ${decoded.run_id}`);
    }
    class_id = submission.class_id;
    submission_id = submission.id;
    profile_id = submission.profile_id;
    assignment_group_id = submission.assignment_group_id;
    grading_review_id = submission.grading_review_id;
    assignment_id = submission.assignment_id;
    checkRun = submission.repository_check_runs as RepositoryCheckRun;
    repository_id = submission.repository_id;
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
    const action_sha = await resolveRef(requestBody.action_repository, requestBody.action_ref);
    const score =
      requestBody.feedback.score ||
      requestBody.feedback.tests
        .filter((test) => !test.hide_until_released || autograder_regression_test_id)
        .reduce((acc, test) => acc + (test.score || 0), 0);
    const max_score =
      requestBody.feedback.max_score ||
      requestBody.feedback.tests.reduce((acc, test) => acc + (test.max_score || 0), 0);
    const { error, data: resultID } = await adminSupabase
      .from("grader_results")
      .insert({
        submission_id,
        profile_id,
        class_id,
        assignment_group_id,
        ret_code: requestBody.ret_code,
        grader_sha: requestBody.grader_sha,
        score,
        max_score,
        lint_output: requestBody.feedback.lint.output,
        lint_output_format: requestBody.feedback.lint.output_format || "text",
        lint_passed: requestBody.feedback.lint.status === "pass",
        execution_time: requestBody.execution_time,
        autograder_regression_test: autograder_regression_test_id,
        grader_action_sha: action_sha
      })
      .select("id")
      .single();
    if (error) {
      console.error(error);
      throw new UserVisibleError(`Internal error: Failed to insert feedback: ${error.message}`);
    }
    let artifactUploadLinks: { name: string; token: string; path: string }[] = [];

    try {
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
        throw new UserVisibleError(`Internal error: Failed to insert test results: ${testResultsError.message}`);
      }
      //Insert any hidden output
      const hiddenTestOutputs = requestBody.feedback.tests
        .map((eachTest, idx) => {
          return {
            grader_result_test_id: testResultIDs[idx].id,
            class_id,
            output: eachTest.hidden_output || "",
            output_format: eachTest.hidden_output_format || "text"
          };
        })
        .filter((eachTest) => eachTest.output.length > 0);
      if (hiddenTestOutputs.length > 0) {
        const { error: hiddenTestOutputsError } = await adminSupabase
          .from("grader_result_test_output")
          .insert(hiddenTestOutputs);
        if (hiddenTestOutputsError) {
          console.error(hiddenTestOutputsError);
          throw new UserVisibleError(
            `Internal error: Failed to insert hidden test outputs: ${hiddenTestOutputsError.message}`
          );
        }
      }
      if (requestBody.feedback.artifacts) {
        // Prepare artifact uploads
        const { error: artifactError, data: artifactIDs } = await adminSupabase
          .from("submission_artifacts")
          .insert(
            requestBody.feedback.artifacts.map((artifact) => ({
              class_id: class_id,
              profile_id: profile_id,
              assignment_group_id,
              submission_id: submission_id!,
              autograder_regression_test_id,
              name: artifact.name,
              data: artifact.data as any
            }))
          )
          .select("id");
        if (artifactError) {
          console.error(artifactError);
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
          comments: requestBody.feedback.annotations
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
        await adminSupabase
          .from("grader_results")
          .update({
            errors:
              e instanceof UserVisibleError
                ? { user_visible_message: e.details }
                : { error: JSON.parse(JSON.stringify(e)) }
          })
          .eq("id", resultID.id);
      }
      throw new UserVisibleError(`Internal error: Failed to insert feedback: ${(e as Error).message}`);
    }

    // Update the check run status to completed
    // await GitHubController.getInstance().completeCheckRun(submission, requestBody.feedback);
    if (submission_id) {
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
        details_url: `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/assignments/${assignment_id}/submissions/${submission_id}`,
        artifacts: artifactUploadLinks,
        supabase_url: Deno.env.get("SUPABASE_URL") || "",
        supabase_anon_key: Deno.env.get("SUPABASE_ANON_KEY") || ""
      };
    } else {
      return {
        is_ok: true,
        message: `Regression test run ${resultID} registered`,
        details_url: `${Deno.env.get("PAWTOGRADER_WEBAPP_URL")}/course/${class_id}/manage/assignments/${assignment_id}/autograder/regression-test-run/${resultID}`,
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
