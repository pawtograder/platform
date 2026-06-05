import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import * as Sentry from "npm:@sentry/deno";
import { createRepo, getOctoKit, reinviteToOrgTeam, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import {
  assertUserIsInstructor,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { sanitizeRepoNameComponent } from "../_shared/repoNames.ts";
import type {
  GitHubLinkStatus,
  GitHubMembershipStatus,
  InstructorGitHubDiagnoseRequest,
  InstructorGitHubSyncRequest,
  InstructorGitHubUnlinkRequest
} from "../_shared/FunctionTypes.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

type InstructorGitHubRequest =
  | InstructorGitHubDiagnoseRequest
  | InstructorGitHubSyncRequest
  | InstructorGitHubUnlinkRequest;

type AdminSupabase = ReturnType<typeof createClient<Database>>;

type TargetStudentEnrollment = {
  id: number;
  user_id: string;
  role: Database["public"]["Enums"]["app_role"];
  github_org_confirmed: boolean;
  users: {
    email: string | null;
    github_username: string | null;
    github_user_id: string | null;
    last_github_user_sync: string | null;
  } | null;
  classes: {
    id: number;
    slug: string | null;
    github_org: string | null;
  } | null;
};

function getAdminSupabase() {
  return createClient<Database>(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
}

async function ensureStaffOrgMembership(userID: string, githubUsername: string, scope: Sentry.Scope) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: staffRoles, error: staffError } = await adminSupabase
    .from("user_roles")
    .select("class_id, role, github_org_confirmed, classes(slug, github_org)")
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .eq("user_id", userID);
  if (staffError) {
    Sentry.captureException(staffError, scope);
    return { madeChanges: false, errorMessages: ["Error fetching staff roles"] };
  }
  if (!staffRoles || staffRoles.length === 0) {
    return { madeChanges: false, errorMessages: [] };
  }
  let madeChanges = false;
  const errorMessages: string[] = [];
  for (const c of staffRoles) {
    if (!c.classes?.github_org || !c.classes?.slug) {
      continue;
    }
    const team_slug = `${c.classes.slug}-staff`;
    Sentry.addBreadcrumb({
      category: "github",
      message: `Ensuring staff org/team membership: ${githubUsername} -> ${c.classes.github_org}/${team_slug}`,
      level: "info"
    });
    try {
      const resp = await reinviteToOrgTeam(c.classes.github_org, team_slug, githubUsername, scope);
      madeChanges = madeChanges || resp;
      if (!resp) {
        // Either already in the team, or just added directly via PUT. Mark confirmed for this class.
        await adminSupabase
          .from("user_roles")
          .update({ github_org_confirmed: true })
          .eq("user_id", userID)
          .eq("class_id", c.class_id);
      }
    } catch (e) {
      Sentry.captureException(e, scope);
      errorMessages.push(`Error inviting ${githubUsername} to ${c.classes.github_org}/${team_slug}`);
    }
  }
  return { madeChanges, errorMessages };
}

async function ensureAllReposExist(userID: string, githubUsername: string, scope: Sentry.Scope) {
  const adminSupabase = getAdminSupabase();
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
  if (!classes || classes.length === 0) {
    return { madeChanges: false, errorMessages: [] };
  }

  let madeChanges = false;

  for (const c of classes) {
    if (c!.classes.github_org) {
      Sentry.addBreadcrumb({
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
        const repoName = `${c.classes!.slug}-${assignment.slug}-group-${sanitizeRepoNameComponent(group.name)}`;

        Sentry.addBreadcrumb({
          category: "github",
          message: `repoName: ${repoName}, template_repo: '${assignment.template_repo}', groupMembership: ${JSON.stringify(groupMembership, null, 2)}, existingRepos: ${JSON.stringify(groupMembership.assignment_groups.repositories, null, 2)}`,
          level: "info"
        });
        // Make sure that the repo exists
        if (groupMembership.assignment_groups.repositories.length === 0) {
          madeChanges = true;
          Sentry.addBreadcrumb({
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
            const { error: updateRepoError } = await adminSupabase
              .from("repositories")
              .update({
                synced_repo_sha: headSha || null,
                is_github_ready: true
              })
              .eq("id", dbRepo!.id);
            if (updateRepoError) {
              throw updateRepoError;
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
          Sentry.addBreadcrumb({
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
        Sentry.addBreadcrumb({
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
        Sentry.addBreadcrumb({
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
        Sentry.addBreadcrumb({
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
          Sentry.addBreadcrumb({
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

          Sentry.addBreadcrumb({
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
async function fetchGitHubUserLogin(
  githubUserId: string | null | undefined,
  githubOrg: string,
  scope: Sentry.Scope
): Promise<{ login: string | null; error?: string }> {
  if (!githubUserId) {
    return { login: null, error: "User has no GitHub user ID" };
  }
  const accountId = Number(githubUserId);
  if (!Number.isFinite(accountId)) {
    return { login: null, error: "User has an invalid GitHub user ID" };
  }
  const octokit = await getOctoKit(githubOrg, scope);
  if (!octokit) {
    throw new UserVisibleError("Error fetching octokit");
  }
  try {
    const gitHubUser = await octokit.request("GET /user/{account_id}", {
      account_id: accountId,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (gitHubUser.status !== 200) {
      Sentry.captureException(gitHubUser, scope);
      return { login: null, error: "Error fetching GitHub user" };
    }
    return { login: gitHubUser.data.login };
  } catch (error) {
    Sentry.captureException(error, scope);
    return { login: null, error: "Error fetching GitHub user" };
  }
}

async function getOrgMembershipStatus(
  org: string,
  username: string | null,
  scope: Sentry.Scope
): Promise<GitHubMembershipStatus> {
  if (!username) {
    return { state: "unknown", isMember: false, error: "No GitHub username is linked" };
  }
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new UserVisibleError("Error fetching octokit");
  }
  try {
    const membership = await octokit.request("GET /orgs/{org}/memberships/{username}", {
      org,
      username
    });
    const state =
      membership.data.state === "active" || membership.data.state === "pending" ? membership.data.state : "unknown";
    return { state, isMember: state === "active" };
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return { state: "not_found", isMember: false };
    }
    Sentry.captureException(error, scope);
    return { state: "unknown", isMember: false, error: "Error checking organization membership" };
  }
}

async function getTeamMembershipStatus(
  org: string,
  teamSlug: string | null,
  username: string | null,
  scope: Sentry.Scope
): Promise<GitHubMembershipStatus> {
  if (!teamSlug) {
    return { state: "unknown", isMember: false, error: "Course has no student team slug" };
  }
  if (!username) {
    return { state: "unknown", isMember: false, error: "No GitHub username is linked" };
  }
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new UserVisibleError("Error fetching octokit");
  }
  try {
    const membership = await octokit.request("GET /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug: teamSlug,
      username
    });
    const state =
      membership.data.state === "active" || membership.data.state === "pending" ? membership.data.state : "unknown";
    return { state, isMember: state === "active" };
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return { state: "not_found", isMember: false };
    }
    Sentry.captureException(error, scope);
    return { state: "unknown", isMember: false, error: "Error checking team membership" };
  }
}

async function getTargetStudentEnrollment(
  adminSupabase: AdminSupabase,
  courseId: number,
  userRoleId: number,
  scope: Sentry.Scope
): Promise<TargetStudentEnrollment> {
  const { data, error } = await adminSupabase
    .from("user_roles")
    .select(
      "id, user_id, role, github_org_confirmed, users(email, github_username, github_user_id, last_github_user_sync), classes(id, slug, github_org)"
    )
    .eq("id", userRoleId)
    .eq("class_id", courseId)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, scope);
    throw new UserVisibleError("Error fetching enrollment");
  }
  if (!data) {
    throw new UserVisibleError("Student enrollment not found");
  }
  if (data.role !== "student") {
    throw new UserVisibleError("GitHub diagnostics are only available for students");
  }
  return data as TargetStudentEnrollment;
}

async function diagnoseGitHubLinkStatus(
  target: TargetStudentEnrollment,
  scope: Sentry.Scope
): Promise<GitHubLinkStatus> {
  const githubOrg = target.classes?.github_org ?? null;
  const studentTeamSlug = target.classes?.slug ? `${target.classes.slug}-students` : null;
  let currentGithubUsername: string | null = null;
  if (githubOrg) {
    const currentUser = await fetchGitHubUserLogin(target.users?.github_user_id, githubOrg, scope);
    currentGithubUsername = currentUser.login;
  }
  const usernameForMembership = currentGithubUsername ?? target.users?.github_username ?? null;
  const orgMembership: GitHubMembershipStatus = githubOrg
    ? await getOrgMembershipStatus(githubOrg, usernameForMembership, scope)
    : { state: "unknown", isMember: false, error: "Course has no GitHub organization" };
  const teamMembership: GitHubMembershipStatus = githubOrg
    ? await getTeamMembershipStatus(githubOrg, studentTeamSlug, usernameForMembership, scope)
    : { state: "unknown", isMember: false, error: "Course has no GitHub organization" };

  return {
    courseId: target.classes?.id ?? 0,
    userRoleId: target.id,
    userId: target.user_id,
    email: target.users?.email ?? null,
    githubUsername: target.users?.github_username ?? null,
    githubUserId: target.users?.github_user_id ?? null,
    currentGithubUsername,
    usernameChanged: Boolean(
      currentGithubUsername &&
        target.users?.github_username &&
        currentGithubUsername.toLowerCase() !== target.users.github_username.toLowerCase()
    ),
    classOrg: githubOrg,
    studentTeamSlug,
    githubOrgConfirmed: target.github_org_confirmed,
    lastGithubUserSync: target.users?.last_github_user_sync ?? null,
    orgMembership,
    teamMembership
  };
}

async function syncGitHubUser(
  userId: string,
  githubOrg: string,
  force: boolean,
  scope: Sentry.Scope
): Promise<{ success: boolean; message: string }> {
  const adminSupabase = getAdminSupabase();
  const { data: userData, error: userError } = await adminSupabase
    .from("users")
    .select("github_username, github_user_id, last_github_user_sync")
    .eq("user_id", userId)
    .single();
  if (userError) {
    Sentry.captureException(userError, scope);
    throw new SecurityError("Error fetching user");
  }
  if (
    !force &&
    userData?.last_github_user_sync &&
    new Date(userData.last_github_user_sync) > new Date(new Date().getTime() - 1000 * 60 * 60 * 24)
  ) {
    return {
      success: false,
      message: `User has already been synced recently. If you still are struggling with GitHub permissions, please email ${Deno.env.get("SUPPORT_EMAIL") || "(No support email set)"}.`
    };
  }
  if (!userData?.github_user_id) {
    throw new UserVisibleError("User has no github user id");
  }
  const gitHubUser = await fetchGitHubUserLogin(userData.github_user_id, githubOrg, scope);
  if (!gitHubUser.login) {
    throw new UserVisibleError("Error fetching github user");
  }
  const { error: updateError } = await adminSupabase
    .from("users")
    .update({ github_username: gitHubUser.login, last_github_user_sync: new Date().toISOString() })
    .eq("user_id", userId);
  if (updateError) {
    Sentry.captureException(updateError, scope);
    throw new UserVisibleError("Error updating user");
  }

  // Ensure staff org/team membership for any instructor/grader roles this user has.
  // (ensureAllReposExist only operates on student roles.)
  const staffResult = await ensureStaffOrgMembership(userId, gitHubUser.login, scope);

  //For good measure, make sure that all repos for the student exist and have the correct permissions
  const { madeChanges: studentMadeChanges, errorMessages: studentErrorMessages } = await ensureAllReposExist(
    userId,
    gitHubUser.login,
    scope
  );
  const madeChanges = staffResult.madeChanges || studentMadeChanges;
  const errorMessages = [...staffResult.errorMessages, ...studentErrorMessages];
  const changedUsername = userData.github_username !== gitHubUser.login;
  const messages = [];
  if (changedUsername) {
    Sentry.addBreadcrumb({
      category: "github",
      message: `GitHub username updated from ${userData.github_username} to ${gitHubUser.login}. Please refresh the page.`,
      level: "info"
    });
    messages.push(
      `GitHub username updated from ${userData.github_username} to ${gitHubUser.login}. Please refresh the page.`
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

async function removeUserFromOrg(githubOrg: string, githubUsername: string, scope: Sentry.Scope) {
  const octokit = await getOctoKit(githubOrg, scope);
  if (!octokit) {
    throw new UserVisibleError("Error fetching octokit");
  }
  try {
    await octokit.request("DELETE /orgs/{org}/memberships/{username}", {
      org: githubOrg,
      username: githubUsername
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return false;
    }
    Sentry.captureException(error, scope);
    throw new UserVisibleError("Error removing student from GitHub organization");
  }
}

async function unlinkGitHubIdentityForUser(userEmail: string, scope: Sentry.Scope) {
  const adminSupabase = getAdminSupabase();
  const { data: magicLinkData, error: magicLinkError } = await adminSupabase.auth.admin.generateLink({
    email: userEmail,
    type: "magiclink"
  });
  if (magicLinkError || !magicLinkData.properties?.hashed_token) {
    Sentry.captureException(magicLinkError, scope);
    throw new UserVisibleError("Error generating sign-in link for student");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new UserVisibleError("Missing Supabase URL or anon key");
  }

  const userSupabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
  const { data: sessionData, error: sessionError } = await userSupabase.auth.verifyOtp({
    token_hash: magicLinkData.properties.hashed_token,
    type: "magiclink"
  });
  if (sessionError || !sessionData.session) {
    Sentry.captureException(sessionError, scope);
    throw new UserVisibleError("Error signing in as student");
  }

  const { data: identitiesData, error: identitiesError } = await userSupabase.auth.getUserIdentities();
  if (identitiesError) {
    Sentry.captureException(identitiesError, scope);
    throw new UserVisibleError("Error fetching student identities");
  }

  const githubIdentity = identitiesData?.identities.find((identity) => identity.provider === "github");
  if (!githubIdentity) {
    return false;
  }

  const { error: unlinkError } = await userSupabase.auth.unlinkIdentity(githubIdentity);
  if (unlinkError) {
    Sentry.captureException(unlinkError, scope);
    throw new UserVisibleError("Error unlinking GitHub identity");
  }
  await userSupabase.auth.signOut();
  return true;
}

async function handleInstructorGitHubRequest(req: Request, body: InstructorGitHubRequest, scope: Sentry.Scope) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  await assertUserIsInstructor(body.courseId, authHeader);
  const adminSupabase = getAdminSupabase();
  const target = await getTargetStudentEnrollment(adminSupabase, body.courseId, body.userRoleId, scope);

  if (body.action === "diagnose") {
    return { status: await diagnoseGitHubLinkStatus(target, scope) };
  }

  if (body.action === "sync") {
    if (!target.classes?.github_org) {
      throw new UserVisibleError("Course has no GitHub organization configured");
    }
    const syncResult = await syncGitHubUser(target.user_id, target.classes.github_org, true, scope);
    const refreshedTarget = await getTargetStudentEnrollment(adminSupabase, body.courseId, body.userRoleId, scope);
    return {
      message: syncResult.message || "GitHub permissions synced.",
      status: await diagnoseGitHubLinkStatus(refreshedTarget, scope)
    };
  }

  if (!target.users?.email) {
    throw new UserVisibleError("Student has no email address");
  }
  let removedFromOrg = false;
  if (target.classes?.github_org) {
    const currentUser = await fetchGitHubUserLogin(target.users.github_user_id, target.classes.github_org, scope);
    const usernameForRemoval = currentUser.login ?? target.users.github_username;
    if (usernameForRemoval) {
      removedFromOrg = await removeUserFromOrg(target.classes.github_org, usernameForRemoval, scope);
    }
  }
  const unlinkedIdentity = await unlinkGitHubIdentityForUser(target.users.email, scope);
  const { error: updateUserError } = await adminSupabase
    .from("users")
    .update({ github_username: null, github_user_id: null, last_github_user_sync: null })
    .eq("user_id", target.user_id);
  if (updateUserError) {
    Sentry.captureException(updateUserError, scope);
    throw new UserVisibleError("Error clearing GitHub link from student");
  }
  const { error: updateRoleError } = await adminSupabase
    .from("user_roles")
    .update({ github_org_confirmed: false })
    .eq("id", target.id);
  if (updateRoleError) {
    Sentry.captureException(updateRoleError, scope);
    throw new UserVisibleError("Error clearing GitHub organization status");
  }

  const refreshedTarget = await getTargetStudentEnrollment(adminSupabase, body.courseId, body.userRoleId, scope);
  return {
    message: unlinkedIdentity
      ? "GitHub identity unlinked and organization membership removed."
      : "No GitHub identity was linked; organization membership was checked.",
    removedFromOrg,
    unlinkedIdentity,
    status: await diagnoseGitHubLinkStatus(refreshedTarget, scope)
  };
}

async function parseRequestBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function handleStudentGitHubSync(req: Request, scope: Sentry.Scope) {
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
    .select("github_org, user_roles!inner(user_id, disabled)")
    .eq("user_roles.user_id", user.id)
    .eq("user_roles.disabled", false)
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
  return await syncGitHubUser(user.id, classData.github_org!, false, scope);
}

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const body = await parseRequestBody(req);
  if (body.action === "diagnose" || body.action === "sync" || body.action === "unlink") {
    return await handleInstructorGitHubRequest(req, body as InstructorGitHubRequest, scope);
  }
  return await handleStudentGitHubSync(req, scope);
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
