import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import {
  assertUserIsInstructor,
  NotFoundError,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
import * as FunctionTypes from "../_shared/FunctionTypes.d.ts";

async function handleRequest(req: Request) {
  const { courseId, orgName, repoName, path } = await req
    .json() as FunctionTypes.GetFileRequest;
  const supabase = await assertUserIsInstructor(
    courseId,
    req.headers.get("Authorization")!,
  );
  const courseOrgName = await supabase.from("classes").select("github_org").eq(
    "id",
    courseId,
  ).single();
  if (courseOrgName.data?.github_org != orgName && orgName != "pawtograder") {
    throw new Error(
      `Requested a file from ${orgName}/${repoName} but the course is associated with ${courseOrgName.data?.github_org}`,
    );
  }
  try {
    return await github.getFileFromRepo(orgName + "/" + repoName, path);
  } catch (error) {
    if ("status" in (error as any) && (error as any).status === 404) {
      throw new NotFoundError(
        `File ${path} not found in ${orgName}/${repoName}`,
      );
    }
    throw error;
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
