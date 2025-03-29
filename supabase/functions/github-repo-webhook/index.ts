import { createEventHandler, WebhookPayload } from "https://esm.sh/@octokit/webhooks?dts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getFileFromRepo } from "../_shared/GitHubWrapper.ts";
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
    if(isModified || isRemoved || isAdded) {
      console.log("Grader workflow changed");
      const file = await getFileFromRepo(
        repoName,
        ".github/workflows/grade.yml",
      );
      console.log(file);
    } else {
      console.log("Grader workflow not changed, skipping");
    }
  } catch (e) {
    console.log("error in handler");
    console.error(e);
  }
}
eventHandler.on("push", async ({ id, name, payload }) => {
  console.log(name, "event received");
  if (name === "push") {
    payload.head_commit?.modified
    await auditWorkflowYml(payload);
  }
});

Deno.serve(async (req) => {
  console.log("Received request");

  await eventHandler.receive({
    id: req.headers.get("x-github-delivery") || "",
    name: req.headers.get("x-github-event") as "push",
    payload: await req.json(),
  });
  console.log("done");
  return Response.json({
    message: "Triggered webhook",
  });
});
