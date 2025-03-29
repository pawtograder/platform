import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { ListReposRequest } from "../_shared/FunctionTypes.d.ts";


async function handleRequest(req: Request) {
  const { courseId, template_only } = await req.json() as ListReposRequest;
  const supabase = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  const {data: course} = await supabase.from("classes").select("*").eq("id", courseId).single();
  if(!course?.github_org) {
    throw new Error("Course is not associated with a GitHub organization");
  }
  const repos = await github.getRepos(course.github_org);
  if(template_only) {
    return repos.filter((repo) => repo.is_template);
  }
  return repos;
}
Deno.serve(async (req) => {
  console.log("repositories-list");
  return await wrapRequestHandler(req, handleRequest);
})
