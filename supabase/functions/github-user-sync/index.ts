import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import * as Sentry from "npm:@sentry/deno";
import { createRepo, getOctoKit, reinviteToOrgTeam, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

async function ensureAllReposExist(userID: string, githubUsername: string, scope: Sentry.Scope) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: classes, error: classesError } = await adminSupabase
    .from("user_roles")
    .select(
      // "*"
      // "class_id, classes(slug, github_org), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*,assignments(*), assignment_groups(*,repositories(*)), user_roles(users(github_username)))))",
      "class_id, github_org_confirmed, classes(slug, github_org, time_zone), profiles!private_profile_id(id, name, sortable_name, repositories(*), assignment_groups_members!assignment_groups_members_profile_id_fkey(*, assignments(*), assignment_groups(*, repositories(*), assignment_groups_members(*, user_roles(users(github_username))))))"
    )
    .eq("disabled", false)
    .eq("role", "student")
    .eq("user_id", userID);
  if (classesError) {
    Sentry.captureException(classesError, scope);
    throw new UserVisibleError("Error fetching classes");
  }

  let madeChanges = false;

  for (const c of classes) {
    if (c!.classes.github_org) {
      scope.addBreadcrumb({
        category: "github",
        message: `Reinviting user ${githubUsername} to org ${c!.classes.github_org}, team ${c!.classes.slug! + "-students"}`,
        level: "info"
      });
      const resp = await reinviteToOrgTeam(c!.classes.github_org, c!.classes.slug! + "-students", githubUsername);
      madeChanges = madeChanges || resp;
      if (!resp) {
        await adminSupabase
          .from("user_roles")
          .update({ github_org_confirmed: true })
          .eq("user_id", userID)
          .eq("class_id", c!.class_id);
      }
    }
  }

  const existingIndividualRepos = classes.flatMap((c) => c!.profiles!.repositories);
  const existingGroupRepos = classes.flatMap((c) =>
    c!.profiles!.assignment_groups_members!.flatMap((g) => g.assignment_groups.repositories)
  );

  const existingRepos = [...existingIndividualRepos, ...existingGroupRepos];
  //Find all assignments that the student is enrolled in that have been released
  const { data: allAssignments, error: assignmentsError } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))),classes(slug,github_org,time_zone,user_roles(role,users(github_username),profiles!private_profile_id(id, name, sortable_name)))"
    )
    .in(
      "class_id",
      classes!.map((c) => c!.class_id)
    )
    .eq("classes.user_roles.user_id", userID)
    .not("template_repo", "is", "null")
    .not("template_repo", "eq", "")
    .lte("release_date", TZDate.tz(classes[0].classes.time_zone!).toISOString())
    .limit(1000);
  if (assignmentsError) {
    Sentry.captureException(assignmentsError, scope);
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

        scope.addBreadcrumb({
          category: "github",
          message: `repoName: ${repoName}, template_repo: '${assignment.template_repo}', groupMembership: ${JSON.stringify(groupMembership, null, 2)}, existingRepos: ${JSON.stringify(groupMembership.assignment_groups.repositories, null, 2)}`,
          level: "info"
        });
        // Make sure that the repo exists
        if (groupMembership.assignment_groups.repositories.length === 0) {
          madeChanges = true;
          scope.addBreadcrumb({
            category: "github",
            message: `Creating repo ${repoName}`,
            level: "info"
          });
          //Add the repo to the database
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
            Sentry.captureException(error, scope);
            throw new UserVisibleError(`Error creating repo: ${error}`);
          }
          try {
            const headSha = await createRepo(c.classes!.github_org!, repoName, assignment.template_repo!);
            await adminSupabase
              .from("repositories")
              .update({
                synced_repo_sha: headSha || null,
                is_github_ready: true
              })
              .eq("id", dbRepo!.id);
            if (error) {
              Sentry.captureException(error, scope);
              throw new UserVisibleError(`Error creating repo: ${error}`);
            }
          } catch (e) {
            Sentry.captureException(e, scope);
            await adminSupabase.from("repositories").delete().eq("id", dbRepo!.id);
            errorMessages.push(
              `Error creating repo: ${repoName}, please ask your instructor to check that this is configured correctly.`
            );
          }
          return assignment;
        }

        try {
          scope.addBreadcrumb({
            category: "github",
            message: `Syncing permissions for ${repoName}, groupMemberUsernames: ${group.assignment_groups_members
              .filter((m) => m.user_roles) // Needed to not barf when a student is removed from the class
              .filter((m) => m.user_roles.users.github_username)
              .map((m) => m.user_roles.users.github_username!)
              .join(", ")}`,
            level: "info"
          });
          const { madeChanges: madeChangesForRepo } = await syncRepoPermissions(
            c.classes!.github_org!,
            repoName,
            c.classes!.slug!,
            group.assignment_groups_members
              .filter((m) => m.user_roles) // Needed to not barf when a student is removed from the class
              .filter((m) => m.user_roles.users.github_username)
              .map((m) => m.user_roles.users.github_username!),
            scope
          );
          madeChanges = madeChanges || madeChangesForRepo;
        } catch (e) {
          Sentry.captureException(e, scope);
          errorMessages.push(`Error syncing repo permissions for ${repoName}`);
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
        scope.addBreadcrumb({
          category: "github",
          message: `No template repo for assignment ${assignment.id}`,
          level: "info"
        });
        return;
      }
      //Is it a group assignment?
      const courseSlug = assignment.classes!.slug;
      const repoName = `${courseSlug}-${assignment.slug}-${githubUsername}`;
      if (existingRepos.find((repo) => repo.repository === `${assignment.classes!.github_org}/${repoName}`)) {
        scope.addBreadcrumb({
          category: "github",
          message: `Repo ${repoName} already exists...`,
          level: "info"
        });
        return;
      }
      madeChanges = true;
      //Use service role key to insert the repo into the database
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
        Sentry.captureException(error, scope);
        throw new UserVisibleError(`Error inserting repo: ${error}`);
      }

      try {
        scope.addBreadcrumb({
          category: "github",
          message: `Creating repo and syncing permissions for ${repoName}, githubUsername: ${githubUsername}`,
          level: "info"
        });
        const new_repo_sha = await createRepo(assignment.classes!.github_org!, repoName, assignment.template_repo);
        await syncRepoPermissions(assignment.classes!.github_org!, repoName, courseSlug!, [githubUsername], scope);
        await adminSupabase
          .from("repositories")
          .update({
            synced_repo_sha: new_repo_sha,
            synced_handout_sha: assignment.latest_template_sha,
            is_github_ready: true
          })
          .eq("id", dbRepo!.id);

        return new_repo_sha;
      } catch (e) {
        Sentry.captureException(e, scope);
        errorMessages.push(`Error creating repo: ${repoName}`);
        await adminSupabase.from("repositories").delete().eq("id", dbRepo!.id);
      }
    });
  await Promise.all(requests);

  // Sync permissions for existing individual repos
  const individualRepoSyncPromises = existingIndividualRepos
    .filter((repo) => repo.repository && repo.repository.includes("/"))
    .map(async (repo) => {
      try {
        const [orgName, repoName] = repo.repository.split("/");
        const classSlug = classes.find((c) => c.class_id === repo.class_id)?.classes?.slug;
        if (classSlug) {
          scope.addBreadcrumb({
            category: "github",
            message: `Syncing permissions for ${repo.repository}, githubUsername: ${githubUsername}`,
            level: "info"
          });
          const { madeChanges: madeChangesForRepo } = await syncRepoPermissions(
            orgName,
            repoName,
            classSlug,
            [githubUsername],
            scope
          );
          madeChanges = madeChanges || madeChangesForRepo;
        }
      } catch (e) {
        Sentry.captureException(e, scope);
        errorMessages.push(`Error syncing permissions for repo: ${repo.repository}`);
      }
    });

  // Sync permissions for existing group repos
  const groupRepoSyncPromises = existingGroupRepos
    .filter((repo) => repo.repository && repo.repository.includes("/"))
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

          scope.addBreadcrumb({
            category: "github",
            message: `Syncing permissions for ${repo.repository}, groupMemberUsernames: ${groupMemberUsernames.join(", ")}`,
            level: "info"
          });
          const { madeChanges: madeChangesForRepo } = await syncRepoPermissions(
            orgName,
            repoName,
            classSlug,
            groupMemberUsernames,
            scope
          );
          madeChanges = madeChanges || madeChangesForRepo;
        }
      } catch (e) {
        Sentry.captureException(e, scope);
        errorMessages.push(`Error syncing permissions for repo: ${repo.repository}`);
      }
    });

  await Promise.all([...individualRepoSyncPromises, ...groupRepoSyncPromises]);
  if (madeChanges) {
    Sentry.captureMessage("Fix GitHub button made changes", scope);
  }
  return { madeChanges, errorMessages };
}
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user }
  } = await supabase.auth.getUser(token);
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: classData, error: classError } = await supabase
    .from("classes")
    .select("github_org")
    .not("github_org", "is", "null")
    .limit(1)
    .single();
  if (classError) {
    Sentry.captureException(classError, scope);
    throw new UserVisibleError("Error fetching class");
  }
  if (!classData) {
    throw new UserVisibleError("User not in any classes");
  }
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("github_username, github_user_id, last_github_user_sync")
    .eq("user_id", user.id)
    .single();
  if (userError) {
    Sentry.captureException(userError, scope);
    throw new SecurityError("Error fetching user");
  }
  if (
    userData?.last_github_user_sync &&
    new Date(userData.last_github_user_sync) > new Date(new Date().getTime() - 1000 * 60 * 60 * 24)
  ) {
    return {
      success: false,
      message: `User has already been synced recently. If you still are struggling with GitHub permissions, please email ${Deno.env.get("SUPPORT_EMAIL") || "(No support email set)"}.`
    };
  }
  const octokit = await getOctoKit(classData.github_org!, scope);
  if (!octokit) {
    throw new UserVisibleError("Error fetching octokit");
  }
  if (!userData?.github_user_id) {
    throw new UserVisibleError("User has no github user id");
  }
  const gitHubUser = await octokit.request("GET /user/{account_id}", {
    account_id: Number(userData.github_user_id),
    headers: {
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (gitHubUser.status !== 200) {
    Sentry.captureException(gitHubUser, scope);
    throw new UserVisibleError("Error fetching github user");
  }
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { error: updateError } = await adminSupabase
    .from("users")
    .update({ github_username: gitHubUser.data.login, last_github_user_sync: new Date().toISOString() })
    .eq("user_id", user.id);
  if (updateError) {
    Sentry.captureException(updateError, scope);
    throw new UserVisibleError("Error updating user");
  }

  //For good measure, make sure that all repos for the student exist and have the correct permissions
  const { madeChanges, errorMessages } = await ensureAllReposExist(user.id, gitHubUser.data.login, scope);
  const changedUsername = userData.github_username !== gitHubUser.data.login;
  const messages = [];
  if (changedUsername) {
    scope.addBreadcrumb({
      category: "github",
      message: `GitHub username updated from ${userData.github_username} to ${gitHubUser.data.login}. Please refresh the page.`,
      level: "info"
    });
    messages.push(
      `GitHub username updated from ${userData.github_username} to ${gitHubUser.data.login}. Please refresh the page.`
    );
  }
  if (madeChanges) {
    messages.push(`Repositories were updated. Please refresh the page.`);
  }
  messages.push(...errorMessages);
  return {
    success: true,
    message: messages.join("\n")
  };
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
