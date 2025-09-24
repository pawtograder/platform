import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import { AutograderCreateReposForStudentRequest } from "../_shared/FunctionTypes.d.ts";
import { createRepo, isUserInOrg, reinviteToOrgTeam, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-create-repos-for-student");
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
  let assignmentId: number | undefined;
  const syncAllPermissions = true;

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const class_id = Number.parseInt(url.searchParams.get("class_id")!);
    console.log("class_id", class_id);
    const user_id = url.searchParams.get("user_id");
    console.log("user_id", user_id);
    const assignment_id_param = url.searchParams.get("assignment_id");
    assignmentId = assignment_id_param ? Number.parseInt(assignment_id_param) : undefined;
    console.log("assignment_id", assignmentId);
    // syncAllPermissions = url.searchParams.get("sync_all_permissions") === "true";
    console.log("sync_all_permissions", syncAllPermissions);

    // Edge function secret authentication - get user_id from request body
    if (!user_id) {
      throw new UserVisibleError("user_id is required when using edge function secret authentication", 400);
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
    scope?.setTag("Source", "edge-function-secret");
  } else {
    // JWT authentication - parse request body for parameters
    let requestBody: AutograderCreateReposForStudentRequest = {};
    if (req.method === "POST") {
      try {
        requestBody = await req.json();
      } catch {
        // If no body or invalid JSON, use default empty object
        console.log("No request body or invalid JSON, using defaults");
      }
    }
    // syncAllPermissions = requestBody.sync_all_permissions || false;
    classId = requestBody.class_id;
    assignmentId = requestBody.assignment_id;
    console.log("sync_all_permissions", syncAllPermissions);
    console.log("assignment_id", assignmentId);

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
    scope?.setTag("Source", "jwt");
  }
  scope?.setTag("class_id", classId?.toString() || "(null)");
  scope?.setTag("user_id", userId);
  scope?.setTag("github_username", githubUsername);
  if (!githubUsername) {
    throw new UserVisibleError(`User ${userId} has no Github username linked`, 400);
  }

  //Must use adminSupabase because students can't see each others' github usernames
  let classesQuery = adminSupabase
    .from("user_roles")
    .select(
      // "*"
      // "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*,assignments(*), assignment_groups(*,repositories(*)), user_roles(users(github_username)))))",
      "class_id, github_org_confirmed, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*, assignments(*), assignment_groups(*, repositories(*), assignment_groups_members(*, user_roles(users(github_username))))))"
    )
    .eq("disabled", false)
    .eq("user_id", userId); //.eq("role", "student");

  // If class_id is provided, filter to only that class
  if (classId) {
    classesQuery = classesQuery.eq("class_id", classId);
  }

  const { data: classData, error: classesError } = await classesQuery;
  if (classesError) {
    console.error(classesError);
    throw new UserVisibleError("Error fetching classes");
  }
  if (!classData) {
    throw new UserVisibleError("User is not a student", 400);
  }
  const allClasses = await Promise.all(
    classData.map(async (c) => {
      // Guard against missing github_org
      if (!c.classes.github_org) {
        console.warn(`Class ${c.class_id} has no github_org configured, setting isInOrg to false`);
        Sentry.addBreadcrumb({
          category: "autograder-create-repos-for-student",
          message: `Class ${c.class_id} has no github_org configured`,
          level: "warning",
          data: { class_id: c.class_id }
        });
        return { ...c, isInOrg: false };
      }

      // Guard against missing githubUsername
      if (!githubUsername) {
        console.warn(`User ${userId} has no github_username, setting isInOrg to false`);
        Sentry.addBreadcrumb({
          category: "autograder-create-repos-for-student",
          message: `User ${userId} has no github_username`,
          level: "warning",
          data: { user_id: userId }
        });
        return { ...c, isInOrg: false };
      }

      // Check if user is in org with error handling
      let isInOrg = false;
      try {
        isInOrg = await isUserInOrg(githubUsername, c.classes.github_org);
      } catch (error) {
        console.error(`Error checking if user ${githubUsername} is in org ${c.classes.github_org}:`, error);
        Sentry.captureException(error, {
          tags: {
            operation: "isUserInOrg",
            org: c.classes.github_org,
            github_username: githubUsername
          },
          extra: {
            class_id: c.class_id,
            user_id: userId
          }
        });
        // Fail closed - assume user is not in org
        isInOrg = false;
      }

      return { ...c, isInOrg };
    })
  );
  await Promise.all(
    allClasses
      .filter((c) => !c.isInOrg)
      .map(async (c) => {
        console.log(`User ${userId} is not in org ${c.classes.github_org}, updating user_roles`);
        Sentry.addBreadcrumb({
          category: "autograder-create-repos-for-student",
          message: `User ${userId} is not in org ${c.classes.github_org}, updating user_roles`,
          level: "info"
        });

        try {
          await reinviteToOrgTeam(c.classes.github_org!, c.classes.slug! + "-students", githubUsername!);
        } catch (error) {
          // Check if this is a non-fatal error (HTTP 422 - pending invite)
          const isNonFatalError = error && typeof error === "object" && "status" in error && error.status === 422;

          if (isNonFatalError) {
            console.log(`Non-fatal error inviting user ${githubUsername} to org ${c.classes.github_org}: ${error}`);
            Sentry.addBreadcrumb({
              category: "autograder-create-repos-for-student",
              message: `Non-fatal error inviting user ${githubUsername} to org ${c.classes.github_org}`,
              level: "warning",
              data: { error: error.message || String(error) }
            });
          } else {
            // Log fatal errors to Sentry
            console.error(`Fatal error inviting user ${githubUsername} to org ${c.classes.github_org}:`, error);
            Sentry.captureException(error, {
              tags: {
                operation: "reinvite_to_org_team",
                org: c.classes.github_org,
                github_username: githubUsername
              },
              extra: {
                class_id: c.class_id,
                team_slug: c.classes.slug! + "-students"
              }
            });
          }
        } finally {
          // Always update user_roles to persist invitation_date regardless of reinvite outcome
          await adminSupabase
            .from("user_roles")
            .update({ github_org_confirmed: false, invitation_date: new Date().toISOString() })
            .eq("class_id", c.class_id)
            .eq("user_id", userId);
        }
      })
  );

  const classes = allClasses.filter((c) => c.isInOrg);

  const existingIndividualRepos = classes.flatMap((c) => c!.profiles!.repositories);
  const existingGroupRepos = classes.flatMap((c) =>
    c!.profiles!.assignment_groups_members!.flatMap((g) => g.assignment_groups.repositories)
  );
  const existingRepos = [...existingIndividualRepos, ...existingGroupRepos];
  //Find all assignments that the student is enrolled in that have been released

  console.log(classes.map((c) => c.classes.github_org + ", Confirmed: " + c.github_org_confirmed));
  scope?.setTag(
    "github_org_confirmed",
    classes.map((c) => c.classes.github_org + ", Confirmed: " + c.github_org_confirmed).join(", ")
  );
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
        a.classes.user_roles.some((r) => r.role === "instructor" || r.role === "grader")) &&
      (assignmentId === undefined || a.id === assignmentId)
  );

  console.log(`Assignments: ${JSON.stringify(assignments, null, 2)}`);
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
        // Skip if assignment_id is specified and this assignment doesn't match
        if (assignmentId !== undefined && assignment.id !== assignmentId) {
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
              .map((m) => m.user_roles.users.github_username!),
            scope
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
        await syncRepoPermissions(assignment.classes!.github_org!, repoName, courseSlug!, [githubUsername], scope);
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

  // Sync permissions for all existing repos if requested
  if (syncAllPermissions) {
    console.log("Syncing permissions for all existing repos...");

    // Sync permissions for existing individual repos
    const individualRepoSyncPromises = existingIndividualRepos
      .filter((repo) => repo.repository && repo.repository.includes("/"))
      .filter((repo) => assignmentId === undefined || repo.assignment_id === assignmentId)
      .map(async (repo) => {
        try {
          const [orgName, repoName] = repo.repository.split("/");
          const classSlug = classes.find((c) => c.class_id === repo.class_id)?.classes?.slug;
          if (classSlug) {
            await syncRepoPermissions(orgName, repoName, classSlug, [githubUsername], scope);
            console.log(`Synced permissions for individual repo: ${repo.repository}`);
          }
        } catch (e) {
          console.log(`Error syncing permissions for individual repo: ${repo.repository}`);
          console.error(e);
          errorMessages.push(
            `Error syncing permissions for repo: ${repo.repository}, please ask your instructor to check that this is configured correctly.`
          );
        }
      });

    // Sync permissions for existing group repos
    const groupRepoSyncPromises = existingGroupRepos
      .filter((repo) => repo.repository && repo.repository.includes("/"))
      .filter((repo) => assignmentId === undefined || repo.assignment_id === assignmentId)
      .map(async (repo) => {
        try {
          const [orgName, repoName] = repo.repository.split("/");
          const classSlug = classes.find((c) => c.class_id === repo.class_id)?.classes?.slug;

          // Find the assignment group for this repo
          const groupMembership = classes
            .flatMap((c) => c!.profiles!.assignment_groups_members!)
            .find((gm) => gm.assignment_groups.repositories.some((r) => r.id === repo.id));

          if (classSlug && groupMembership) {
            const groupMemberUsernames = groupMembership.assignment_groups.assignment_groups_members
              .filter((m) => m.user_roles && m.user_roles.users.github_username)
              .map((m) => m.user_roles.users.github_username!);

            await syncRepoPermissions(orgName, repoName, classSlug, groupMemberUsernames, scope);
            console.log(`Synced permissions for group repo: ${repo.repository}`);
          }
        } catch (e) {
          console.log(`Error syncing permissions for group repo: ${repo.repository}`);
          console.error(e);
          errorMessages.push(
            `Error syncing permissions for repo: ${repo.repository}, please ask your instructor to check that this is configured correctly.`
          );
        }
      });

    await Promise.all([...individualRepoSyncPromises, ...groupRepoSyncPromises]);
  }

  return {
    is_ok: true,
    message: `Repositories created for ${assignments!.length} assignments${assignmentId ? ` (filtered to assignment ${assignmentId})` : ""}.${syncAllPermissions ? ` Synced permissions for all existing repos${assignmentId ? ` for assignment ${assignmentId}` : ""}.` : ""} ${errorMessages.length > 0 ? `\n\n${errorMessages.join("\n")}` : ""}`
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
