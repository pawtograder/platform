// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { validateOIDCToken } from "../_shared/GitHubController.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
async function handleRequest(req: Request) {
  const token = req.headers.get("Authorization");
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }
  const decoded = await validateOIDCToken(token);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );
  const { data, error } = await supabase.from(
    "autograder_regression_test_by_grader",
  )
    .select("*").eq("grader_repo", decoded.repository);
  if (error) {
    throw new UserVisibleError(
      `Error retrieving regression tests: ${error.message}`,
    );
  }
  return { configs: data.map((d) => ({ id: d.id! })) };
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
