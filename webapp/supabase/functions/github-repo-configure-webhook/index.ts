// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { addPushWebhook } from "../_shared/GitHubController.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";

type RequestBody = {
  new_repo: string;
  assignment_id: number;
  watch_type: "grader_solution" | "template_repo";
};
async function handleRequest(req: Request) {
  const { assignment_id, new_repo, watch_type }: RequestBody = await req.json();
  //Validate that the user is an instructor
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! },
      },
    },
  );
  // Fetch from supabase
  const { data: autograder, error: autograder_error } = await supabase.from(
    "autograder",
  ).select("*,assignments(*)").eq(
    "id",
    assignment_id,
  ).single();
  if (autograder_error) {
    return {
      message: "Autograder not found",
    };
  }
  //Make sure that we are an instructor in this class
  const { data: roles } = await supabase.from("user_roles").select("*").eq(
    "role",
    "instructor",
  ).eq("class_id", autograder.assignments.class_id).single();
  if (!roles) {
    return {
      message: "Unauthorized",
    };
  }
  console.log(autograder?.grader_repo, new_repo);
  if (autograder?.grader_repo !== new_repo) {
    console.log("Adding webhook");
    await addPushWebhook(new_repo, watch_type);
    console.log(`Added webhook for ${new_repo}`);
    return {
      message: "Webhook configured",
    };
  } else {
    return {
      message: "Webhook already configured",
    };
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
