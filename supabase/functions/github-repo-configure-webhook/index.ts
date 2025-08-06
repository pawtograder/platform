/**
 * TODO: Get rid of this: refactor it so that we don't manually create webhooks and just use the app-levelhook that gets delivered.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getFileFromRepo, updateAutograderWorkflowHash } from "../_shared/GitHubWrapper.ts";
import { UserVisibleError, SecurityError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { parse } from "jsr:@std/yaml";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import * as Sentry from "npm:@sentry/deno";
type RequestBody = {
  new_repo: string;
  assignment_id: number;
  watch_type: "grader_solution" | "template_repo";
};
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, new_repo, watch_type }: RequestBody = await req.json();
  scope?.setTag("function", "github-repo-configure-webhook");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("new_repo", new_repo);
  scope?.setTag("watch_type", watch_type);
  //Validate that the user is an instructor
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  const token = req.headers.get("Authorization")!.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error) {
    console.error(error);
  }
  if (!user) {
    throw new SecurityError("User not found");
  }

  // Fetch from supabase
  const { data: autograder, error: autograder_error } = await supabase
    .from("autograder")
    .select("*,assignments(*)")
    .eq("id", assignment_id)
    .single();
  if (autograder_error) {
    console.error(autograder_error);
    throw new UserVisibleError("Autograder not found");
  }
  //Make sure that we are an instructor in this class
  const { data: roles } = await supabase
    .from("user_roles")
    .select("*")
    .eq("role", "instructor")
    .eq("class_id", autograder.assignments.class_id!)
    .eq("user_id", user.id)
    .single();
  if (!roles) {
    throw new SecurityError("Unauthorized");
  }
  if (watch_type === "template_repo") {
    try {
      await updateAutograderWorkflowHash(new_repo);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.message.includes("Not Found")) {
        return {
          message: "Repository not found"
        };
      } else {
        throw e;
      }
    }
  } else if (watch_type === "grader_solution") {
    // Pull the autograder config from the repo, store to supabase
    console.log("Getting autograder config from repo", new_repo);
    const graderConfig = await getFileFromRepo(new_repo, "pawtograder.yml");
    const asObj = (await parse(graderConfig.content)) as Json;
    const { error } = await supabase
      .from("autograder")
      .update({
        config: asObj
      })
      .eq("id", autograder.id)
      .single();
    if (error) {
      return {
        message: "Error updating autograder config"
      };
    }
  } else {
    return {
      message: "Webhook already configured"
    };
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
