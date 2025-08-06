import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { validateOIDCToken } from "../_shared/GitHubWrapper.ts";
import { UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-retrieve-autograder-regression-tests");
  const token = req.headers.get("Authorization");
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }
  const decoded = await validateOIDCToken(token);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  scope?.setTag("repository", decoded.repository);
  const { data, error } = await adminSupabase
    .from("autograder_regression_test_by_grader")
    .select("*")
    .eq("grader_repo", decoded.repository);
  if (error) {
    throw new UserVisibleError(`Error retrieving regression tests: ${error.message}`);
  }
  return { configs: data.map((d) => ({ id: d.id!, name: d.name, score: d.score })) };
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
