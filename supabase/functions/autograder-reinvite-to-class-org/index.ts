import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { reinviteToOrgTeam } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInCourse, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
async function handleRequest(req: Request) {
  const { course_id, user_id } = (await req.json()) as { course_id: number; user_id: string };
  const { supabase, enrollment } = await assertUserIsInCourse(course_id, req.headers.get("Authorization")!);
  if (enrollment?.user_id !== user_id && enrollment?.role !== "instructor" && enrollment?.role !== "grader") {
    throw new UserVisibleError("You are not authorized to resend an invitation for this user");
  }
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
  const { data: githubUsername, error: githubUsernameError } = await supabase
    .from("users")
    .select("github_username")
    .eq("user_id", user_id)
    .single();
  if (githubUsernameError) {
    console.log(githubUsernameError);
    throw new UserVisibleError("Error fetching github username");
  }
  if (!githubUsername) {
    throw new UserVisibleError("No github username found for user");
  }
  const intendedTeam = classData.slug + "-" + (enrollment?.role === "student" ? "students" : "staff");
  await reinviteToOrgTeam(classData.github_org!, intendedTeam, githubUsername.github_username!);
  return {
    is_ok: true,
    message: `Invited ${githubUsername.github_username} to ${intendedTeam}`
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
