import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentSyncAutograderWorkflowRequest } from "../_shared/FunctionTypes.d.ts";
import { RequestError } from "npm:octokit";
import {
  deleteFileFromRepo,
  getFileFromRepo,
  GRADE_WORKFLOW_PATH,
  updateAutograderWorkflowHash,
  writeFileToRepo
} from "../_shared/GitHubWrapper.ts";
import { resolveTemplateRepos } from "../_shared/GitHubSyncHelpers.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { shouldSkipRealGithubForE2eFixture } from "../_shared/e2eGithubGuard.ts";

/**
 * Bring the handout repo's grading workflow into line with
 * `assignments.has_autograder`, so an instructor can turn the autograder on or
 * off on an assignment that already exists (issue #895).
 *
 * - autograder OFF -> remove `.github/workflows/grade.yml` from the handout, so
 *   student repos generated from it run no GitHub Actions.
 * - autograder ON  -> restore `grade.yml` from the class's configured handout
 *   template and repopulate `autograder.workflow_sha` (submissions are rejected
 *   with a "workflow sha mismatch" while it is NULL).
 *
 * Idempotent: safe to call when the handout already matches the flag, which is
 * why callers can invoke it unconditionally rather than tracking the prior value.
 *
 * Note this only touches the HANDOUT. Student repos created before the toggle
 * keep their own copy of `grade.yml` until the existing handout-sync flow
 * (`sync_repo_to_handout`) carries the change downstream.
 */
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentSyncAutograderWorkflowRequest;
  scope?.setTag("function", "assignment-sync-autograder-workflow");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("id, slug, has_autograder, template_repo, repo_mode, classes(slug,github_org)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found", 400);
  }

  const hasAutograder = assignment.has_autograder !== false;
  const templateRepo = assignment.template_repo;
  scope.setTag("has_autograder", String(hasAutograder));
  scope.setTag("repo_mode", assignment.repo_mode);

  // No handout repo (upload-only / no-submission assignments, or a handout whose
  // creation has not completed yet) means there is no workflow file to manage.
  if (!templateRepo) {
    return { action: "unchanged" as const, has_autograder: hasAutograder, template_repo: null };
  }
  scope.setTag("template_repo", templateRepo);

  // E2E fixtures must never hit real GitHub.
  if (
    shouldSkipRealGithubForE2eFixture({
      org: templateRepo.split("/")[0],
      courseSlug: assignment.classes?.slug ?? null,
      repoName: templateRepo.split("/")[1]
    })
  ) {
    return { action: "unchanged" as const, has_autograder: hasAutograder, template_repo: templateRepo };
  }

  // A handout repo can be pointed at by more than one assignment: fork-from-prior
  // checkpoints inherit the SOURCE assignment's template_repo verbatim, and an
  // instructor can point two assignments at one handout. Writing to it would then
  // reach across assignments — turning the autograder off on a later checkpoint
  // would strip grade.yml from the source assignment's handout and break it.
  //
  // Pawtograder does not support a handout shared between autograded and
  // non-autograded assignments, so refuse with an explanation rather than
  // silently clobbering the other assignment.
  const { data: sharers, error: sharersError } = await adminSupabase
    .from("assignments")
    .select("id, title, has_autograder")
    .eq("template_repo", templateRepo)
    .neq("id", assignment_id);
  if (sharersError) {
    Sentry.captureException(sharersError, scope);
    throw sharersError;
  }
  const conflicting = (sharers ?? []).filter((a) => (a.has_autograder !== false) !== hasAutograder);
  scope.setTag("template_repo_sharers", String((sharers ?? []).length));
  if (conflicting.length > 0) {
    const names = conflicting.map((a) => `"${a.title}" (#${a.id})`).join(", ");
    throw new UserVisibleError(
      `The handout ${templateRepo} is also used by ${names}, whose autograder setting differs. ` +
        `Changing the workflow here would break that assignment, so a handout cannot be shared between ` +
        `autograded and non-autograded assignments. Give this assignment its own handout repository first.`,
      400
    );
  }

  if (!hasAutograder) {
    const { deleted } = await deleteFileFromRepo(
      templateRepo,
      GRADE_WORKFLOW_PATH,
      "Remove autograder workflow: this assignment has no autograder",
      scope
    );
    return {
      action: deleted ? ("removed" as const) : ("unchanged" as const),
      has_autograder: false,
      template_repo: templateRepo
    };
  }

  // Autograder turned back on. Read the handout's current grade.yml rather than
  // probing a hardcoded "main": handout repos may use another default branch, and
  // a wrong answer here would make us try to create a file that already exists
  // (the contents API rejects a create without the existing blob sha).
  let existingSha: string | undefined;
  try {
    existingSha = (await getFileFromRepo(templateRepo, GRADE_WORKFLOW_PATH, scope)).sha;
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 404)) throw e;
  }
  if (existingSha) {
    await updateAutograderWorkflowHash(templateRepo);
    return { action: "unchanged" as const, has_autograder: true, template_repo: templateRepo };
  }

  const { handout: handoutTemplateRepo } = await resolveTemplateRepos(adminSupabase, class_id);
  scope.setTag("source_template_repo", handoutTemplateRepo);
  let workflowContent: string;
  try {
    const file = await getFileFromRepo(handoutTemplateRepo, GRADE_WORKFLOW_PATH, scope);
    workflowContent = file.content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UserVisibleError(
      `Could not read ${GRADE_WORKFLOW_PATH} from the handout template ${handoutTemplateRepo}, so the autograder ` +
        `workflow could not be restored: ${msg}`,
      400
    );
  }

  await writeFileToRepo(
    templateRepo,
    GRADE_WORKFLOW_PATH,
    workflowContent,
    "Restore autograder workflow: this assignment now has an autograder",
    undefined,
    scope
  );
  await updateAutograderWorkflowHash(templateRepo);

  return { action: "added" as const, has_autograder: true, template_repo: templateRepo };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
