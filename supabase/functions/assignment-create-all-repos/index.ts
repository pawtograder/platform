import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import type { AssignmentCreateAllReposRequest, AssignmentGroup } from "../_shared/FunctionTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

// Declare EdgeRuntime for type safety
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

type RepoToCreate = {
  name: string;
  assignment_group?: AssignmentGroup;
  profile_id?: string;
  student_github_usernames: string[];
};

async function ensureRepoCreated({ org, repo, scope }: { org: string; repo: string; scope: Sentry.Scope }) {
  let repoExists = false;
  let attempts = 0;
  const maxAttempts = 10;
  while (!repoExists && attempts < maxAttempts) {
    try {
      scope?.setTag("ensure_repo_created_attempt", attempts.toString());
      const repoName = repo.split("/")[1];
      const repoData = await github.getRepo(org, repoName, scope);
      if (repoData && repoData.size > 0) {
        repoExists = true;
        scope?.setTag("ensure_repo_created_repo_data", JSON.stringify(repoData));
      } else {
        scope?.setTag("ensure_repo_created_repo_data", JSON.stringify(repoData));
        await new Promise((resolve) => setTimeout(resolve, 3000));
        attempts++;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Not Found")) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        attempts++;
      } else {
        throw e;
      }
      throw e;
    }
  }
}

async function createAllRepos(courseId: number, assignmentId: number, scope: Sentry.Scope) {
  scope.setTag("assignment_id", assignmentId.toString());
  scope.setTag("course_id", courseId.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: classData } = await adminSupabase.from("classes").select("time_zone").eq("id", courseId).single();
  const timeZone = classData?.time_zone;
  // Get the assignment from supabase
  const { data: assignment, error: assignmentError } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))), classes(slug,github_org,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))"
    ) // , classes(canvas_id), user_roles(user_id)')
    .eq("id", assignmentId)
    .lte("release_date", TZDate.tz(timeZone || "America/New_York").toISOString())
    .eq("class_id", courseId)
    .single();
  if (assignmentError) {
    scope.setTag("db_error", "assignment_fetch_failed");
    scope.setTag("db_error_message", assignmentError.message);
    throw new UserVisibleError("Error fetching assignment: " + assignmentError.message);
  }
  if (!assignment) {
    scope.setTag("assignment_error", "not_found_or_not_released");
    throw new UserVisibleError("Assignment not found. Please be sure that the release date has passed.");
  }

  scope.setTag("assignment_slug", assignment.slug || "unknown");
  scope.setTag("assignment_group_config", assignment.group_config || "unknown");
  scope.setTag("github_org", assignment.classes?.github_org || "unknown");
  scope.setTag("template_repo", assignment.template_repo || "none");
  // Select all existing repos for the assignment
  const { data: existingRepos } = await adminSupabase
    .from("repositories")
    .select(
      "*, assignment_groups(assignment_groups_members(*,user_roles(users(github_username)))), profiles(user_roles!user_roles_private_profile_id_fkey(users(github_username)))"
    )
    .eq("assignment_id", assignmentId);

  const studentsInAGroup = assignment.assignment_groups?.flatMap((group) =>
    group.assignment_groups_members.map((member) => member.profile_id)
  );
  // Find repos that need to be created
  const reposToCreate: RepoToCreate[] = [];
  if (assignment.group_config === "individual" || assignment.group_config === "both") {
    const individualRepos = assignment.classes!.user_roles.filter(
      (userRole) =>
        userRole.users.github_username &&
        !studentsInAGroup?.includes(userRole.profiles!.id) &&
        !existingRepos?.find((repo) => repo.profile_id === userRole.profiles!.id)
    );
    reposToCreate.push(
      ...individualRepos.map((userRole) => ({
        name: `${assignment.classes?.slug}-${assignment.slug}-${userRole.users.github_username}`,
        profile_id: userRole.profiles!.id,
        student_github_usernames: [userRole.users.github_username!]
      }))
    );
  }
  if (assignment.group_config === "groups" || assignment.group_config === "both") {
    const groupRepos = assignment.assignment_groups
      ?.filter((group) => !existingRepos?.find((repo) => repo.assignment_group_id === group.id))
      .map((group) => ({
        name: `${assignment.classes?.slug}-${assignment.slug}-group-${group.name}`,
        assignment_group: group,
        student_github_usernames: group.assignment_groups_members.map(
          (member) => member.user_roles.users.github_username!
        )
      }));
    reposToCreate.push(...groupRepos);
  }

  scope?.setTag("existing_repos_count", existingRepos?.length.toString() || "0");
  scope?.setTag("repos_to_create_count", reposToCreate.length.toString());
  scope?.setTag("students_in_groups_count", studentsInAGroup?.length.toString() || "0");
  scope?.setTag("assignment_groups_count", assignment.assignment_groups?.length.toString() || "0");

  //Before creating repos, check to make sure template repo exists in GitHub, wait for it to exist
  await ensureRepoCreated({ org: assignment.classes!.github_org!, repo: assignment.template_repo!, scope });

  const createRepo = async (
    name: string,
    github_username: string[],
    profile_id: string | null,
    assignmentGroup: AssignmentGroup | null
  ) => {
    const repoName = `${assignment.classes?.slug}-${assignment.slug}-${assignmentGroup?.name ?? github_username[0]}`;
    console.log(`Creating repo ${repoName} for ${name}`);
    if (!assignment.template_repo) {
      console.log(`No template repo for assignment ${assignment.id}`);
      return;
    }
    const { error, data: dbRepo } = await adminSupabase
      .from("repositories")
      .insert({
        profile_id: profile_id,
        assignment_group_id: assignmentGroup?.id,
        assignment_id: assignmentId,
        repository: assignment.classes!.github_org! + "/" + repoName,
        class_id: courseId,
        synced_handout_sha: assignment.latest_template_sha
      })
      .select("id")
      .single();
    if (error) {
      console.error(error);
      Sentry.captureException(error, scope);
      throw new UserVisibleError(`Error creating repo, repo not created: ${error}`);
    }
    if (!dbRepo) {
      throw new UserVisibleError(
        `Error creating repo: No repo created for ${assignment.classes!.github_org! + "/" + repoName}`
      );
    }

    try {
      const headSha = await github.createRepo(
        assignment.classes!.github_org!,
        repoName,
        assignment.template_repo,
        {},
        scope
      );
      await github.syncRepoPermissions(
        assignment.classes!.github_org!,
        repoName,
        assignment.classes!.slug!,
        github_username,
        scope
      );
      await adminSupabase
        .from("repositories")
        .update({
          synced_repo_sha: headSha
        })
        .eq("id", dbRepo.id);
    } catch (e) {
      console.log(`Error creating repo: ${repoName}`);
      console.error(e);
      await adminSupabase.from("repositories").delete().eq("id", dbRepo.id);
      throw new UserVisibleError(`Error creating repo: ${e}`);
    }
  };
  await Promise.all(
    reposToCreate.map(async (repo) =>
      createRepo(repo.name, repo.student_github_usernames, repo.profile_id ?? null, repo.assignment_group ?? null)
    )
  );
  if (existingRepos) {
    await Promise.all(
      existingRepos.map(async (repo) => {
        const [org, repoName] = repo.repository.split("/");
        let student_github_usernames = [];
        if (repo.assignment_groups?.assignment_groups_members) {
          student_github_usernames = repo.assignment_groups.assignment_groups_members.map(
            (member) => member.user_roles.users.github_username!
          );
        } else {
          const github_username = repo.profiles?.user_roles?.users.github_username;
          if (!github_username) {
            console.log(`No github username for repo ${repo.repository}`);
            return;
          }
          student_github_usernames = [github_username];
        }
        await github.syncRepoPermissions(org, repoName, assignment.classes!.slug!, student_github_usernames, scope);
      })
    );
  }
}

async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "assignment-create-all-repos");
  // Check for edge function secret authentication
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";

  let courseId: number;
  let assignmentId: number;

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("courseId")!);
    const assignment_id = Number.parseInt(url.searchParams.get("assignmentId")!);
    // Edge function secret authentication - get parameters from request body
    courseId = course_id;
    assignmentId = assignment_id;
    scope?.setTag("Source", "edge-function-secret");

    const handler = async () => {
      try {
        await createAllRepos(courseId, assignmentId, scope);
      } catch (error) {
        console.error("Background task failed:", error);
        Sentry.captureException(error, scope);
      }
    };
    EdgeRuntime.waitUntil(handler());

    return new Response(
      JSON.stringify({
        message: "Repository creation started in background",
        courseId,
        assignmentId
      }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" }
      }
    );
  } else {
    // JWT authentication - get parameters from request body and validate instructor permissions
    const { courseId: cId, assignmentId: aId } = (await req.json()) as AssignmentCreateAllReposRequest;
    courseId = cId;
    assignmentId = aId;
    await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
    scope?.setTag("Source", "jwt");

    // Await the task completion
    await createAllRepos(courseId, assignmentId, scope);

    return new Response(
      JSON.stringify({
        message: "All repositories created successfully",
        courseId,
        assignmentId
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
