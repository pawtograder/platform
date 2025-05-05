import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { syncStaffTeam } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";

async function handleRequest(req: Request) {
  const { course_id } = (await req.json()) as { course_id: number };
  const { supabase } = await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
  //Find all staff in the course
  const { data: staff, error: staffError } = await supabase
    .from("user_roles")
    .select("users(github_username), classes(slug, github_org)")
    .eq("class_id", course_id)
    .or("role.eq.instructor,role.eq.grader");
  console.log(staff);
  if (staffError) {
    throw new UserVisibleError("Error fetching staff");
  }
  if (!staff) {
    throw new UserVisibleError("No staff found for course");
  }
  await syncStaffTeam(
    staff[0].classes.github_org!,
    staff[0].classes.slug!,
    staff.map((s) => s.users.github_username!)
  );
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
