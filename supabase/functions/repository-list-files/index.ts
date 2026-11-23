import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ListFilesRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { assertForgejoCourseOrg, parseGitProvider, repoFilesFor } from "../_shared/repoFileAccess.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { courseId, orgName, repoName, gitProvider } = (await req.json()) as ListFilesRequest;
  const provider = parseGitProvider(gitProvider);
  scope?.setTag("function", "repository-list-files");
  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("orgName", orgName);
  scope?.setTag("repoName", repoName);
  scope?.setTag("git_provider", provider);
  const { supabase } = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  if (provider === "forgejo") {
    await assertForgejoCourseOrg(supabase, courseId, orgName);
    return await repoFilesFor(provider).listFiles(orgName.toLowerCase(), repoName);
  }
  const course = await supabase.from("classes").select("github_org").eq("id", courseId).single();
  if (!course.data?.github_org) {
    throw new Error("Course is not associated with a GitHub organization");
  }
  if (course.data.github_org !== orgName && orgName !== "pawtograder") {
    throw new Error(`Course is associated with ${course.data.github_org} not ${orgName}, which was requested`);
  }
  const files = await repoFilesFor(provider).listFiles(course.data.github_org, repoName);
  return files;
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
