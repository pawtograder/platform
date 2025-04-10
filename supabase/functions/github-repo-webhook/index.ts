import { createEventHandler, WebhookPayload } from "https://esm.sh/@octokit/webhooks?dts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getFileFromRepo, updateAutograderWorkflowHash } from "../_shared/GitHubWrapper.ts";
import { parse } from "jsr:@std/yaml";
import { PawtograderConfig, GradedUnit, MutationTestUnit, RegularTestUnit } from "../_shared/PawtograderYml.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
const eventHandler = createEventHandler({
  secret: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "secret",
});

const GRADER_WORKFLOW_PATH = ".github/workflows/grade.yml";
async function auditWorkflowYml(payload: WebhookPayload) {
  const repoName = payload.repository.full_name;
  try {
    //Check to see if the grader workflow is changed by the commit
    const isModified = payload.head_commit.modified.includes(GRADER_WORKFLOW_PATH);
    const isRemoved = payload.head_commit.removed.includes(GRADER_WORKFLOW_PATH);
    const isAdded = payload.head_commit.added.includes(GRADER_WORKFLOW_PATH);
    if (isModified || isRemoved || isAdded) {
      console.log("Grader workflow changed");
      await updateAutograderWorkflowHash(repoName);
      console.log("Updated autograder workflow hash");
    }
  } catch (e) {
    console.log("error in handler");
    console.error(e);
  }
}
eventHandler.on("push", async ({ id, name, payload }) => {
  console.log(name, "event received: ", name);
  if (name === "push") {
    console.log(payload.repository.full_name);
    // console.log(payload)
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

const PAWTOGRADER_YML_PATH = "pawtograder.yml";
async function updatePawtograderYml(payload: WebhookPayload) {
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
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data, error } = await adminSupabase.from("autograder").select("*").eq("grader_repo", repoName);
    if (error) {
      console.error(error);
    }
    if (data) {
      console.log("Autograder config found");
      for (const assignment of data) {
        const { error: updateError } = await adminSupabase.from("assignments").update({
          autograder_points: totalAutograderPoints,
        }).eq("id", assignment.id);
        if (updateError) {
          console.error(updateError);
        }
      }
    }
    console.log("Updated pawtograder yml");
  }
}

Deno.serve(async (req) => {
  const isGraderSolution = req.url.endsWith("?type=grader_solution");
  const isHandout = req.url.endsWith("?type=template_repo");
  console.log(req.url);
  if (isGraderSolution) {
    await updatePawtograderYml(await req.json());
  } else if (isHandout) {
    await auditWorkflowYml(await req.json());
  }
  else {
    await eventHandler.receive({
      id: req.headers.get("x-github-delivery") || "",
      name: req.headers.get("x-github-event") as "push",
      payload: await req.json(),

    });
  }
  return Response.json({
    message: "Triggered webhook",
  });
});
