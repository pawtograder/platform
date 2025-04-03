import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { addPushWebhook, updateAutograderWorkflowHash } from "../_shared/GitHubWrapper.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

type RequestBody = {
  new_repo: string;
  assignment_id: number;
  watch_type: "grader_solution" | "template_repo";
};
async function handleRequest(req: Request) {
  const { assignment_id, new_repo, watch_type }: RequestBody = await req.json();
  //Validate that the user is an instructor
  const supabase = createClient<Database>(
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
  ).eq("class_id", autograder.assignments.class_id!).single();
  if (!roles) {
    return {
      message: "Unauthorized",
    };
  }
  if (watch_type === 'template_repo') {
    try {
      await updateAutograderWorkflowHash(new_repo);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.message.includes("Not Found")) {
        return {
          message: "Repository not found",
        };
      } else {
        throw e;
      }
    }
    try {
      await addPushWebhook(new_repo, watch_type);
    } catch (e) {
      if (e instanceof Error && e.message.includes("already exists")) {
      } else {
        throw e;
      }
    }
  }
  else if (autograder?.grader_repo !== new_repo) {
    try {
      await addPushWebhook(new_repo, watch_type);
    } catch (e) {
      if (e instanceof Error && e.message.includes("already exists")) {
      } else {
        throw e;
      }
    }
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
