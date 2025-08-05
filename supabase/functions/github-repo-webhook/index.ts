import { createEventHandler } from "https://esm.sh/@octokit/webhooks?dts";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse } from "jsr:@std/yaml";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHash } from "node:crypto";
import type { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { createCheckRun, getFileFromRepo, triggerWorkflow, updateCheckRun } from "../_shared/GitHubWrapper.ts";
import type { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
const eventHandler = createEventHandler({
  secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret"
});

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
  studentRepo: Database["public"]["Tables"]["repositories"]["Row"]
) {
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
  autograders: Database["public"]["Tables"]["autograder"]["Row"][]
) {
  const ref = payload.ref;
  const repoName = payload.repository.full_name;
  /*
  If we pushed to main, then update the autograder config and latest_autograder_sha
  */
  if (ref === "refs/heads/main") {
    const isModified = payload.head_commit.modified.includes(PAWTOGRADER_YML_PATH);
    const isRemoved = payload.head_commit.removed.includes(PAWTOGRADER_YML_PATH);
    const isAdded = payload.head_commit.added.includes(PAWTOGRADER_YML_PATH);
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
      console.log("Total autograder points", totalAutograderPoints);
      for (const autograder of autograders) {
        const { error: updateError } = await adminSupabase
          .from("assignments")
          .update({
            autograder_points: totalAutograderPoints
          })
          .eq("id", autograder.id);
        if (updateError) {
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
            console.error(error);
          }
        })
      );
      console.log("Updated pawtograder yml");
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
      console.error(error);
      throw new Error("Failed to store autograder commits");
    }
  }
}

async function handlePushToTemplateRepo(
  adminSupabase: SupabaseClient<Database>,
  payload: any,
  assignments: Database["public"]["Tables"]["assignments"]["Row"][]
) {
  //Only process on the main branch
  if (payload.ref !== "refs/heads/main") {
    console.log(`Skipping non-main push to ${payload.repository.full_name} on ${payload.ref}`);
    return;
  }
  //Check for modifications
  const isModified = payload.head_commit.modified.includes(GRADER_WORKFLOW_PATH);
  const isRemoved = payload.head_commit.removed.includes(GRADER_WORKFLOW_PATH);
  const isAdded = payload.head_commit.added.includes(GRADER_WORKFLOW_PATH);
  if (isModified || isRemoved || isAdded) {
    console.log("Grader workflow changed");
    console.log(assignments);
    if (!assignments[0].template_repo) {
      console.log("No matching assignment found");
      return;
    }
    const file = (await getFileFromRepo(assignments[0].template_repo!, GRADER_WORKFLOW_PATH)) as { content: string };
    const hash = createHash("sha256");
    if (!file.content) {
      throw new Error("File not found");
    }
    hash.update(file.content);
    const hashStr = hash.digest("hex");
    console.log(`New autograder workflow hash for ${assignments[0].template_repo}: ${hashStr}`);
    for (const assignment of assignments) {
      const { error } = await adminSupabase
        .from("autograder")
        .update({
          workflow_sha: hashStr
        })
        .eq("id", assignment.id);
      if (error) {
        console.error(error);
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
      console.error(assignmentUpdateError);
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
      console.error(error);
      throw new Error("Failed to store assignment handout commit");
    }
  }
}

eventHandler.on("push", async ({ name, payload }) => {
  if (name === "push") {
    const repoName = payload.repository.full_name;
    console.log(`Received push event for ${repoName}`);
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
      throw new Error("Error getting student repo");
    }
    if (studentRepo) {
      await handlePushToStudentRepo(adminSupabase, payload, studentRepo);
      return;
    }
    const { data: graderSolution, error: graderSolutionError } = await adminSupabase
      .from("autograder")
      .select("*")
      .eq("grader_repo", repoName);
    if (graderSolutionError) {
      console.error(graderSolutionError);
      throw new Error("Error getting grader solution");
    }
    if (graderSolution.length > 0) {
      await handlePushToGraderSolution(adminSupabase, payload, graderSolution);
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
      await handlePushToTemplateRepo(adminSupabase, payload, templateRepo);
      return;
    }
    console.log("TODO: Handle push to unknown repo");
    console.log(payload.repository.full_name);
  }
});
eventHandler.on("check_run", async ({ payload }) => {
  console.log(
    `Received check_run event for ${payload.repository.full_name}, action: ${payload.action}, check_run_id: ${payload.check_run.id}`
  );
  if (payload.action === "created") {
    console.log(`Check run created: ${payload.check_run.id}, check suite: ${payload.check_run.check_suite.id}`);
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
        const status = checkRun.data?.status as CheckRunStatus;
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
      }
    }
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

// Handle organization invitation events
eventHandler.on("organization", async ({ payload }) => {
  const payloadAny = payload as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  console.log(
    `Received organization event: ${payload.action} for user: ${payloadAny.invitation?.login || payloadAny.membership?.user?.login}`
  );

  try {
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only process member invitation events
    if (payload.action !== "member_invited") {
      console.log(`Skipping organization action: ${payload.action}`);
      return;
    }

    // Extract invitation information
    const invitedUserLogin = payloadAny.invitation?.login;

    if (!invitedUserLogin) {
      console.log("Missing invitation login, skipping");
      return;
    }

    // Extract organization from the payload
    const organizationName = payloadAny.organization?.login;

    if (!organizationName) {
      console.log("Missing organization name, skipping");
      return;
    }

    console.log(`Processing organization invitation for login: ${invitedUserLogin} in org: ${organizationName}`);

    // Find the user by GitHub username
    const result = await adminSupabase.from("users").select("user_id").eq("github_username", invitedUserLogin).single();

    const userData = result.data;
    const userError = result.error;

    if (userError || !userData) {
      console.log(`User not found for GitHub username ${invitedUserLogin}:`, userError);
      return;
    }

    const userId = userData.user_id;

    // First, find classes that match this GitHub organization
    const { data: classesData, error: classesError } = await adminSupabase
      .from("classes")
      .select("id")
      .eq("github_org", organizationName);

    if (classesError) {
      console.error(`Error finding classes for organization ${organizationName}:`, classesError);
      return;
    }

    if (!classesData || classesData.length === 0) {
      console.log(`No classes found for GitHub organization: ${organizationName}`);
      return;
    }

    const classIds = classesData.map((c) => c.id);
    console.log(`Found ${classIds.length} classes for organization ${organizationName}: ${classIds.join(", ")}`);

    // Update user_roles only for classes that match this GitHub organization
    const { error: updateError, count } = await adminSupabase
      .from("user_roles")
      .update({ invitation_date: new Date().toISOString() })
      .eq("user_id", userId)
      .in("class_id", classIds);

    if (updateError) {
      console.error(`Failed to update invitation_date for user ${userId}:`, updateError);
    } else {
      console.log(
        `Successfully updated invitation_date for ${count} user roles for user ${userId} (${invitedUserLogin}) in organization ${organizationName}`
      );
    }
  } catch (error) {
    console.error("Error processing organization invitation event:", error);
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
  console.log("Received webhook");
  const body = await req.json();
  console.log(JSON.stringify(body, null, 2));
  const eventName = body["detail-type"];
  const id = body.id;
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  console.log(`Received webhook for ${eventName} id ${id}`);
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
        name: eventName as "push" | "check_run",
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
