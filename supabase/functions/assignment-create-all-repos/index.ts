import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import { AssignmentCreateAllReposRequest, AssignmentGroup } from "../_shared/FunctionTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

type RepoToCreate = {
  name: string;
  assignment_group?: AssignmentGroup;
  profile_id?: string;
  student_github_usernames: string[];
};

async function handleRequest(req: Request) {
  // Check for edge function secret authentication
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";

  let courseId: number;
  let assignmentId: number;

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("course_id")!);
    const assignment_id = Number.parseInt(url.searchParams.get("assignment_id")!);
    // Edge function secret authentication - get parameters from request body
    courseId = course_id;
    assignmentId = assignment_id;
    console.log("Creating all repos for assignment with courseId:", courseId, "assignmentId:", assignmentId);
  } else {
    // JWT authentication - get parameters from request body and validate instructor permissions
    const { courseId: cId, assignmentId: aId } = (await req.json()) as AssignmentCreateAllReposRequest;
    courseId = cId;
    assignmentId = aId;
    await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: classData } = await adminSupabase.from("classes").select("time_zone").eq("id", courseId).single();
  const timeZone = classData?.time_zone;
  // Get the assignment from supabase
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))), classes(slug,github_org,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))"
    ) // , classes(canvas_id), user_roles(user_id)')
    .eq("id", assignmentId)
    .lte("release_date", TZDate.tz(timeZone || "America/New_York").toISOString())
    .eq("class_id", courseId)
    .single();
  if (!assignment) {
    throw new UserVisibleError("Assignment not found. Please be sure that the release date has passed.");
  }
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
      throw new UserVisibleError(`Error creating repo: ${error}`);
    }
    if (!dbRepo) {
      throw new UserVisibleError(
        `Error creating repo: No repo created for ${assignment.classes!.github_org! + "/" + repoName}`
      );
    }

    try {
      const headSha = await github.createRepo(assignment.classes!.github_org!, repoName, assignment.template_repo);
      await github.syncRepoPermissions(
        assignment.classes!.github_org!,
        repoName,
        assignment.classes!.slug!,
        github_username
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
        await github.syncRepoPermissions(org, repoName, assignment.classes!.slug!, student_github_usernames);
      })
    );
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
