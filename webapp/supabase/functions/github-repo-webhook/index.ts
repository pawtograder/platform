// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import { createEventHandler, WebhookPayload } from "https://esm.sh/@octokit/webhooks?dts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getFileFromRepo } from "../_shared/GitHubController.ts";
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

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/github-repo-webhook' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
