// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  SecurityError,
  UserVisibleError,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
import { createRepo } from "../_shared/GitHubWrapper.ts";

async function handleRequest(req: Request) {
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! },
      },
    },
  );
  const { data: user } = await supabase.auth.getUser();
  if (!user) {
    throw new UserVisibleError("User not found");
  }
  console.log("Creating GitHub repos for student ", user.user!.email);
  // Get the user's Github username
  const { data: userData } = await supabase.from("user_roles").select(
    "users(github_username)",
  ).eq("user_id", user.user!.id).single();
  if (!userData) {
    throw new SecurityError(`Invalid user: ${user.user!.id}`);
  }
  const githubUsername = userData.users.github_username;
  if (!githubUsername) {
    throw new UserVisibleError(
      `User ${user.user!.id} has no Github username linked`,
    );
  }
  const { data: classes } = await supabase.from("user_roles").select(
    "class_id, profiles!private_profile_id(id, name, sortable_name, repositories(*))",
  ).eq(
    "user_id",
    user.user!.id,
  ).eq("role", "student");
  if (!classes) {
    throw new UserVisibleError("User is not a student");
  }
  const existingRepos = classes.flatMap((c) => c!.profiles!.repositories);
  //Find all assignments that the student is enrolled in that have been released
  const { data: assignments } = await supabase.from("assignments").select(
    "*, classes(slug, github_org)",
  ).in("class_id", classes!.map((c) => c!.class_id))
    .lte("release_date", new Date().toISOString());

  const requests = assignments!.filter((assignment) =>
    !existingRepos.find((repo) => repo.assignment_id === assignment.id)
  ).map(async (assignment) => {
    const userProfileID = classes.find((c) =>
      c && c.class_id === assignment.class_id
    )?.profiles.id;
    if (!userProfileID) {
      throw new UserVisibleError(
        `User profile ID not found for class ${assignment.class_id}`,
      );
    }
    if (!assignment.template_repo) {
      console.log(`No template repo for assignment ${assignment.id}`);
      return;
    }
    const repoName = `${
      assignment.classes!.slug
    }-${assignment.slug}-${githubUsername}`;
    const repo = await createRepo(
      assignment.classes!.github_org!,
      repoName,
      assignment.template_repo,
      githubUsername,
    );
    //Use service role key to insert the repo into the database
    const adminSupabase = createClient<Database>( 
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await adminSupabase.from("repositories").insert({
      profile_id: userProfileID,
      class_id: assignment.class_id!,
      assignment_id: assignment.id,
      repository: `${assignment.classes!.github_org}/${repoName}`,
    });
    if (error) {
      console.error(error);
    }
    return repo;
  });
  await Promise.all(requests);
  return {
    is_ok: true,
    message: `Repositories created for ${assignments!.length} assignments`,
  };
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
