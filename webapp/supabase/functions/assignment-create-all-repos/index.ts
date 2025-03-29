import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AssignmentCreateAllReposRequest } from "../_shared/FunctionTypes.d.ts";
import {
  assertUserIsInstructor,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";

async function handleRequest(req: Request) {
  const { courseId, assignmentId } = await req
    .json() as AssignmentCreateAllReposRequest;
  await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  // Get the assignment from supabase
  const { data: assignment } = await adminSupabase.from("assignments")
    .select(
      "*, classes(slug,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))",
    ) // , classes(canvas_id), user_roles(user_id)')
    .eq("id", assignmentId)
    .lte("release_date", new Date().toISOString())
    .eq("class_id", courseId).single();
  if (!assignment) {
    throw new Error("Assignment not found");
  }
  // Select all existing repos for the assignment
  const { data: existingRepos } = await adminSupabase.from("repositories").select(
    "*",
  ).eq("assignment_id", assignmentId);
  // Find repos that need to be created
  const reposToCreate = assignment.classes!.user_roles.filter((userRole) =>
    userRole.users.github_username &&
    !existingRepos?.find((repo) => repo.profile_id === userRole.profiles!.id)
  );

  const createRepo = async (
    uid: string,
    name: string,
    github_username: string,
  ) => {
    const repoName =
      `${assignment.classes?.slug}-${assignment.slug}-${github_username}`;
    console.log(`Creating repo ${repoName} for ${name}`);
    if (!assignment.template_repo) {
      console.log(`No template repo for assignment ${assignment.id}`);
      return;
    }
    await github.createRepo(
      assignment.classes!.github_org!,
      repoName,
      assignment.template_repo,
      github_username,
    );
    const { error } = await adminSupabase.from("repositories").insert({
      profile_id: uid,
      assignment_id: assignmentId,
      repository: "autograder-dev/" + repoName,
      class_id: courseId,
    });
    if (error) {
      console.error(error);
    }
  };
  await Promise.all(
    reposToCreate.map(async (userRole) =>
      createRepo(
        userRole.profiles!.id,
        userRole.profiles!.name!,
        userRole.users!.github_username!,
      )
    ),
  );
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
