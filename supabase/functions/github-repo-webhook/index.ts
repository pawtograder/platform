import { createEventHandler, WebhookPayload } from "https://esm.sh/@octokit/webhooks?dts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse } from "jsr:@std/yaml";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHash } from "node:crypto";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { createCheckRun, getFileFromRepo, triggerWorkflow, updateCheckRun } from "../_shared/GitHubWrapper.ts";
import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
const eventHandler = createEventHandler({
  secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret",
});

const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";

async function handlePushToStudentRepo(adminSupabase: SupabaseClient<Database>, payload: WebhookPayload, studentRepo: Database["public"]["Tables"]["repositories"]["Row"]) {
  //Get the repo name from the payload
  const repoName = payload.repository.full_name;
  if (payload.ref.includes("refs/tags/pawtograder-submit/")) {
    // If we make a #submit commit or otherwise create a submission, it will trigger creating the tag, so don't do anything on the tag push.
    return;
  }
  console.log(`Received push for ${repoName}, message: ${payload.head_commit.message}`);
  const detailsUrl = `https://${Deno.env.get("APP_URL")}/course/${studentRepo.class_id}/assignments/${studentRepo.assignment_id}`;

  for (const commit of payload.commits) {
    const checkRunId = await createCheckRun(repoName, commit.id, detailsUrl);
    const { error: checkRunError } = await adminSupabase.from("repository_check_runs").insert({
      repository_id: studentRepo.id,
      check_run_id: checkRunId,
      class_id: studentRepo.class_id,
      assignment_group_id: studentRepo.assignment_group_id,
      commit_message: commit.message,
      sha: commit.id,
      status: {
        created_at: new Date().toISOString(),
        commit_author: commit.author.name,
        commit_date: commit.timestamp,
        created_by: "github push by " + payload.pusher.name,
      }
    })
    if (checkRunError) {
      console.error(checkRunError);
      throw new Error(`Could not create repository_check_run`)
    }
  }
  if (payload.head_commit.message.includes("#submit")) {
    console.log(`Ref: ${payload.ref}`);
    //Create a submission for this commit
    await triggerWorkflow(repoName, payload.head_commit.id, "grade.yml");
  }
}
const PAWTOGRADER_YML_PATH = "pawtograder.yml";
async function handlePushToGraderSolution(adminSupabase: SupabaseClient<Database>, payload: WebhookPayload, autograders: Database["public"]["Tables"]["autograder"]["Row"][]) {
  const repoName = payload.repository.full_name;
  const isModified = payload.head_commit.modified.includes(PAWTOGRADER_YML_PATH);
  const isRemoved = payload.head_commit.removed.includes(PAWTOGRADER_YML_PATH);
  const isAdded = payload.head_commit.added.includes(PAWTOGRADER_YML_PATH);
  if (isModified || isRemoved || isAdded) {
    console.log("Pawtograder yml changed");
    const file = await getFileFromRepo(repoName, PAWTOGRADER_YML_PATH);
    const parsedYml = parse(file.content) as PawtograderConfig;
    console.log(parsedYml);
    const totalAutograderPoints = parsedYml.gradedParts.reduce((acc, part) => acc + part.gradedUnits.reduce((unitAcc, unit) => unitAcc + (
      isMutationTestUnit(unit) ? unit.breakPoints[0].pointsToAward :
        isRegularTestUnit(unit) ? unit.points : 0

    ), 0), 0);
    console.log("Total autograder points", totalAutograderPoints);
    for (const autograder of autograders) {
      const { error: updateError } = await adminSupabase.from("assignments").update({
        autograder_points: totalAutograderPoints,
      }).eq("id", autograder.id);
      if (updateError) {
        console.error(updateError);
      }
    }
    console.log("Updated pawtograder yml");
  }
}
async function handlePushToTemplateRepo(adminSupabase: SupabaseClient<Database>, payload: WebhookPayload, assignments: Database["public"]["Tables"]["assignments"]["Row"][]) {
  //Check for modifications
  const isModified = payload.head_commit.modified.includes(GRADER_WORKFLOW_PATH);
  const isRemoved = payload.head_commit.removed.includes(GRADER_WORKFLOW_PATH);
  const isAdded = payload.head_commit.added.includes(GRADER_WORKFLOW_PATH);
  if (isModified || isRemoved || isAdded) {
    console.log("Grader workflow changed");
    console.log(assignments);
    if(!assignments[0].template_repo) {
      console.log("No matching assignment found");
      return;
    }
    const file = await getFileFromRepo(assignments[0].template_repo!, GRADER_WORKFLOW_PATH) as { content: string };
    const hash = createHash("sha256");
    if (!file.content) {
      throw new Error("File not found");
    }
    hash.update(file.content);
    const hashStr = hash.digest("hex");
    console.log(`New autograder workflow hash for ${assignments[0].template_repo}: ${hashStr}`);
    for (const assignment of assignments) {
      const { error } = await adminSupabase.from("autograder").update({
        workflow_sha: hashStr,
      }).eq("id", assignment.id);
      if (error) {
        console.error(error);
        throw new Error("Failed to update autograder workflow hash");
      }
    }
  }
}

eventHandler.on("push", async ({ id, name, payload }) => {
  if (name === "push") {
    const repoName = payload.repository.full_name;
    console.log(`Received push event for ${repoName}`);
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    //Is it a student repo?
    const { data: studentRepo, error: studentRepoError } = await adminSupabase.from("repositories").select("*").eq("repository", repoName).maybeSingle();
    if (studentRepoError) {
      console.error(studentRepoError);
      throw new Error("Error getting student repo");
    }
    if (studentRepo) {
      await handlePushToStudentRepo(adminSupabase, payload, studentRepo);
      return;
    }
    const { data: graderSolution, error: graderSolutionError } = await adminSupabase.from("autograder").select("*").eq("grader_repo", repoName);
    if (graderSolutionError) {
      console.error(graderSolutionError);
      throw new Error("Error getting grader solution");
    }
    if (graderSolution.length > 0) {
      await handlePushToGraderSolution(adminSupabase, payload, graderSolution);
      return;
    }
    const { data: templateRepo, error: templateRepoError } = await adminSupabase.from("assignments").select("*").eq("template_repo", repoName);
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
eventHandler.on("check_run", async ({ id, name, payload }) => {
  console.log(`Received check_run event for ${payload.repository.full_name}, action: ${payload.action}`);
  if (payload.action === "requested_action") {
    if (payload.requested_action?.identifier === "submit") {
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      );
      const checkRun = await adminSupabase.from("repository_check_runs").select("*").eq("check_run_id", payload.check_run.id).maybeSingle();
      if (checkRun && checkRun.data) {
        const status = checkRun.data?.status as CheckRunStatus;
        if (!status.started_at) {
          await adminSupabase.from("repository_check_runs").update({
            status: {
              ...(status as CheckRunStatus),
              started_at: new Date().toISOString(),
            },
          }).eq("id", checkRun.data.id);
          await triggerWorkflow(payload.repository.full_name, payload.check_run.head_sha, "grade.yml");
          await updateCheckRun({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            check_run_id: payload.check_run.id,
            status: "in_progress",
            output: {
              title: "Grading in progress",
              summary: "Autograder is starting",
              text: "Details may be available in the 'Submit and Grade Assignment' action.",
            },
            actions: []
          })
        }
      }
    }
  }
});

// Type guard to check if a unit is a mutation test unit
export function isMutationTestUnit(unit: GradedUnit): unit is MutationTestUnit {
  return 'locations' in unit && 'breakPoints' in unit
}

// Type guard to check if a unit is a regular test unit
export function isRegularTestUnit(unit: GradedUnit): unit is RegularTestUnit {
  return 'tests' in unit && 'testCount' in unit
}


Deno.serve(async (req) => {
  console.log(`Received webhook for ${req.headers.get("x-github-event")} delivery ${req.headers.get("x-github-delivery")}`);
  await eventHandler.receive({
    id: req.headers.get("x-github-delivery") || "",
    name: req.headers.get("x-github-event") as "push",
    payload: await req.json(),

  });
  return Response.json({
    message: "Triggered webhook",
  });
});
