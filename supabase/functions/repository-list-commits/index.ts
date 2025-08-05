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
  scope?.setTag("function", "repository-list-commits");
  scope?.setTag("course_id", course_id.toString());
  scope?.setTag("repo_name", repo_name);
  scope?.setTag("page", page.toString());
  const { supabase, enrollment } = await assertUserIsInCourse(course_id, req.headers.get("Authorization")!);

  // Validate that the user can access the repo
  console.log(
    `Checking if user ${enrollment?.user_id} profile ${enrollment?.private_profile_id} is authorized to access repository ${repo_name}`
  );
  const { data: repo } = await supabase.from("repositories").select("*").eq("repository", repo_name).single();
  if (!repo) {
    throw new SecurityError(
      `User ${enrollment?.user_id} profile ${enrollment?.private_profile_id} is not authorized to access repository ${repo_name}`
    );
  }

  // Get the commits
  const commits = await listCommits(repo_name, page);
  return commits;
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
