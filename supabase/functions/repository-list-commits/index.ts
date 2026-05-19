import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { RepositoryListCommitsRequest } from "../_shared/FunctionTypes.d.ts";
import { listCommits } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInCourse, SecurityError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { ListCommitsResponse } from "../_shared/GitHubWrapper.ts";
import * as Sentry from "npm:@sentry/deno";

export type RepositoryListCommitsResponse = {
  commits: ListCommitsResponse["data"];
  has_more: boolean;
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<RepositoryListCommitsResponse> {
  const { course_id, repo_name, page } = (await req.json()) as RepositoryListCommitsRequest;
  if (!Number.isFinite(course_id) || course_id <= 0) {
    throw new SecurityError("Invalid course_id");
  }
  if (!repo_name || typeof repo_name !== "string") {
    throw new SecurityError("Invalid repo_name");
  }
  if (!Number.isFinite(page) || page <= 0) {
    throw new SecurityError("Invalid page");
  }

  scope?.setTag("function", "repository-list-commits");
  scope?.setTag("course_id", course_id.toString());
  scope?.setTag("repo_name", repo_name);
  scope?.setTag("page", page.toString());
  const { supabase, enrollment } = await assertUserIsInCourse(course_id, req.headers.get("Authorization")!);

  // Validate that the user can access the repo
  console.log(
    `Checking if user ${enrollment?.user_id} profile ${enrollment?.private_profile_id} is authorized to access repository ${repo_name}`
  );
  const { data: repo, error: repoError } = await supabase
    .from("repositories")
    .select("*")
    .eq("repository", repo_name)
    .eq("class_id", course_id)
    .maybeSingle();
  if (repoError) {
    throw new SecurityError(`Failed to load repository ${repo_name}: ${repoError.message}`);
  }
  if (!repo) {
    throw new SecurityError(
      `User ${enrollment?.user_id} profile ${enrollment?.private_profile_id} is not authorized to access repository ${repo_name}`
    );
  }

  const staffRoles = new Set(["admin", "instructor", "grader"]);
  const isStaff = staffRoles.has(enrollment.role);
  const ownsIndividualRepo = repo.profile_id !== null && repo.profile_id === enrollment.private_profile_id;
  let isGroupMember = false;
  if (!isStaff && repo.assignment_group_id !== null) {
    const { data: membership, error: membershipError } = await supabase
      .from("assignment_groups_members")
      .select("id")
      .eq("assignment_group_id", repo.assignment_group_id)
      .eq("profile_id", enrollment.private_profile_id)
      .maybeSingle();
    if (membershipError) {
      throw new SecurityError(`Failed to check repository group membership: ${membershipError.message}`);
    }
    isGroupMember = !!membership;
  }

  if (!isStaff && !ownsIndividualRepo && !isGroupMember) {
    throw new SecurityError(
      `User ${enrollment?.user_id} profile ${enrollment?.private_profile_id} is not authorized to access repository ${repo_name}`
    );
  }

  // Get the commits
  const commits = await listCommits(repo_name, page, scope);
  return commits;
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
