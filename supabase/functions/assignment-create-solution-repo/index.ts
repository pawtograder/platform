import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { AssignmentCreateSolutionRepoRequest } from "../_shared/FunctionTypes.d.ts";
import { createRepo, getFileFromRepo, syncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { parse } from "jsr:@std/yaml";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import * as Sentry from "npm:@sentry/deno";

const TEMPLATE_SOLUTION_REPO_NAME = "pawtograder/template-assignment-grader";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentCreateSolutionRepoRequest;
  scope?.setTag("function", "assignment-create-solution-repo");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());
  await assertUserIsInstructor(class_id, req.headers.get("Authorization")!);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("slug,classes(slug,github_org)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found");
  }
  if (!assignment.classes.slug) {
    throw new UserVisibleError("Class does not have a slug");
  }
  const solutionRepoName = `${assignment.classes.slug}-solution-${assignment.slug}`;
  const solutionRepoOrg = assignment.classes.github_org;
  if (!solutionRepoOrg) {
    throw new UserVisibleError("Class does not have a GitHub organization");
  }
  await createRepo(solutionRepoOrg, solutionRepoName, TEMPLATE_SOLUTION_REPO_NAME);
  await syncRepoPermissions(solutionRepoOrg, solutionRepoName, assignment.classes.slug, []);
  const graderConfig = await getFileFromRepo(`${solutionRepoOrg}/${solutionRepoName}`, "pawtograder.yml");
  const asObj = (await parse(graderConfig.content)) as Json;
  await adminSupabase
    .from("autograder")
    .update({
      grader_repo: `${solutionRepoOrg}/${solutionRepoName}`,
      config: asObj
    })
    .eq("id", assignment_id);

  return {
    repo_name: solutionRepoName,
    org_name: solutionRepoOrg
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
