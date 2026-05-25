import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentCreateHandoutRepoRequest } from "../_shared/FunctionTypes.d.ts";
import {
  createRepo,
  syncRepoPermissions,
  updateAutograderWorkflowHash
} from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { resolveHandoutRepoAction, type HandoutSourceAssignment } from "../_shared/handoutRepoStrategy.ts";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentCreateHandoutRepoRequest;
  scope?.setTag("function", "assignment-create-handout-repo");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  // Allow both instructor users and service role (for admin scripts)
  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select(
      "id, slug, class_id, repo_mode, source_assignment_id, template_repo, latest_template_sha, " +
        "protect_block_force_push, protect_require_pull_request, protect_required_reviewers, " +
        "classes(slug,github_org)"
    )
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found", 400);
  }
  if (!assignment.classes.slug) {
    throw new UserVisibleError("Class does not have a slug", 400);
  }
  const handoutRepoOrg = assignment.classes.github_org;
  if (!handoutRepoOrg && assignment.repo_mode !== "none" && assignment.repo_mode !== "no_submission") {
    throw new UserVisibleError("Class does not have a GitHub organization", 400);
  }
  scope.setTag("repo_mode", assignment.repo_mode);

  let sourceAssignment: HandoutSourceAssignment | null = null;
  if (assignment.repo_mode === "fork_from_prior_assignment" && assignment.source_assignment_id) {
    const { data: src } = await adminSupabase
      .from("assignments")
      .select("id, class_id, template_repo, latest_template_sha")
      .eq("id", assignment.source_assignment_id)
      .maybeSingle();
    if (src) {
      sourceAssignment = src as HandoutSourceAssignment;
    }
  }

  const action = resolveHandoutRepoAction(
    {
      id: assignment.id,
      class_id: assignment.class_id,
      repo_mode: assignment.repo_mode,
      source_assignment_id: assignment.source_assignment_id
    },
    sourceAssignment
  );

  if (action.kind === "noop") {
    // repo_mode in ('none', 'no_submission'). Clear template_repo so downstream
    // consumers don't try to use a stale value, and skip GitHub entirely.
    if (assignment.template_repo) {
      await adminSupabase.from("assignments").update({ template_repo: null }).eq("id", assignment_id);
    }
    return {
      repo_name: null,
      org_name: null,
      skipped: true,
      repo_mode: assignment.repo_mode
    };
  }

  if (action.kind === "inherit_from_source") {
    // For fork_from_prior_assignment we don't create a new handout repo; the
    // student repos fork from each student's prior-assignment repo. We still
    // copy the source assignment's template_repo + latest_template_sha onto
    // this assignment so the handout-history UI and template-SHA-driven sync
    // continue to work.
    await adminSupabase
      .from("assignments")
      .update({
        template_repo: sourceAssignment!.template_repo,
        latest_template_sha: sourceAssignment!.latest_template_sha ?? null
      })
      .eq("id", assignment_id);
    return {
      repo_name: sourceAssignment!.template_repo?.split("/")[1] ?? null,
      org_name: sourceAssignment!.template_repo?.split("/")[0] ?? null,
      inherited_from_source: true,
      source_assignment_id: sourceAssignment!.id,
      repo_mode: assignment.repo_mode
    };
  }

  // action.kind === "create"
  const handoutRepoName = `${assignment.classes.slug}-handout-${assignment.slug}`;
  scope.setTag("handout_repo_name", handoutRepoName);
  scope.setTag("handout_repo_org", handoutRepoOrg!);

  const branchProtection = {
    blockForcePush: assignment.protect_block_force_push ?? true,
    requirePullRequest: assignment.protect_require_pull_request ?? false,
    requiredReviewers: assignment.protect_required_reviewers ?? 0
  };

  await createRepo(
    handoutRepoOrg!,
    handoutRepoName,
    action.sourceRepo,
    {
      is_template_repo: action.isTemplateRepo,
      creation_method: "template",
      branch_protection: branchProtection
    },
    scope
  );
  await syncRepoPermissions(
    handoutRepoOrg!,
    handoutRepoName,
    assignment.classes.slug,
    [],
    scope,
    action.studentTeamPermission ? { studentTeamPermission: action.studentTeamPermission } : undefined
  );
  // Branch protection is applied inside createRepo (both the fresh-create and
  // the pre-existing-repo branches), so we no longer need a redundant call here.
  await updateAutograderWorkflowHash(`${handoutRepoOrg}/${handoutRepoName}`);

  // Only persist the template_repo pointer after GitHub creation + permission
  // sync succeed, so a partial failure does not leave the assignment pointing
  // at a repo that does not exist.
  await adminSupabase
    .from("assignments")
    .update({ template_repo: `${handoutRepoOrg}/${handoutRepoName}` })
    .eq("id", assignment_id);

  return {
    repo_name: handoutRepoName,
    org_name: handoutRepoOrg,
    repo_mode: assignment.repo_mode
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
