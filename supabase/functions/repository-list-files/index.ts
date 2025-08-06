import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ListFilesRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import * as Sentry from "npm:@sentry/deno";
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { courseId, orgName, repoName } = (await req.json()) as ListFilesRequest;
  scope?.setTag("function", "repository-list-files");
  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("orgName", orgName);
  scope?.setTag("repoName", repoName);
  const { supabase } = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  const course = await supabase.from("classes").select("github_org").eq("id", courseId).single();
  if (!course.data?.github_org) {
    throw new Error("Course is not associated with a GitHub organization");
  }
  if (course.data.github_org !== orgName && orgName !== "pawtograder") {
    throw new Error(`Course is associated with ${course.data.github_org} not ${orgName}, which was requested`);
  }
  const files = await github.listFilesInRepo(course.data.github_org, repoName);
  return files;
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
