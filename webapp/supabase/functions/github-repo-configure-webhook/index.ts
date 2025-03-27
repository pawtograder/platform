// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { addPushWebhook } from "../_shared/GitHubController.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
type RequestBody = {
  new_repo: string;
  assignment_id: number;
  watch_type: "grader_solution" | "template_repo";
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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
    return new Response(
      JSON.stringify({
        message: "Autograder not found",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  //Make sure that we are an instructor in this class
  const { data: roles } = await supabase.from("user_roles").select("*").eq(
    "role",
    "instructor",
  ).eq("class_id", autograder.assignments.class_id).single();
  if (!roles) {
    return new Response(
      JSON.stringify({
        message: "Unauthorized",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  console.log(autograder?.grader_repo, new_repo);
  if (autograder?.grader_repo !== new_repo) {
    console.log("Adding webhook");
    await addPushWebhook(new_repo, watch_type);
    console.log(`Added webhook for ${new_repo}`);
    return new Response(
      JSON.stringify({
        message: "Webhook configured",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } else {
    return new Response(
      JSON.stringify({
        message: "Webhook already configured",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/github-repo-configure-webhook' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
