import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3/dist/module/index.js";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { syncStudentTeam } from "../_shared/GitHubWrapper.ts";
import {
  assertUserIsInstructor,
  UserVisibleError,
  wrapRequestHandler,
  fetchAllPages
} from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

//See also autograder-sync-staff-team
async function handleRequest(req: Request) {
  const secret = req.headers.get("x-edge-function-secret");
  if (secret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("course_id")!);
    console.log("course_id", course_id);

    const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
    if (secret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Invalid secret" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("slug, github_org")
      .eq("id", course_id)
      .single();
    if (classError) {
      throw new UserVisibleError("Error fetching class");
    }
    if (!classData) {
      throw new UserVisibleError("No class found for course");
    }

    await syncStudentTeam(classData.github_org!, classData.slug!, async () => {
      const { data: students, error: studentsError } = await fetchAllPages<{
        users: { github_username: string | null };
      }>(
        adminSupabase
          .from("user_roles")
          .select("users(github_username)")
          .eq("class_id", course_id)
          .or("role.eq.student")
      );
      if (studentsError) {
        console.error(studentsError);
        throw new UserVisibleError("Error fetching students");
      }
      return students!.filter((s) => s.users.github_username).map((s) => s.users.github_username!);
    });
  } else {
    const { course_id } = (await req.json()) as { course_id: number };
    const { supabase } = await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
    const { data: classData, error: classError } = await supabase
      .from("classes")
      .select("slug, github_org")
      .eq("id", course_id)
      .single();
    if (classError) {
      throw new UserVisibleError("Error fetching class");
    }
    if (!classData) {
      throw new UserVisibleError("No class found for course");
    }
    await syncStudentTeam(classData.github_org!, classData.slug!, async () => {
      const { data: students, error: studentsError } = await fetchAllPages<{
        users: { github_username: string | null };
      }>(supabase.from("user_roles").select("users(github_username)").eq("class_id", course_id).or("role.eq.student"));
      if (studentsError) {
        console.error(studentsError);
        throw new UserVisibleError("Error fetching students");
      }
      return students!.filter((s) => s.users.github_username).map((s) => s.users.github_username!);
    });
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
