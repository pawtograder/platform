import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { AssignmentCreateHandoutRepoRequest } from "../_shared/FunctionTypes.d.ts";
import {
  createRepo,
  getFileFromRepo,
  syncRepoPermissions,
  updateAutograderWorkflowHash
} from "../_shared/GitHubWrapper.ts";
import * as Sentry from "npm:@sentry/deno";

const TEMPLATE_HANDOUT_REPO_NAME = "pawtograder/template-assignment-handout";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentCreateHandoutRepoRequest;
  scope?.setTag("function", "assignment-create-handout-repo");
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
  const handoutRepoName = `${assignment.classes.slug}-handout-${assignment.slug}`;
  const handoutRepoOrg = assignment.classes.github_org;
  if (!handoutRepoOrg) {
    throw new UserVisibleError("Class does not have a GitHub organization");
  }
  await adminSupabase
    .from("assignments")
    .update({
      template_repo: `${handoutRepoOrg}/${handoutRepoName}`
    })
    .eq("id", assignment_id);
  scope.setTag("handout_repo_name", handoutRepoName);
  scope.setTag("handout_repo_org", handoutRepoOrg);
  await createRepo(handoutRepoOrg, handoutRepoName, TEMPLATE_HANDOUT_REPO_NAME, { is_template_repo: true });
  await syncRepoPermissions(handoutRepoOrg, handoutRepoName, assignment.classes.slug, []);
  await updateAutograderWorkflowHash(`${handoutRepoOrg}/${handoutRepoName}`);

  return {
    repo_name: handoutRepoName,
    org_name: handoutRepoOrg
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
