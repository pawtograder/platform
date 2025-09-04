import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { syncStaffTeam } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3/dist/module/index.js";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

//See also autograder-sync-student-team
async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-sync-staff-team");
  const secret = req.headers.get("x-edge-function-secret");
  if (secret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("course_id")!);
    scope?.setTag("course_id", course_id.toString());

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
    scope?.setTag("github_org", classData.github_org!);
    scope?.setTag("slug", classData.slug!);
    await syncStaffTeam(
      classData.github_org!,
      classData.slug!,
      async () => {
        const { data: staff, error: staffError } = await adminSupabase
          .from("user_roles")
          .select("github_org_confirmed, users(github_username)")
          .eq("class_id", course_id)
          .or("role.eq.instructor,role.eq.grader")
          .limit(1000);
        if (staffError) {
          console.error(staffError);
          throw new UserVisibleError("Error fetching staff");
        }
        return staff!
          .filter((s) => s.users.github_username && s.github_org_confirmed)
          .map((s) => s.users.github_username!);
      },
      scope
    );
  } else {
    const { course_id } = (await req.json()) as { course_id: number };
    scope?.setTag("course_id", course_id.toString());
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
    scope?.setTag("github_org", classData.github_org!);
    scope?.setTag("slug", classData.slug!);
    await syncStaffTeam(
      classData.github_org!,
      classData.slug!,
      async () => {
        const { data: staff, error: staffError } = await supabase
          .from("user_roles")
          .select("github_org_confirmed, users(github_username)")
          .eq("class_id", course_id)
          .or("role.eq.instructor,role.eq.grader")
          .eq("github_org_confirmed", true)
          .limit(1000);
        if (staffError) {
          console.error(staffError);
          throw new UserVisibleError("Error fetching staff");
        }
        return staff!
          .filter((s) => s.users.github_username && s.github_org_confirmed)
          .map((s) => s.users.github_username!);
      },
      scope
    );
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
