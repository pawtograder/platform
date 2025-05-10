import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRepo, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

async function handleRequest(req: Request) {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user) {
    throw new UserVisibleError("User not found");
  }
  console.log("Creating GitHub repos for student ", user.user!.email);
  // Get the user's Github username
  const { data: userData, error: userDataError } = await supabase
    .from("users")
    .select("github_username")
    .eq("user_id", user.user!.id)
    .single();
  if (userDataError) {
    console.error(userDataError);
    throw new SecurityError(`Invalid user: ${user.user!.id}`);
  }
  if (!userData) {
    throw new SecurityError(`Invalid user: ${user.user!.id}`);
  }
  const githubUsername = userData.github_username;
  if (!githubUsername) {
    throw new UserVisibleError(`User ${user.user!.id} has no Github username linked`);
  }

  const { data: classes, error: classesError } = await supabase
    .from("user_roles")
    .select(
      // "*"
      // "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*,assignments(*), assignment_groups(*,repositories(*)), user_roles(users(github_username)))))",
      "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*, assignments(*), assignment_groups(*, repositories(*), assignment_groups_members(*, user_roles(users(github_username))))))"
    )
    .eq("user_id", user.user!.id); //.eq("role", "student");
  if (classesError) {
    console.error(classesError);
    throw new UserVisibleError("Error fetching classes");
  }
  if (!classes) {
    throw new UserVisibleError("User is not a student");
  }

  const existingIndividualRepos = classes.flatMap((c) => c!.profiles!.repositories);
  const existingGroupRepos = classes.flatMap((c) =>
    c!.profiles!.assignment_groups_members!.flatMap((g) => g.assignment_groups.repositories)
  );
  const existingRepos = [...existingIndividualRepos, ...existingGroupRepos];
  //Find all assignments that the student is enrolled in that have been released
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  console.log(classes.map((c) => c.class_id));
  const { data: allAssignments, error: assignmentsError } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))),classes(slug,github_org,user_roles(role,users(github_username),profiles!private_profile_id(id, name, sortable_name)))"
    )
    .in(
      "class_id",
      classes!.map((c) => c!.class_id)
    )
    .eq("classes.user_roles.user_id", user.user!.id)
    .limit(1000);
  if (assignmentsError) {
    console.error(assignmentsError);
    throw new UserVisibleError("Error fetching assignments");
  }
  const assignments = allAssignments.filter(
    (a) =>
      (a.release_date && new Date(a.release_date) < new Date()) ||
      a.classes.user_roles.some((r) => r.role === "instructor" || r.role === "grader")
  );

  //For each group repo, sync the permissions
  const createdAsGroupRepos = await Promise.all(
    classes.flatMap((c) =>
      c!.profiles!.assignment_groups_members!.flatMap(async (groupMembership) => {
        const group = groupMembership.assignment_groups;
        const assignment = groupMembership.assignments;
        const repoName = `${c.classes!.slug}-${assignment.slug}-group-${group.name}`;

        console.log(`repoName: ${repoName}, groupMembership: ${JSON.stringify(groupMembership, null, 2)}`);
        // Make sure that the repo exists
        if (groupMembership.assignment_groups.repositories.length === 0) {
          console.log("Creating repo");
          const headSha = await createRepo(c.classes!.github_org!, repoName, assignment.template_repo!);

          console.log("Repo created");
          //Add the repo to the database
          const adminSupabase = createClient<Database>(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          );
          const { error } = await adminSupabase.from("repositories").insert({
            class_id: assignment.class_id!,
            assignment_group_id: group.id,
            assignment_id: assignment.id,
            repository: `${c.classes!.github_org}/${repoName}`,
            synced_repo_sha: headSha,
            synced_handout_sha: assignment.latest_template_sha
          });
          if (error) {
            console.error(error);
            throw new UserVisibleError(`Error creating repo: ${error}`);
          }
          return assignment;
        }

        await syncRepoPermissions(
          c.classes!.github_org!,
          repoName,
          c.classes!.slug!,
          group.assignment_groups_members
            .filter((m) => m.user_roles) // Needed to not barf when a student is removed from the class
            .map((m) => m.user_roles.users.github_username!)
        );
      })
    )
  );

  const requests = assignments!
    .filter(
      (assignment) =>
        !existingRepos.find((repo) => repo.assignment_id === assignment.id) &&
        !createdAsGroupRepos.find((_assignment) => _assignment?.id === assignment.id) &&
        assignment.group_config !== "groups"
    )
    .map(async (assignment) => {
      const userProfileID = classes.find((c) => c && c.class_id === assignment.class_id)?.profiles.id;
      if (!userProfileID) {
        throw new UserVisibleError(`User profile ID not found for class ${assignment.class_id}`);
      }
      if (!assignment.template_repo) {
        console.log(`No template repo for assignment ${assignment.id}`);
        return;
      }
      //Is it a group assignment?
      const courseSlug = assignment.classes!.slug;
      const repoName = `${courseSlug}-${assignment.slug}-${githubUsername}`;
      if (existingRepos.find((repo) => repo.repository === `${assignment.classes!.github_org}/${repoName}`)) {
        console.log(`Repo ${repoName} already exists...`);
        return;
      }
      //Use service role key to insert the repo into the database
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { error, data: dbRepo } = await adminSupabase
        .from("repositories")
        .insert({
          profile_id: userProfileID,
          class_id: assignment.class_id!,
          assignment_id: assignment.id,
          repository: `${assignment.classes!.github_org}/${repoName}`
        })
        .select("id")
        .single();
      if (error) {
        console.error(error);
      }

      try {
        const new_repo_sha = await createRepo(assignment.classes!.github_org!, repoName, assignment.template_repo);
        console.log(`courseSlug: ${courseSlug}`);
        await syncRepoPermissions(assignment.classes!.github_org!, repoName, courseSlug!, [githubUsername]);
        await adminSupabase
          .from("repositories")
          .update({
            synced_repo_sha: new_repo_sha,
            synced_handout_sha: assignment.latest_template_sha
          })
          .eq("id", dbRepo!.id);

        return new_repo_sha;
      } catch (e) {
        console.log(`Error creating repo: ${repoName}`);
        console.error(e);
        await adminSupabase.from("repositories").delete().eq("id", dbRepo!.id);
        throw new UserVisibleError(`Error creating repo: ${e}`);
      }
    });
  await Promise.all(requests);
  return {
    is_ok: true,
    message: `Repositories created for ${assignments!.length} assignments`
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
