import { createEventHandler } from "https://esm.sh/@octokit/webhooks?dts";
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
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("SUPABASE_URL")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0
  });
}
const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";

type GitHubCommit = {
  message: string;
  id: string;
  author: {
    name: string;
    email: string;
  };
};
async function handlePushToStudentRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: any,
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
  console.log(`Received push for ${repoName}, message: ${payload.head_commit.message}`);
  const detailsUrl = `https://${Deno.env.get("APP_URL")}/course/${studentRepo.class_id}/assignments/${studentRepo.assignment_id}`;

  for (const commit of payload.commits) {
    console.log(`Adding check run for ${commit.id}`);
    const checkRunId = await createCheckRun(repoName, commit.id, detailsUrl);
    console.log(`Check run created: ${checkRunId}`);
    const { error: checkRunError } = await adminSupabase.from("repository_check_runs").insert({
      repository_id: studentRepo.id,
      check_run_id: checkRunId,
      class_id: studentRepo.class_id,
      assignment_group_id: studentRepo.assignment_group_id,
      commit_message: commit.message,
      sha: commit.id,
      profile_id: studentRepo.profile_id,
      status: {
        created_at: new Date().toISOString(),
        commit_author: commit.author.name,
        commit_date: commit.timestamp,
        created_by: "github push by " + payload.pusher.name
      }
    });
    if (checkRunError) {
      console.error(checkRunError);
      throw new Error(`Could not create repository_check_run`);
    }
  }
  if (payload.head_commit.message.includes("#submit")) {
    console.log(`Ref: ${payload.ref}`);
    //Create a submission for this commit
    await triggerWorkflow(repoName, payload.head_commit.id, "grade.yml");
  }
}
const PAWTOGRADER_YML_PATH = "pawtograder.yml";
async function handlePushToGraderSolution(
  adminSupabase: SupabaseClient<Database>,
  payload: any,
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
    const { error } = await adminSupabase.from("autograder_commits").insert(
      payload.commits.map((commit: GitHubCommit) => ({
        autograder_id: autograder.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: autograder.class_id,
        ref
      }))
    );
    if (error) {
      Sentry.captureException(error, scope);
      console.error(error);
      throw new Error("Failed to store autograder commits");
    }
  }
}

async function handlePushToTemplateRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: any,
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
    hash.update(file.content);
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
        Sentry.captureException(error, scope);
        throw new Error("Failed to update autograder workflow hash");
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
      Sentry.captureException(assignmentUpdateError, scope);
      throw new Error("Failed to update assignment");
    }
    //Store the commit for the template repo
    const { error } = await adminSupabase.from("assignment_handout_commits").insert(
      payload.commits.map((commit: GitHubCommit) => ({
        assignment_id: assignment.id,
        message: commit.message,
        sha: commit.id,
        author: commit.author.name,
        class_id: assignment.class_id
      }))
    );
    if (error) {
      Sentry.captureException(error, scope);
      throw new Error("Failed to store assignment handout commit");
    }
  }
}

function tagScopeWithGenericPayload(scope: Sentry.Scope, name: string, payload: any) {
  scope.setTag("webhook_handler", name);
  scope.setTag("action", payload.action);
  scope.setTag("repository", payload.repository?.full_name);
  scope.setTag("ref", payload.ref);
  scope.setTag("check_run_id", payload.check_run?.id?.toString() || "");
  scope.setTag("id", payload.id);
  scope.setTag("organization", payload.organization?.login || "");
}
eventHandler.on("push", async ({ name, payload }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, name, payload);
  try {
    if (name === "push") {
      const repoName = payload.repository.full_name;
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
      );
      //Is it a student repo?
      const { data: studentRepo, error: studentRepoError } = await adminSupabase
        .from("repositories")
        .select("*")
        .eq("repository", repoName)
        .maybeSingle();
      if (studentRepoError) {
        console.error(studentRepoError);
        Sentry.captureException(studentRepoError, scope);
        throw new Error("Error getting student repo");
      }
      if (studentRepo) {
        scope.setTag("student_repo", studentRepo.id.toString());
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
        Sentry.captureException(graderSolutionError, scope);
        throw new Error("Error getting grader solution");
      }
      if (graderSolution.length > 0) {
        scope.setTag("grader_solution", graderSolution[0].id.toString());
        await handlePushToGraderSolution(adminSupabase, payload, graderSolution, scope);
        return;
      }
      const { data: templateRepo, error: templateRepoError } = await adminSupabase
        .from("assignments")
        .select("*")
        .eq("template_repo", repoName);
      if (templateRepoError) {
        console.error(templateRepoError);
        throw new Error("Error getting template repo");
      }
      if (templateRepo.length > 0) {
        await handlePushToTemplateRepo(adminSupabase, payload, templateRepo, scope);
        return;
      }
    }
  } catch (err) {
    Sentry.captureException(err, scope);
    throw err;
  }
});
eventHandler.on("check_run", async ({ payload }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "check_run", payload);
  try {
    if (payload.action === "created") {
      scope?.setTag("check_run_created", "true");
    } else if (payload.action === "requested_action") {
      if (payload.requested_action?.identifier === "submit") {
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
          const status = checkRun.data?.status as CheckRunStatus;
          scope?.setTag("check_run_status", status.toString());
          if (!status.started_at) {
            await adminSupabase
              .from("repository_check_runs")
              .update({
                status: {
                  ...(status as CheckRunStatus),
                  started_at: new Date().toISOString()
                }
              })
              .eq("id", checkRun.data.id);
            await triggerWorkflow(payload.repository.full_name, payload.check_run.head_sha, "grade.yml");
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
eventHandler.on("membership", async ({ payload }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "membership", payload);

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process when a member is added to a team
    if (payload.action !== "added") {
      return;
    }

    // Extract team information - cast to any to access team property
    const teamSlug = (payload as any).team?.slug;
    const memberGithubUsername = payload.member?.login;

    if (!teamSlug || !memberGithubUsername) {
      Sentry.captureMessage("Missing team slug or member login, skipping", scope);
      return;
    }

    // Parse team slug to determine course and team type
    // Team naming convention: {courseSlug}-staff or {courseSlug}-students
    let courseSlug: string;
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

    scope?.setTag("course_slug", courseSlug);
    scope?.setTag("team_type", teamType);

    // Find the class by slug
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("slug", courseSlug)
      .single();

    if (classError) {
      Sentry.captureMessage(`Class not found for slug ${courseSlug}:`, scope);
      return;
    }

    const classId = classData.id;

    scope?.setTag("class_id", classId.toString());
    // Find the user by GitHub username
    const { data: userData, error: userError } = await adminSupabase
      .from("users")
      .select("user_id")
      .eq("github_username", memberGithubUsername)
      .single();

    if (userError || !userData) {
      Sentry.captureMessage(`User not found for GitHub username ${memberGithubUsername}:`, scope);
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
eventHandler.on("organization", async ({ payload }) => {
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "organization", payload);
  const payloadAny = payload as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  scope?.setTag("user_login", payloadAny.invitation?.login || payloadAny.membership?.user?.login || "");

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process member invitation events
    if (payload.action !== "member_invited") {
      return;
    }

    // Extract invitation information
    const invitedUserLogin = payloadAny.invitation?.login;

    if (!invitedUserLogin) {
      return;
    }

    // Extract organization from the payload
    const organizationName = payloadAny.organization?.login;

    if (!organizationName) {
      return;
    }

    // Find the user by GitHub username
    const result = await adminSupabase.from("users").select("user_id").eq("github_username", invitedUserLogin).single();

    const userData = result.data;
    const userError = result.error;

    if (userError || !userData) {
      if (organizationName === "pawtograder-playground") {
        return; // Don't bother logging this - we intentionally share this org across instances.
      }
      if (userError) {
        Sentry.captureException(userError, scope);
      }
      Sentry.captureMessage(`User not found for GitHub username ${invitedUserLogin}:`, scope);
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

// Handle workflow_run events (requested, in_progress, completed, cancelled)
eventHandler.on("workflow_run", async ({ id: _id, name: _name, payload: payloadBroken }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = payloadBroken as any;
  const scope = new Sentry.Scope();
  tagScopeWithGenericPayload(scope, "workflow_run", payload);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    const workflowRun = payload.workflow_run;
    const repository = payload.repository;

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
        Sentry.captureMessage(`Unknown workflow_run action: ${payload.action}, skipping`, scope);
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
      workflowRun.pull_requests?.map((pr: any) => ({
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

    // Insert workflow event into database
    const { error: insertError } = await adminSupabase.from("workflow_events").insert({
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
      payload: payload
    });

    if (insertError) {
      Sentry.captureException(insertError, scope);
      throw new Error("Failed to store workflow event");
    }

    scope?.setTag("workflow_event_logged", "true");
  } catch (error) {
    Sentry.captureException(error, scope);
    // Don't throw here to avoid breaking the webhook processing
  }
});
// Handle team membership changes (when users are added to GitHub teams)
eventHandler.on("membership", async ({ payload }) => {
  console.log(
    `Received membership event: ${payload.action} for team: ${(payload as any).team?.slug}, member: ${payload.member?.login}`
  );

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process when a member is added to a team
    if (payload.action !== "added") {
      console.log(`Skipping membership action: ${payload.action}`);
      return;
    }

    // Extract team information - cast to any to access team property
    const teamSlug = (payload as any).team?.slug;
    const memberGithubUsername = payload.member?.login;

    if (!teamSlug || !memberGithubUsername) {
      console.log("Missing team slug or member login, skipping");
      return;
    }

    // Parse team slug to determine course and team type
    // Team naming convention: {courseSlug}-staff or {courseSlug}-students
    let courseSlug: string;
    let teamType: "staff" | "student";

    if (teamSlug.endsWith("-staff")) {
      courseSlug = teamSlug.slice(0, -6); // Remove '-staff'
      teamType = "staff";
    } else if (teamSlug.endsWith("-students")) {
      courseSlug = teamSlug.slice(0, -9); // Remove '-students'
      teamType = "student";
    } else {
      console.log(`Team slug ${teamSlug} doesn't match expected pattern, skipping`);
      return;
    }

    console.log(`Parsed team: courseSlug=${courseSlug}, teamType=${teamType}`);

    // Find the class by slug
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("slug", courseSlug)
      .single();

    if (classError || !classData) {
      console.log(`Class not found for slug ${courseSlug}:`, classError);
      return;
    }

    const classId = classData.id;

    // Find the user by GitHub username
    const { data: userData, error: userError } = await adminSupabase
      .from("users")
      .select("user_id")
      .eq("github_username", memberGithubUsername)
      .single();

    if (userError || !userData) {
      console.log(`User not found for GitHub username ${memberGithubUsername}:`, userError);
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
      console.log(`User role not found for user ${userId} in class ${classId}:`, userRoleError);
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
        console.error(`Failed to update github_org_confirmed for user role ${userRoleData.id}:`, updateError);
      } else {
        console.log(
          `Successfully confirmed GitHub team membership for user ${memberGithubUsername} (${userRole}) in team ${teamSlug}`
        );
      }
    } else {
      console.log(`Team type ${teamType} does not match user role ${userRole}, not updating confirmation`);
    }
  } catch (error) {
    console.error("Error processing membership event:", error);
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
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    const { error: repoError } = await adminSupabase.from("webhook_process_status").insert({
      webhook_id: id,
      completed: false
    });
    if (repoError) {
      if (repoError.code === "23505") {
        console.log(`Ignoring duplicate webhook id ${id}`);
        return Response.json(
          {
            message: "Duplicate webhook received"
          },
          {
            status: 200
          }
        );
      }
      Sentry.captureException(repoError, scope);
      console.error(repoError);
      return Response.json(
        {
          message: "Error processing webhook"
        },
        {
          status: 500
        }
      );
    }
    try {
      await eventHandler.receive({
        id: id || "",
        name: eventName as "push" | "check_run" | "workflow_run" | "workflow_job" | "membership" | "organization",
        payload: body.detail
      });
      await adminSupabase
        .from("webhook_process_status")
        .update({
          completed: true
        })
        .eq("webhook_id", id);
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
