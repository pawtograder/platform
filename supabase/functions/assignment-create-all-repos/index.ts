import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AssignmentCreateAllReposRequest, AssignmentGroup } from "../_shared/FunctionTypes.d.ts";
import {
  assertUserIsInstructor,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";

type RepoToCreate = {
  name: string;
  assignment_group?: AssignmentGroup;
  profile_id?: string;
  student_github_usernames: string[];
}

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
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))), classes(slug,github_org,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))",
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

  const studentsInAGroup = assignment.assignment_groups?.flatMap((group) =>
    group.assignment_groups_members.map((member) => member.profile_id)
  );
  // Find repos that need to be created
  const reposToCreate: RepoToCreate[] = [];
  if (assignment.group_config === "individual" || assignment.group_config === "both") {
    const individualRepos = assignment.classes!.user_roles.filter((userRole) =>
      userRole.users.github_username &&
      !studentsInAGroup?.includes(userRole.profiles!.id) &&
      !existingRepos?.find((repo) => repo.profile_id === userRole.profiles!.id)
    );
    reposToCreate.push(...individualRepos.map((userRole) => ({
      name: `${assignment.classes?.slug}-${assignment.slug}-${userRole.users.github_username}`,
      profile_id: userRole.profiles!.id,
      student_github_usernames: [userRole.users.github_username!],
    })));
  }
  if (assignment.group_config === "groups" || assignment.group_config === "both") {
    const groupRepos = assignment.assignment_groups?.map((group) =>
    ({
      name: `${assignment.classes?.slug}-${assignment.slug}-group-${group.name}`,
      assignment_group: group,
      student_github_usernames: group.assignment_groups_members.map((member) => member.user_roles.users.github_username!),
    }));
    reposToCreate.push(...groupRepos);
  }


  const createRepo = async (
    name: string,
    github_username: string[],
    profile_id: string | null,
    assignmentGroup: AssignmentGroup | null,
  ) => {
    const repoName =
      `${assignment.classes?.slug}-${assignment.slug}-${assignmentGroup?.name ?? github_username[0]}`;
    console.log(`Creating repo ${repoName} for ${name}`);
    if (!assignment.template_repo) {
      console.log(`No template repo for assignment ${assignment.id}`);
      return;
    }
    await github.createRepo(
      assignment.classes!.github_org!,
      repoName,
      assignment.template_repo,
    );
    await github.syncRepoPermissions(
      assignment.classes!.github_org!,
      repoName,
      assignment.classes!.slug!,
      github_username,
    );
    const { error } = await adminSupabase.from("repositories").insert({
      profile_id: profile_id,
      assignment_group: assignmentGroup?.id,
      assignment_id: assignmentId,
      repository: assignment.classes!.github_org! + "/" + repoName,
      class_id: courseId,
    });
    if (error) {
      console.error(error);
    }
  };
  await Promise.all(
    reposToCreate.map(async (repo) =>
      createRepo(
        repo.name,
        repo.student_github_usernames,
        repo.profile_id ?? null,
        repo.assignment_group ?? null,
      )
    ),
  );
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
