import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import { AutograderCreateReposForStudentRequest } from "../_shared/FunctionTypes.d.ts";
import { createRepo, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

async function handleRequest(req: Request) {
  // Check for edge function secret authentication
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  let userId: string;
  let githubUsername: string | null;
  let classId: number | undefined;

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const class_id = Number.parseInt(url.searchParams.get("class_id")!);
    console.log("class_id", class_id);
    const user_id = url.searchParams.get("user_id");
    console.log("user_id", user_id);

    // Edge function secret authentication - get user_id from request body
    if (!user_id) {
      throw new UserVisibleError("user_id is required when using edge function secret authentication");
    }

    userId = user_id;
    classId = class_id;
    console.log("Creating GitHub repos for student with user_id:", userId, "class_id:", classId);
    // Get the user's Github username
    const { data: userData, error: userDataError } = await adminSupabase
      .from("users")
      .select("github_username")
      .eq("user_id", userId)
      .single();
    if (userDataError) {
      console.error(userDataError);
      throw new SecurityError(`Invalid user: ${userId}`);
    }
    if (!userData) {
      throw new SecurityError(`Invalid user: ${userId}`);
    }
    githubUsername = userData.github_username;
  } else {
    const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: {
        headers: { Authorization: req.headers.get("Authorization") || "" }
      }
    });
    // JWT authentication - get user from token
    const { data: user } = await supabase.auth.getUser();
    if (!user) {
      throw new UserVisibleError("User not found");
    }
    userId = user.user!.id;
    console.log("Creating GitHub repos for student ", user.user!.email);

    // Get the user's Github username
    const { data: userData, error: userDataError } = await supabase
      .from("users")
      .select("github_username")
      .eq("user_id", userId)
      .single();
    if (userDataError) {
      console.error(userDataError);
      throw new SecurityError(`Invalid user: ${userId}`);
    }
    if (!userData) {
      throw new SecurityError(`Invalid user: ${userId}`);
    }
    githubUsername = userData.github_username;
  }

  if (!githubUsername) {
    throw new UserVisibleError(`User ${userId} has no Github username linked`);
  }

  //Must use adminSupabase because students can't see each others' github usernames
  let classesQuery = adminSupabase
    .from("user_roles")
    .select(
      // "*"
      // "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*,assignments(*), assignment_groups(*,repositories(*)), user_roles(users(github_username)))))",
      "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*, assignments(*), assignment_groups(*, repositories(*), assignment_groups_members(*, user_roles(users(github_username))))))"
    )
    .eq("user_id", userId); //.eq("role", "student");

  // If class_id is provided, filter to only that class
  if (classId) {
    classesQuery = classesQuery.eq("class_id", classId);
  }

  const { data: classes, error: classesError } = await classesQuery;
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

  console.log(classes.map((c) => c.class_id));
  const { data: allAssignments, error: assignmentsError } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))),classes(slug,github_org,time_zone,user_roles(role,users(github_username),profiles!private_profile_id(id, name, sortable_name)))"
    )
    .in(
      "class_id",
      classes!.map((c) => c!.class_id)
    )
    .eq("classes.user_roles.user_id", userId)
    .not("template_repo", "is", "null")
    .not("template_repo", "eq", "")
    .limit(1000);
  if (assignmentsError) {
    console.error(assignmentsError);
    throw new UserVisibleError("Error fetching assignments");
  }
  const assignments = allAssignments.filter(
    (a) =>
      a.template_repo?.includes("/") &&
      ((a.release_date && new TZDate(a.release_date, a.classes.time_zone!) < TZDate.tz(a.classes.time_zone!)) ||
        a.classes.user_roles.some((r) => r.role === "instructor" || r.role === "grader"))
  );

  const errorMessages: string[] = [];
  //For each group repo, sync the permissions
  const createdAsGroupRepos = await Promise.all(
    classes.flatMap((c) =>
      c!.profiles!.assignment_groups_members!.flatMap(async (groupMembership) => {
        const group = groupMembership.assignment_groups;
        const assignment = groupMembership.assignments;
        if (!assignment.template_repo?.includes("/")) {
          return;
        }
        const repoName = `${c.classes!.slug}-${assignment.slug}-group-${group.name}`;

        console.log(
          `repoName: ${repoName}, template_repo: '${assignment.template_repo}', groupMembership: ${JSON.stringify(groupMembership, null, 2)}, existingRepos: ${JSON.stringify(groupMembership.assignment_groups.repositories, null, 2)}`
        );
        // Make sure that the repo exists
        if (groupMembership.assignment_groups.repositories.length === 0) {
          console.log("Creating repo");

          console.log("Repo created");
          //Add the repo to the database
          const adminSupabase = createClient<Database>(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          );
          const { error, data: dbRepo } = await adminSupabase
            .from("repositories")
            .insert({
              class_id: assignment.class_id!,
              assignment_group_id: group.id,
              assignment_id: assignment.id,
              repository: `${c.classes!.github_org}/${repoName}`,
              synced_handout_sha: assignment.latest_template_sha
            })
            .select("id")
            .single();
          if (error) {
            console.error(error);
            throw new UserVisibleError(`Error creating repo: ${error}`);
          }
          try {
            const headSha = await createRepo(c.classes!.github_org!, repoName, assignment.template_repo!);
            await adminSupabase
              .from("repositories")
              .update({
                synced_repo_sha: headSha || null
              })
              .eq("id", dbRepo!.id);
            if (error) {
              console.error(error);
              throw new UserVisibleError(`Error creating repo: ${error}`);
            }
          } catch (e) {
            console.log(`Error creating repo: ${repoName}`);
            console.error(e);
            await adminSupabase.from("repositories").delete().eq("id", dbRepo!.id);
            errorMessages.push(
              `Error creating repo: ${repoName}, please ask your instructor to check that this is configured correctly.`
            );
          }
          return assignment;
        }

        try {
          await syncRepoPermissions(
            c.classes!.github_org!,
            repoName,
            c.classes!.slug!,
            group.assignment_groups_members
              .filter((m) => m.user_roles) // Needed to not barf when a student is removed from the class
              .filter((m) => m.user_roles.users.github_username)
              .map((m) => m.user_roles.users.github_username!)
          );
        } catch (e) {
          console.log(`Error syncing repo permissions: ${repoName}`);
          console.error(e);
          errorMessages.push(
            `Error syncing repo permissions: ${repoName}, please ask your instructor to check that this is configured correctly.`
          );
        }
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
        throw new UserVisibleError(`Error inserting repo: ${error}`);
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
        errorMessages.push(
          `Error creating repo: ${repoName}, please ask your instructor to check that this is configured correctly.`
        );
        console.error(e);
        await adminSupabase.from("repositories").delete().eq("id", dbRepo!.id);
      }
    });
  await Promise.all(requests);
  return {
    is_ok: true,
    message: `Repositories created for ${assignments!.length} assignments. ${errorMessages.length > 0 ? `\n\n${errorMessages.join("\n")}` : ""}`
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
