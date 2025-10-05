import { createEventHandler } from "https://esm.sh/@octokit/webhooks@13?dts";
import type {
  PushEvent,
  CheckRunEvent,
  MembershipEvent,
  OrganizationEvent,
  WorkflowRunEvent,
  PullRequestEvent
} from "https://esm.sh/@octokit/webhooks-types";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse } from "jsr:@std/yaml";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHash } from "node:crypto";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { createCheckRun, getFileFromRepo, triggerWorkflow, updateCheckRun } from "../_shared/GitHubWrapper.ts";
import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
const eventHandler = createEventHandler({
  secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret"
});

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("DENO_DEPLOYMENT_ID")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}
const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";

// Extend CheckRunStatus locally to track idempotent step markers without using 'any'
type ExtendedCheckRunStatus = CheckRunStatus & {
  check_run_created_at?: string;
  workflow_triggered_at?: string;
  check_run_marked_in_progress_at?: string;
};

// Fault injection helper for testing resiliency
function maybeCrash(tag: string) {
  const prob = parseFloat(Deno.env.get("WEBHOOK_FAULT_PROB") || "0");
  if (!(prob > 0)) return;
  const tags = (Deno.env.get("WEBHOOK_FAULT_TAGS") || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const enabled = tags.length === 0 || tags.includes(tag);
  if (enabled && Math.random() < prob) {
    console.error(`[FAULT] Injecting crash at ${tag}`);
    throw new Error(`Injected crash at ${tag}`);
  }
}

type GitHubCommit = PushEvent["commits"][number];
async function handlePushToStudentRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"],
  scope: Sentry.Scope
) {
  scope.setTag("webhook_handler", "push_to_student_repo");
  scope.setTag("repository", payload.repository.full_name);
  scope.setTag("assignment_id", studentRepo.assignment_id.toString());
  scope.setTag("class_id", studentRepo.class_id.toString());
  scope.setTag("commits_count", payload.commits.length.toString());

  //Get the repo name from the payload
  const repoName = payload.repository.full_name;
  if (payload.ref.includes("refs/tags/pawtograder-submit/")) {
    // If we make a #submit commit or otherwise create a submission, it will trigger creating the tag, so don't do anything on the tag push.
    return;
  }
  if (!payload.head_commit) {
    console.error("No head commit found in payload");
    scope.setTag("error_source", "no_head_commit");
    scope.setTag("error_context", "No head commit found in payload");
    Sentry.captureException(new Error("No head commit found in payload"), scope);
    return;
  }
  console.log(`Received push for ${repoName}, message: ${payload.head_commit.message}`);
  const detailsUrl = `https://${Deno.env.get("APP_URL")}/course/${studentRepo.class_id}/assignments/${studentRepo.assignment_id}`;

  for (const commit of payload.commits) {
    maybeCrash("push.student.for_each_commit.before_lookup");
    // Idempotency: if a row already exists for this repo+sha, do not create a new check run
    const { data: existing, error: existingErr } = await adminSupabase
      .from("repository_check_runs")
      .select("id, check_run_id, status")
      .eq("repository_id", studentRepo.id)
      .eq("sha", commit.id)
      .maybeSingle();
    if (existingErr) {
      console.error(existingErr);
      scope.setTag("error_source", "repository_check_run_lookup_failed");
      scope.setTag("error_context", "Error checking existing repository_check_runs");
      Sentry.captureException(existingErr, scope);
      throw existingErr;
    }

    if (existing && existing.id) {
      // If the record exists but lacks a check_run_id (partial prior failure), create and update it
      if (!existing.check_run_id) {
        console.log(`Completing partial check run setup for ${commit.id}`);
        maybeCrash("push.student.complete_partial.before_create_check_run");
        const { id: checkRunId } = await createCheckRun(repoName, commit.id, detailsUrl);
        const newStatus = {
          ...(existing.status as ExtendedCheckRunStatus),
          check_run_created_at: new Date().toISOString()
        } as ExtendedCheckRunStatus;
        const { error: updateErr } = await adminSupabase
          .from("repository_check_runs")
          .update({ check_run_id: checkRunId, status: newStatus as unknown as Json })
          .eq("id", existing.id);
        if (updateErr) {
          console.error(updateErr);
          scope.setTag("error_source", "repository_check_run_update_failed");
          scope.setTag("error_context", "Could not update repository_check_run with check_run_id");
          Sentry.captureException(updateErr, scope);
          throw updateErr;
        }
      }
      continue;
    }

    console.log(`Adding check run for ${commit.id}`);
    maybeCrash("push.student.before_create_check_run");
    const { id: checkRunId } = await createCheckRun(repoName, commit.id, detailsUrl);
    console.log(`Check run created: ${checkRunId}`);
    const status: ExtendedCheckRunStatus = {
      created_at: new Date().toISOString(),
      commit_author: commit.author.name,
      commit_date: commit.timestamp,
      created_by: "github push by " + payload.pusher.name,
      check_run_created_at: new Date().toISOString()
    };
    const { error: checkRunError } = await adminSupabase.from("repository_check_runs").insert({
      repository_id: studentRepo.id,
      check_run_id: checkRunId,
      class_id: studentRepo.class_id,
      assignment_group_id: studentRepo.assignment_group_id,
      commit_message: commit.message,
      sha: commit.id,
      profile_id: studentRepo.profile_id,
      status: status as unknown as Json
    });
    if (checkRunError) {
      console.error(checkRunError);
      scope.setTag("error_source", "repository_check_run_insert_failed");
      scope.setTag("error_context", "Could not create repository_check_run");
      Sentry.captureException(checkRunError, scope);
      throw checkRunError;
    }

    //Check that the workflow file has not been deleted in any commit
    const removedInCommit = commit.removed.includes(GRADER_WORKFLOW_PATH);
    if (removedInCommit) {
      // Fail the check run
      await updateCheckRun({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Submission failed",
          summary: "The autograder workflow file has been deleted",
          text: `Commit ${commit.id.substring(0, 7)} removed the file ${GRADER_WORKFLOW_PATH} from the repository. This file is essential for the operation of the autograder. Please add it back and try again.`
        }
      });
      return;
    }
  }
  if (payload.head_commit.message.includes("#submit")) {
    console.log(`Ref: ${payload.ref}`);
    //Create a submission for this commit
    // Find the head commit check run row to gate workflow triggering idempotently
    const { data: headRow, error: headRowErr } = await adminSupabase
      .from("repository_check_runs")
      .select("id, status")
      .eq("repository_id", studentRepo.id)
      .eq("sha", payload.head_commit.id)
      .maybeSingle();
    if (headRowErr) {
      console.error(headRowErr);
      scope.setTag("error_source", "repository_check_run_head_lookup_failed");
      scope.setTag("error_context", "Error getting head commit repository_check_run");
      Sentry.captureException(headRowErr, scope);
      throw headRowErr;
    }
    if (!headRow) {
      scope.setTag("error_source", "no_head_commit_repository_check_run");
      Sentry.captureException(new Error("No head commit repository_check_run found"), scope);
      return;
    }
    const currentStatus = (headRow?.status || {}) as ExtendedCheckRunStatus;
    if (!currentStatus.workflow_triggered_at) {
      maybeCrash("push.student.before_trigger_workflow");
      await triggerWorkflow(repoName, payload.head_commit.id, "grade.yml");
      const { error: statusUpdateErr } = await adminSupabase
        .from("repository_check_runs")
        .update({
          status: {
            ...(currentStatus as ExtendedCheckRunStatus),
            workflow_triggered_at: new Date().toISOString()
          } as unknown as Json
        })
        .eq("id", headRow.id);
      if (statusUpdateErr) {
        console.error(statusUpdateErr);
        scope.setTag("error_source", "repository_check_run_status_update_failed");
        scope.setTag("error_context", "Failed to set workflow_triggered_at");
        Sentry.captureException(statusUpdateErr, scope);
        throw statusUpdateErr;
      }
    }
  }
}
const PAWTOGRADER_YML_PATH = "pawtograder.yml";
async function handlePushToGraderSolution(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  autograders: Database["public"]["Tables"]["autograder"]["Row"][],
  scope: Sentry.Scope
) {
  tagScopeWithGenericPayload(scope, "push_to_grader_solution", payload);
  scope.setTag("autograders_count", autograders.length.toString());
  scope.setTag("is_main_branch", (payload.ref === "refs/heads/main").toString());

  const ref = payload.ref;
  const repoName = payload.repository.full_name;
  /*
  If we pushed to main, then update the autograder config and latest_autograder_sha
  */
  if (ref === "refs/heads/main") {
    if (!payload.head_commit) {
      console.error("No head commit found in payload");
      scope.setTag("error_source", "no_head_commit");
      scope.setTag("error_context", "No head commit found in payload");
      Sentry.captureException(new Error("No head commit found in payload"), scope);
      return;
    }
    const isModified = payload.head_commit.modified.includes(PAWTOGRADER_YML_PATH);
    const isRemoved = payload.head_commit.removed.includes(PAWTOGRADER_YML_PATH);
    const isAdded = payload.head_commit.added.includes(PAWTOGRADER_YML_PATH);
    scope?.setTag("is_modified", isModified.toString());
    scope?.setTag("is_removed", isRemoved.toString());
    scope?.setTag("is_added", isAdded.toString());
    if (isModified || isRemoved || isAdded) {
      console.log("Pawtograder yml changed");
      const file = await getFileFromRepo(repoName, PAWTOGRADER_YML_PATH);
      const parsedYml = parse(file.content) as PawtograderConfig;
      if (!parsedYml.gradedParts) {
        parsedYml.gradedParts = [];
      }
      const totalAutograderPoints = parsedYml.gradedParts.reduce(
        (acc, part) =>
          acc +
          part.gradedUnits.reduce(
            (unitAcc, unit) =>
              unitAcc +
              (isMutationTestUnit(unit)
                ? unit.breakPoints[0].pointsToAward
                : isRegularTestUnit(unit)
                  ? unit.points
                  : 0),
            0
          ),
        0
      );
      scope?.setTag("total_autograder_points", totalAutograderPoints.toString());
      for (const autograder of autograders) {
        const { error: updateError } = await adminSupabase
          .from("assignments")
          .update({
            autograder_points: totalAutograderPoints
          })
          .eq("id", autograder.id);
        if (updateError) {
          Sentry.captureException(updateError, scope);
          console.error(updateError);
        }
      }
      await Promise.all(
        autograders.map(async (autograder) => {
          const { error } = await adminSupabase
            .from("autograder")
            .update({
              config: parsedYml as unknown as Json
            })
            .eq("id", autograder.id)
            .single();
          if (error) {
            Sentry.captureException(error, scope);
            console.error(error);
          }
        })
      );
      scope?.setTag("updated_autograders_count", autograders.length.toString());
    }
    for (const autograder of autograders) {
      const { error } = await adminSupabase
        .from("autograder")
        .update({
          latest_autograder_sha: payload.commits[0].id
        })
        .eq("id", autograder.id)
        .single();
      if (error) {
        Sentry.captureException(error, scope);
        console.error(error);
      }
    }
  }
  /*
  Regardless of where we pushed, update the commit list
  */
  for (const autograder of autograders) {
    const { class_id } = autograder;
    if (class_id === null || class_id === undefined) {
      console.error("Autograder has no class_id");
      scope.setTag("error_source", "autograder_no_class_id");
      scope.setTag("error_context", "Autograder has no class_id");
      Sentry.captureException(new Error("Autograder has no class_id"), scope);
      continue;
    }
    const { error } = await adminSupabase.from("autograder_commits").upsert(
      payload.commits.map((commit: GitHubCommit) => ({
        autograder_id: autograder.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: class_id,
        ref
      })),
      { onConflict: "autograder_id,sha" }
    );
    if (error) {
      scope.setTag("error_source", "autograder_commits_insert_failed");
      scope.setTag("error_context", "Failed to store autograder commits");
      Sentry.captureException(error, scope);
      console.error(error);
      throw error;
    }
  }
}

async function handlePushToTemplateRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: PushEvent,
  assignments: Database["public"]["Tables"]["assignments"]["Row"][],
  scope: Sentry.Scope
) {
  tagScopeWithGenericPayload(scope, "push_to_template_repo", payload);
  scope?.setTag("assignments_count", assignments.length.toString());
  //Only process on the main branch
  if (payload.ref !== "refs/heads/main") {
    scope?.setTag("is_main_branch", "false");
    return;
  }
  scope?.setTag("is_main_branch", "true");
  if (!payload.head_commit) {
    console.error("No head commit found in payload");
    scope.setTag("error_source", "no_head_commit");
    scope.setTag("error_context", "No head commit found in payload");
    Sentry.captureException(new Error("No head commit found in payload"), scope);
    return;
  }
  //Check for modifications
  const isModified = payload.head_commit.modified.includes(GRADER_WORKFLOW_PATH);
  const isRemoved = payload.head_commit.removed.includes(GRADER_WORKFLOW_PATH);
  const isAdded = payload.head_commit.added.includes(GRADER_WORKFLOW_PATH);
  scope?.setTag("is_modified", isModified.toString());
  scope?.setTag("is_removed", isRemoved.toString());
  scope?.setTag("is_added", isAdded.toString());
  if (isModified || isRemoved || isAdded) {
    if (!assignments[0].template_repo) {
      Sentry.captureMessage("No matching assignment found", scope);
      return;
    }
    const file = (await getFileFromRepo(assignments[0].template_repo!, GRADER_WORKFLOW_PATH)) as { content: string };
    const hash = createHash("sha256");
    if (!file.content) {
      Sentry.captureMessage(`File ${GRADER_WORKFLOW_PATH} not found for ${assignments[0].template_repo}`, scope);
      return;
    }
    // Remove all whitespace (spaces, tabs, newlines, etc.) before hashing
    const contentWithoutWhitespace = file.content.replace(/\s+/g, "");
    hash.update(contentWithoutWhitespace);
    const hashStr = hash.digest("hex");
    scope?.setTag("new_autograder_workflow_hash", hashStr);
    for (const assignment of assignments) {
      const { error } = await adminSupabase
        .from("autograder")
        .update({
          workflow_sha: hashStr
        })
        .eq("id", assignment.id);
      if (error) {
        scope.setTag("error_source", "autograder_workflow_hash_update_failed");
        scope.setTag("error_context", "Failed to update autograder workflow hash");
        Sentry.captureException(error, scope);
        throw error;
      }
    }
  }
  for (const assignment of assignments) {
    const { error: assignmentUpdateError } = await adminSupabase
      .from("assignments")
      .update({
        latest_template_sha: payload.commits[0].id
      })
      .eq("id", assignment.id);
    if (assignmentUpdateError) {
      scope.setTag("error_source", "assignment_template_sha_update_failed");
      scope.setTag("error_context", "Failed to update assignment");
      Sentry.captureException(assignmentUpdateError, scope);
      throw assignmentUpdateError;
    }
    //Store the commit for the template repo
    const { error } = await adminSupabase.from("assignment_handout_commits").upsert(
      payload.commits.map((commit: GitHubCommit) => ({
        assignment_id: assignment.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: assignment.class_id
      })),
      { onConflict: "assignment_id,sha" }
    );
    if (error) {
      scope.setTag("error_source", "assignment_handout_commits_insert_failed");
      scope.setTag("error_context", "Failed to store assignment handout commit");
      Sentry.captureException(error, scope);
      throw error;
    }
  }
}

type KnownEventPayload =
  | PushEvent
  | CheckRunEvent
  | MembershipEvent
  | OrganizationEvent
  | WorkflowRunEvent
  | PullRequestEvent;
function tagScopeWithGenericPayload(scope: Sentry.Scope, name: string, payload: KnownEventPayload) {
  scope.setTag("webhook_handler", name);
  if ("action" in payload) {
    scope.setTag("action", (payload as { action?: string }).action || "");
  }
  // repository may not be present on some events (e.g., organization)
  if ("repository" in payload) {
    scope.setTag("repository", (payload as { repository?: { full_name?: string } }).repository?.full_name || "");
  }
  if ("ref" in payload) {
    scope.setTag("ref", (payload as { ref?: string }).ref || "");
  }
  if ("check_run" in payload) {
    const id = (payload as { check_run?: { id?: number } }).check_run?.id;
    scope.setTag("check_run_id", id ? String(id) : "");
  }
  if ("organization" in payload) {
    scope.setTag("organization", (payload as { organization?: { login?: string } }).organization?.login || "");
  }
}
eventHandler.on("push", async ({ name, payload }: { name: "push"; payload: PushEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, name, payload);
  try {
    if (name === "push") {
      const repoName = payload.repository.full_name;
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
      );
      console.log(`[PUSH] repo=${repoName}`);
      //Is it a student repo?
      const { data: studentRepo, error: studentRepoError } = await adminSupabase
        .from("repositories")
        .select("*")
        .eq("repository", repoName)
        .maybeSingle();
      if (studentRepoError) {
        console.error(studentRepoError);
        scope.setTag("error_source", "student_repo_lookup_failed");
        scope.setTag("error_context", "Error getting student repo");
        Sentry.captureException(studentRepoError, scope);
        throw studentRepoError;
      }
      if (studentRepo) {
        scope.setTag("student_repo", studentRepo.id.toString());
        maybeCrash("push.before_student_repo");
        await handlePushToStudentRepo(adminSupabase, payload, studentRepo, scope);
        return;
      }
      scope.setTag("repo_type", "grader_solution");
      const { data: graderSolution, error: graderSolutionError } = await adminSupabase
        .from("autograder")
        .select("*")
        .eq("grader_repo", repoName);
      if (graderSolutionError) {
        console.error(graderSolutionError);
        scope.setTag("error_source", "grader_solution_lookup_failed");
        scope.setTag("error_context", "Error getting grader solution");
        Sentry.captureException(graderSolutionError, scope);
        throw graderSolutionError;
      }
      if (graderSolution.length > 0) {
        scope.setTag("grader_solution", graderSolution[0].id.toString());
        maybeCrash("push.before_grader_solution");
        await handlePushToGraderSolution(adminSupabase, payload, graderSolution, scope);
        return;
      }
      const { data: templateRepo, error: templateRepoError } = await adminSupabase
        .from("assignments")
        .select("*")
        .eq("template_repo", repoName);
      if (templateRepoError) {
        console.error(templateRepoError);
        scope.setTag("error_source", "template_repo_lookup_failed");
        scope.setTag("error_context", "Error getting template repo");
        Sentry.captureException(templateRepoError, scope);
        throw templateRepoError;
      }
      if (templateRepo.length > 0) {
        maybeCrash("push.before_template_repo");
        await handlePushToTemplateRepo(adminSupabase, payload, templateRepo, scope);
        return;
      }
    }
  } catch (err) {
    Sentry.captureException(err, scope);
    throw err;
  }
});
eventHandler.on("check_run", async ({ payload }: { payload: CheckRunEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "check_run", payload);
  try {
    if (payload.action === "created") {
      scope?.setTag("check_run_created", "true");
    } else if (payload.action === "requested_action") {
      if (payload.requested_action?.identifier === "submit") {
        maybeCrash("check_run.before_db_lookup");
        const adminSupabase = createClient<Database>(
          Deno.env.get("SUPABASE_URL") || "",
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
        );
        const checkRun = await adminSupabase
          .from("repository_check_runs")
          .select("*")
          .eq("check_run_id", payload.check_run.id)
          .maybeSingle();
        if (checkRun && checkRun.data) {
          scope?.setTag("check_run_id", checkRun.data.id.toString());
          const status = (checkRun.data?.status as ExtendedCheckRunStatus) || ({} as ExtendedCheckRunStatus);
          scope?.setTag("check_run_status_started", (!!status.started_at).toString());

          // Step 1: mark started_at if missing
          if (!status.started_at) {
            console.log(`[CHECK_RUN] Marking started for check_run_id=${payload.check_run.id}`);
            maybeCrash("check_run.before_mark_started");
            const newStatus = {
              ...(status as ExtendedCheckRunStatus),
              started_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: newStatus as unknown as Json })
              .eq("id", checkRun.data.id);
          }

          // Step 2: trigger workflow once
          const startedStatus = (
            status.started_at ? status : { ...(status as ExtendedCheckRunStatus), started_at: new Date().toISOString() }
          ) as ExtendedCheckRunStatus;
          if (!startedStatus.workflow_triggered_at) {
            console.log(
              `[CHECK_RUN] Triggering workflow for repo=${payload.repository.full_name} sha=${payload.check_run.head_sha}`
            );
            maybeCrash("check_run.before_trigger_workflow");
            await triggerWorkflow(payload.repository.full_name, payload.check_run.head_sha, "grade.yml");
            const afterTrigger = {
              ...(startedStatus as ExtendedCheckRunStatus),
              workflow_triggered_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: afterTrigger as unknown as Json })
              .eq("id", checkRun.data.id);
          }

          // Step 3: mark check run in progress once
          const statusForCheckRun = (
            startedStatus.workflow_triggered_at
              ? startedStatus
              : { ...(startedStatus as ExtendedCheckRunStatus), workflow_triggered_at: new Date().toISOString() }
          ) as ExtendedCheckRunStatus;
          if (!statusForCheckRun.check_run_marked_in_progress_at) {
            console.log(`[CHECK_RUN] Marking GitHub check run in_progress id=${payload.check_run.id}`);
            maybeCrash("check_run.before_update_check_run_in_progress");
            await updateCheckRun({
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              check_run_id: payload.check_run.id,
              status: "in_progress",
              output: {
                title: "Grading in progress",
                summary: "Autograder is starting",
                text: "Details may be available in the 'Submit and Grade Assignment' action."
              },
              actions: []
            });
            const afterMark = {
              ...(statusForCheckRun as ExtendedCheckRunStatus),
              check_run_marked_in_progress_at: new Date().toISOString()
            } as ExtendedCheckRunStatus;
            await adminSupabase
              .from("repository_check_runs")
              .update({ status: afterMark as unknown as Json })
              .eq("id", checkRun.data.id);
          }
        } else {
          Sentry.captureMessage("Check run not found", scope);
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, scope);
    throw err;
  }
});
// Handle team membership changes (when users are added to GitHub teams)
eventHandler.on("membership", async ({ payload }: { payload: MembershipEvent }) => {
  // Extract team information early for e2e-ignore guard
  const teamSlug = (payload.team as { slug?: string })?.slug;
  const orgName = payload.organization?.login;

  // Parse team slug to determine course slug for e2e-ignore guard
  let courseSlug: string | undefined;
  if (teamSlug?.endsWith("-staff")) {
    courseSlug = teamSlug.slice(0, -6); // Remove '-staff'
  } else if (teamSlug?.endsWith("-students")) {
    courseSlug = teamSlug.slice(0, -9); // Remove '-students'
  }

  // e2e-ignore guard - execute before any console.log or metric calls
  if (orgName === "pawtograder-playground" && courseSlug?.startsWith("e2e-ignore-")) {
    return;
  }

  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "membership", payload);

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process when a member is added to a team
    if (payload.action !== "added") {
      return;
    }

    const memberGithubUsername = payload.member?.login;

    if (!teamSlug || !memberGithubUsername) {
      Sentry.captureMessage("Missing team slug or member login, skipping", scope);
      return;
    }

    // Parse team slug to determine course and team type
    // Team naming convention: {courseSlug}-staff or {courseSlug}-students
    let teamType: "staff" | "student";

    if (teamSlug.endsWith("-staff")) {
      courseSlug = teamSlug.slice(0, -6); // Remove '-staff'
      teamType = "staff";
    } else if (teamSlug.endsWith("-students")) {
      courseSlug = teamSlug.slice(0, -9); // Remove '-students'
      teamType = "student";
    } else {
      return;
    }

    scope?.setTag("org_name", orgName);
    scope?.setTag("course_slug", courseSlug);
    scope?.setTag("team_type", teamType);

    // Find the class by slug
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("slug", courseSlug)
      .eq("github_org", orgName)
      .single();

    if (classError) {
      if (orgName === "pawtograder-playground") {
        return; // Don't bother logging this - we intentionally share this org across instances.
      }
      Sentry.captureMessage(`Class not found for slug ${courseSlug}:`, scope);
      return;
    }

    const classId = classData.id;

    scope?.setTag("class_id", classId.toString());
    // Find the user by GitHub username
    const { data: userData, error: userError } = await adminSupabase
      .from("users")
      .select("user_id")
      .ilike("github_username", memberGithubUsername)
      .single();

    if (userError || !userData) {
      scope?.setTag("github_username", memberGithubUsername);
      if (userError) {
        Sentry.captureException(userError, scope);
      }
      Sentry.captureMessage(`User not found for GitHub username`, scope);
      return;
    }

    const userId = userData.user_id;

    // Find the user's role in this class
    const { data: userRoleData, error: userRoleError } = await adminSupabase
      .from("user_roles")
      .select("id, role")
      .eq("user_id", userId)
      .eq("class_id", classId)
      .single();

    if (userRoleError || !userRoleData) {
      Sentry.captureMessage(`User role not found for user ${userId} in class ${classId}:`, scope);
      return;
    }

    // Check if the team type matches the user's role
    const userRole = userRoleData.role;
    const isCorrectTeam =
      (teamType === "staff" && (userRole === "instructor" || userRole === "grader")) ||
      (teamType === "student" && userRole === "student");

    if (isCorrectTeam) {
      // Update github_org_confirmed to true
      const { error: updateError } = await adminSupabase
        .from("user_roles")
        .update({ github_org_confirmed: true })
        .eq("id", userRoleData.id);

      if (updateError) {
        Sentry.captureException(updateError, scope);
      } else {
        scope?.setTag("github_org_confirmed", "true");
      }
    } else {
      Sentry.captureMessage(
        `Team type ${teamType} does not match user role ${userRole}, not updating confirmation`,
        scope
      );
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    throw error;
  }
});

// Handle organization invitation events
eventHandler.on("organization", async ({ payload }: { payload: OrganizationEvent }) => {
  // Extract organization name early for e2e-ignore guard
  const organizationName = payload.organization?.login;

  // e2e-ignore guard - execute before any console.log or metric calls
  if (organizationName === "pawtograder-playground") {
    return;
  }

  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "organization", payload);
  if ("invitation" in payload) {
    scope?.setTag("user_login", payload.invitation?.login || "");
  } else if ("membership" in payload) {
    scope?.setTag("user_login", payload.membership?.user?.login || "");
  } else {
    Sentry.captureMessage("Neither invitation nor membership present", scope);
  }

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process member invitation events
    if (payload.action !== "member_invited") {
      return;
    }

    // Extract invitation information
    const invitedUserLogin = payload.invitation?.login;

    if (!invitedUserLogin) {
      return;
    }

    if (!organizationName) {
      return;
    }

    // Find the user by GitHub username
    const result = await adminSupabase
      .from("users")
      .select("user_id")
      .ilike("github_username", invitedUserLogin)
      .single();

    const userData = result.data;
    const userError = result.error;

    if (userError || !userData) {
      if (userError) {
        Sentry.captureException(userError, scope);
      }
      scope?.setTag("github_username", invitedUserLogin);
      Sentry.captureMessage(`User not found for GitHub username`, scope);
      return;
    }

    const userId = userData.user_id;
    scope?.setTag("user_id", userId.toString());

    // First, find classes that match this GitHub organization
    const { data: classesData, error: classesError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("github_org", organizationName);

    if (classesError) {
      Sentry.captureException(classesError, scope);
      return;
    }

    if (!classesData || classesData.length === 0) {
      Sentry.captureMessage(`No classes found for GitHub organization: ${organizationName}`, scope);
      return;
    }

    const classIds = classesData.map((c) => c.id);
    scope?.setTag("class_ids", classIds.join(", "));

    // Update user_roles only for classes that match this GitHub organization
    const { error: updateError } = await adminSupabase
      .from("user_roles")
      .update({ invitation_date: new Date().toISOString() })
      .eq("user_id", userId)
      .in("class_id", classIds);

    if (updateError) {
      Sentry.captureException(updateError, scope);
    } else {
      scope?.setTag("invitation_date_updated", "true");
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    throw error;
  }
});

async function handleWorkflowCompletionErrors(
  adminSupabase: SupabaseClient<Database>,
  workflowRun: WorkflowRunEvent["workflow_run"],
  repository: { full_name: string; owner: { login: string }; name: string },
  repositoryId: number,
  classId: number,
  scope: Sentry.Scope
) {
  scope.setTag("error_handler", "workflow_completion");
  scope.setTag("workflow_conclusion", workflowRun.conclusion);

  try {
    // First, look for submissions that match this specific workflow run
    const { data: submissions, error: submissionsError } = await adminSupabase
      .from("submissions")
      .select(
        "id, repository_check_run_id, run_number, run_attempt, sha, repository_id, repository_check_runs(check_run_id), profile_id, assignment_group_id, assignment_id"
      )
      .eq("repository_id", repositoryId)
      .eq("sha", workflowRun.head_sha)
      .eq("run_number", workflowRun.id)
      .eq("run_attempt", workflowRun.run_attempt);

    if (submissionsError) {
      Sentry.captureException(submissionsError, scope);
      return;
    }

    scope.setTag("submissions_found", (submissions || []).length.toString());

    if (submissions && submissions.length > 0) {
      // We have submissions for this workflow run - check if they have grader results
      for (const submission of submissions) {
        const { data: graderResult, error: graderResultError } = await adminSupabase
          .from("grader_results")
          .select("id")
          .eq("submission_id", submission.id)
          .maybeSingle();

        if (graderResultError) {
          Sentry.captureException(graderResultError, scope);
          continue;
        }

        const hasGraderResult = graderResult !== null;
        scope.setTag(`submission_${submission.id}_has_grader_result`, hasGraderResult.toString());

        if (!hasGraderResult) {
          const sentryMessage = "Workflow terminated without creating a grader result.";
          const userErrorMessage =
            "The grading container failed to terminate cleanly. This may indicate that the grading script ran out of memory or encountered an unexpected error. Please contact your instructor for assistance.";

          scope.setTag("error_type", "missing_grader_result");
          scope.setTag("workflow_run_id", workflowRun.id.toString());
          scope.setTag("submission_id", submission.id.toString());
          scope.setTag(
            "github_actions_run_url",
            `https://github.com/${repository.owner.login}/${repository.name}/actions/runs/${workflowRun.id}`
          );
          if (submission.repository_check_runs?.check_run_id) {
            scope.setTag("check_run_id", submission.repository_check_runs.check_run_id.toString());
          }

          // Create workflow_run_error record
          const { error: insertError } = await adminSupabase.from("workflow_run_error").upsert(
            {
              repository_id: repositoryId,
              class_id: classId,
              submission_id: submission.id,
              run_number: workflowRun.id,
              run_attempt: workflowRun.run_attempt,
              name: userErrorMessage,
              data: {
                workflow_run_id: workflowRun.id,
                workflow_conclusion: workflowRun.conclusion,
                workflow_status: workflowRun.status,
                check_run_id: submission.repository_check_runs?.check_run_id,
                repository_name: repository.full_name,
                sha: workflowRun.head_sha,
                error_type: "missing_grader_result",
                detected_at: new Date().toISOString(),
                technical_details: sentryMessage
              }
            },
            { onConflict: "repository_id,run_number,run_attempt,name" }
          );

          if (insertError) {
            Sentry.captureException(insertError, scope);
          } else {
            scope.setTag("workflow_run_error_created", "true");
          }

          // Update check run to failed if we have the check run ID
          if (submission.repository_check_runs?.check_run_id) {
            try {
              await updateCheckRun({
                owner: repository.owner.login,
                repo: repository.name,
                check_run_id: submission.repository_check_runs.check_run_id,
                status: "completed",
                conclusion: "failure",
                output: {
                  title: "Grading Failed",
                  summary: userErrorMessage,
                  text: "The autograder encountered an error during execution. This submission could not be graded automatically."
                },
                actions: []
              });
              scope.setTag("check_run_updated_to_failed", "true");
            } catch (checkRunError) {
              Sentry.captureException(checkRunError, scope);
            }
          }

          const graderResultError: Json = {
            error: userErrorMessage
          };

          // Insert a grader result with the error message
          const { error: insertGraderResultError } = await adminSupabase.from("grader_results").insert({
            submission_id: submission.id,
            errors: graderResultError,
            score: 0,
            ret_code: 137,
            lint_output: "",
            lint_output_format: "text",
            lint_passed: false,
            profile_id: submission.profile_id,
            assignment_group_id: submission.assignment_group_id,
            class_id: classId
          });
          if (insertGraderResultError) {
            Sentry.captureException(insertGraderResultError, scope);
          } else {
            scope.setTag("grader_result_created", "true");
          }

          // Log to Sentry
          Sentry.captureMessage(sentryMessage, scope);
        }
      }
    }
  } catch (error) {
    scope.setTag("error_handler_failed", "true");
    Sentry.captureException(error, scope);
  }
}

// Handle workflow_run events (requested, in_progress, completed, cancelled)
eventHandler.on("workflow_run", async ({ payload }: { payload: WorkflowRunEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "workflow_run", payload);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    const workflowRun = payload.workflow_run as WorkflowRunEvent["workflow_run"];
    const repository = payload.repository as WorkflowRunEvent["repository"];

    // Map GitHub workflow action to our event_type
    let eventType: string;
    switch (payload.action) {
      case "requested":
        eventType = "requested";
        break;
      case "in_progress":
        eventType = "in_progress";
        break;
      case "completed":
        eventType = "completed";
        break;
      default:
        Sentry.captureMessage(`Unknown workflow_run action, skipping`, scope);
        return;
    }

    // Try to match repository against repositories table
    const { data: matchedRepo, error: repoError } = await adminSupabase
      .from("repositories")
      .select("id, class_id")
      .eq("repository", repository.full_name)
      .maybeSingle();

    if (repoError) {
      Sentry.captureException(repoError, scope);
    }

    let repositoryId: number | null = null;
    let classId: number | null = null;

    if (matchedRepo) {
      repositoryId = matchedRepo.id;
      classId = matchedRepo.class_id;
      scope?.setTag("repository_id", repositoryId.toString());
      scope?.setTag("class_id", classId.toString());
    } else {
      // We don't capture events for handout or solution repos, do we need to?
      // Sentry.captureMessage(`No matching repository found for ${repository.full_name}`, scope);
    }

    // Extract pull request information if available
    const pullRequests =
      workflowRun.pull_requests?.map((pr: WorkflowRunEvent["workflow_run"]["pull_requests"][number]) => ({
        id: pr.id,
        number: pr.number,
        head: {
          ref: pr.head?.ref,
          sha: pr.head?.sha
        },
        base: {
          ref: pr.base?.ref,
          sha: pr.base?.sha
        }
      })) || [];

    // Upsert workflow event into database (dedupe by workflow_run_id, event_type, run_attempt)
    maybeCrash("workflow_run.before_upsert");
    const { error: insertError } = await adminSupabase.from("workflow_events").upsert(
      {
        workflow_run_id: workflowRun.id,
        repository_name: repository.full_name,
        github_repository_id: repository.id,
        repository_id: repositoryId,
        class_id: classId,
        workflow_name: workflowRun.name,
        workflow_path: workflowRun.path,
        event_type: eventType,
        status: workflowRun.status,
        conclusion: workflowRun.conclusion,
        head_sha: workflowRun.head_sha,
        head_branch: workflowRun.head_branch,
        run_number: workflowRun.run_number,
        run_attempt: workflowRun.run_attempt,
        actor_login: workflowRun.actor?.login,
        triggering_actor_login: workflowRun.triggering_actor?.login,
        started_at: workflowRun.run_started_at ? new Date(workflowRun.run_started_at).toISOString() : null,
        updated_at: workflowRun.updated_at ? new Date(workflowRun.updated_at).toISOString() : null,
        run_started_at: workflowRun.run_started_at ? new Date(workflowRun.run_started_at).toISOString() : null,
        run_updated_at: workflowRun.updated_at ? new Date(workflowRun.updated_at).toISOString() : null,
        pull_requests: pullRequests.length > 0 ? pullRequests : null,
        payload: payload as unknown as Json
      },
      { onConflict: "workflow_run_id,event_type,run_attempt" }
    );

    if (insertError) {
      scope.setTag("error_source", "workflow_events_insert_failed");
      scope.setTag("error_context", "Failed to store workflow event");
      Sentry.captureException(insertError, scope);
      throw insertError;
    }

    scope?.setTag("workflow_event_logged", "true");
    console.log(`[WORKFLOW_RUN] Logged ${eventType} for run=${workflowRun.id} attempt=${workflowRun.run_attempt}`);

    // Add error detection for completed workflows
    if (eventType === "completed" && repositoryId && classId) {
      maybeCrash("workflow_run.before_handle_completion_errors");
      await handleWorkflowCompletionErrors(adminSupabase, workflowRun, repository, repositoryId, classId, scope);
    }
  } catch (error) {
    Sentry.captureException(error, scope);
    // Don't throw here to avoid breaking the webhook processing
  }
});

// Handle pull_request events (to track when sync PRs are merged)
eventHandler.on("pull_request", async ({ payload }: { payload: PullRequestEvent }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "pull_request", payload);

  // Only handle "closed" events where the PR was merged
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return;
  }

  const branchName = payload.pull_request.head.ref;

  // Check if this is a sync PR (branch starts with "sync-to-")
  if (!branchName.startsWith("sync-to-")) {
    return;
  }

  scope.setTag("sync_pr_merged", "true");
  scope.setTag("branch", branchName);
  scope.setTag("pr_number", payload.pull_request.number.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    const repoFullName = payload.repository.full_name;

    // Find the repository in our database
    const { data: repo, error: repoError } = await adminSupabase
      .from("repositories")
      .select("id, synced_handout_sha, desired_handout_sha")
      .eq("repository", repoFullName)
      .maybeSingle();

    if (repoError) {
      Sentry.captureException(repoError, scope);
      return;
    }

    if (!repo) {
      // Not one of our tracked repositories
      return;
    }

    scope.setTag("repository_id", repo.id.toString());

    // Extract the SHA from the branch name (sync-to-abc1234 -> abc1234)
    const syncedSha = branchName.replace("sync-to-", "");
    const mergeSha = payload.pull_request.merge_commit_sha;

    scope.setTag("synced_sha", syncedSha);
    scope.setTag("merge_sha", mergeSha || "none");

    // Update the repository sync status
    const { error: updateError } = await adminSupabase
      .from("repositories")
      .update({
        synced_handout_sha: syncedSha,
        synced_repo_sha: mergeSha,
        sync_data: {
          pr_number: payload.pull_request.number,
          pr_url: payload.pull_request.html_url,
          pr_state: "merged",
          branch_name: branchName,
          last_sync_attempt: new Date().toISOString(),
          merge_sha: mergeSha,
          merged_by: payload.pull_request.merged_by?.login,
          merged_at: payload.pull_request.merged_at
        }
      })
      .eq("id", repo.id);

    if (updateError) {
      scope.setTag("error_source", "repository_update_failed");
      Sentry.captureException(updateError, scope);
      throw updateError;
    }

    Sentry.addBreadcrumb({
      message: `Updated repository ${repoFullName} after sync PR #${payload.pull_request.number} was merged`,
      level: "info"
    });

    console.log(
      `[PULL_REQUEST] Sync PR merged: ${repoFullName} PR#${payload.pull_request.number}, synced to ${syncedSha}`
    );
  } catch (error) {
    Sentry.captureException(error, scope);
    // Don't throw - allow webhook to complete
  }
});

// Type guard to check if a unit is a mutation test unit
export function isMutationTestUnit(unit: GradedUnit): unit is MutationTestUnit {
  return "locations" in unit && "breakPoints" in unit;
}

// Type guard to check if a unit is a regular test unit
export function isRegularTestUnit(unit: GradedUnit): unit is RegularTestUnit {
  return "tests" in unit && "testCount" in unit;
}

Deno.serve(async (req) => {
  console.log("[ENTRY] Received webhook request");
  if (req.headers.get("Authorization") !== Deno.env.get("EVENTBRIDGE_SECRET")) {
    return Response.json(
      {
        message: "Unauthorized"
      },
      {
        status: 401
      }
    );
  }

  const body = await req.json();
  const scope = new Sentry.Scope();
  scope.setContext("webhook", {
    body: JSON.stringify(body)
  });
  scope.setTag("webhook_id", body.id);
  scope.setTag("webhook_name", body["detail-type"]);
  scope.setTag("webhook_source", "github");
  if (body?.detail?.repository) {
    scope.setTag("repository", body.detail.repository.full_name);
    scope.setTag("repository_id", body.detail.repository.id?.toString());
  }
  if (body?.detail?.action) {
    scope.setTag("webhook_action", body.detail.action);
  }
  scope.addAttachment({ filename: "webhook.json", data: JSON.stringify(body) });
  const eventName = body["detail-type"];
  const id = body.id;
  console.log(`[ENTRY] id=${id} type=${eventName}`);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    maybeCrash("entry.before_status_upsert");
    // Read existing status row
    const existingResult = await adminSupabase
      .from("webhook_process_status")
      .select("id, completed, attempt_count")
      .eq("webhook_id", id)
      .maybeSingle();
    const existingError = existingResult.error;
    const existingRow = existingResult.data as { id: number; completed: boolean; attempt_count: number } | null;
    if (existingError) {
      Sentry.captureException(existingError, scope);
      console.error(existingError);
      return Response.json({ message: "Error processing webhook" }, { status: 500 });
    }

    let attemptCount = 1;
    if (!existingRow) {
      // First delivery
      const { error: insertErr } = await adminSupabase.from("webhook_process_status").insert({
        webhook_id: id,
        completed: false,
        attempt_count: 1,
        event_name: eventName,
        last_attempt_at: new Date().toISOString()
      } as unknown as never);
      if (insertErr) {
        // If unique violation due to race, re-read
        if ((insertErr as { code?: string }).code !== "23505") {
          Sentry.captureException(insertErr, scope);
          console.error(insertErr);
          return Response.json({ message: "Error processing webhook" }, { status: 500 });
        }
        const reread = await adminSupabase
          .from("webhook_process_status")
          .select("id, completed, attempt_count")
          .eq("webhook_id", id)
          .maybeSingle();
        if (reread.error) {
          Sentry.captureException(reread.error, scope);
          return Response.json({ message: "Error processing webhook" }, { status: 500 });
        }
        attemptCount = (reread.data?.attempt_count || 1) + 1;
        await adminSupabase
          .from("webhook_process_status")
          .update({ attempt_count: attemptCount, last_attempt_at: new Date().toISOString(), event_name: eventName })
          .eq("webhook_id", id);
      }
    } else {
      // Redelivery
      if (existingRow.completed) {
        if (existingRow.attempt_count >= 3) {
          scope.setTag("attempt_count", String(existingRow.attempt_count));
          Sentry.captureMessage("Webhook redelivered 3+ times after completion", scope);
        }
        console.log(`[ENTRY] Duplicate completed id=${id}`);
        return Response.json({ message: "Duplicate webhook received" }, { status: 200 });
      }
      attemptCount = (existingRow.attempt_count || 0) + 1;
      await adminSupabase
        .from("webhook_process_status")
        .update({ attempt_count: attemptCount, last_attempt_at: new Date().toISOString(), event_name: eventName })
        .eq("id", existingRow.id);
    }

    if (attemptCount >= 3) {
      scope.setTag("attempt_count", String(attemptCount));
      Sentry.captureMessage("Webhook redelivered 3+ times", scope);
    }

    try {
      console.log(`[DISPATCH] id=${id} type=${eventName} attempt=${attemptCount}`);
      maybeCrash("entry.before_dispatch");
      await eventHandler.receive({
        id: id || "",
        name: eventName as "push" | "check_run" | "workflow_run" | "workflow_job" | "membership" | "organization",
        payload: body.detail
      });
      maybeCrash("entry.after_dispatch_before_complete");
      await adminSupabase
        .from("webhook_process_status")
        .update({
          completed: true,
          last_error: null
        })
        .eq("webhook_id", id);
    } catch (err) {
      console.log(`Error processing webhook for ${eventName} id ${id}`);
      console.error(err);
      Sentry.captureException(err, scope);
      // Log transient error and leave completed=false for retry
      await adminSupabase
        .from("webhook_process_status")
        .update({ last_error: (err as Error)?.message || "unknown error", last_attempt_at: new Date().toISOString() })
        .eq("webhook_id", id);
      return Response.json(
        {
          message: "Error processing webhook"
        },
        {
          status: 500
        }
      );
    }
    console.log(`Completed processing webhook for ${eventName} id ${id}`);
  } catch (err) {
    console.log(`Error processing webhook for ${eventName} id ${id}`);
    console.error(err);
    Sentry.captureException(err, scope);
    return Response.json(
      {
        message: "Error processing webhook"
      },
      {
        status: 500
      }
    );
  }
  return Response.json({
    message: "Triggered webhook"
  });
});
