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
 * Where the live workflow is parked while the autograder is off. GitHub only runs
 * workflows matching `.github/workflows/*.yml`, so this suffix disables it without
 * losing an instructor's customizations.
 */
const DISABLED_GRADE_WORKFLOW_PATH = `${GRADE_WORKFLOW_PATH}.disabled`;

/** Blob sha of `path` in `repoName`, or null when the file does not exist. */
async function getFileShaIfExists(
  repoName: string,
  path: string,
  scope: Sentry.Scope
): Promise<string | null | undefined> {
  try {
    return (await getFileFromRepo(repoName, path, scope)).sha;
  } catch (e) {
    if (e instanceof RequestError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Bring the handout repo's grading workflow into line with
 * `assignments.has_autograder`, so an instructor can turn the autograder on or
 * off on an assignment that already exists (issue #895).
 *
 * - autograder OFF -> park `.github/workflows/grade.yml` as `grade.yml.disabled`
 *   and delete the live file, so student repos generated from the handout run no
 *   GitHub Actions but the (possibly customized) content survives.
 * - autograder ON  -> restore `grade.yml` from the parked copy when there is one,
 *   otherwise from the class's configured handout template, and repopulate
 *   `autograder.workflow_sha` (submissions are rejected with a "workflow sha
 *   mismatch" while it is NULL).
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
  // instructor can point two assignments at one handout. The workflow file is a
  // property of that shared repo, so the sharers cannot disagree about it.
  //
  // The UI toggles one assignment at a time, so by the time we run, only THIS
  // assignment carries the new value. Rejecting on any difference would therefore
  // make a shared handout permanently un-toggleable — there is no order of
  // single-assignment saves that ever converges. Instead, bring the whole sharing
  // set to the value the instructor just chose, then write the repo once.
  const { data: sharers, error: sharersError } = await adminSupabase
    .from("assignments")
    .select("id, title, has_autograder")
    .eq("template_repo", templateRepo)
    .neq("id", assignment_id);
  if (sharersError) {
    Sentry.captureException(sharersError, scope);
    throw sharersError;
  }
  const outOfStep = (sharers ?? []).filter((a) => (a.has_autograder !== false) !== hasAutograder);
  scope.setTag("template_repo_sharers", String((sharers ?? []).length));
  scope.setTag("template_repo_sharers_realigned", String(outOfStep.length));
  const realigned = outOfStep.map((a) => ({ id: a.id, title: a.title }));
  if (outOfStep.length > 0) {
    const { error: alignError } = await adminSupabase
      .from("assignments")
      .update({ has_autograder: hasAutograder })
      .in(
        "id",
        outOfStep.map((a) => a.id)
      );
    if (alignError) {
      Sentry.captureException(alignError, scope);
      throw new UserVisibleError(
        `The handout ${templateRepo} is shared with ${outOfStep.map((a) => `"${a.title}" (#${a.id})`).join(", ")}, ` +
          `and those assignments could not be updated to match, so the autograder setting was left unchanged: ` +
          `${alignError.message}`,
        502
      );
    }
    console.log(
      `Realigned has_autograder=${hasAutograder} for assignments sharing ${templateRepo}: ` +
        outOfStep.map((a) => a.id).join(", ")
    );
  }

  if (!hasAutograder) {
    // Park the workflow beside itself instead of just deleting it. Instructors
    // customize grade.yml (runner labels, grading_server, extra steps), and the
    // handout holds the only assignment-specific copy — a plain delete would lose
    // it, and re-enabling would silently substitute the stock class template.
    //
    // GitHub only runs workflows matching `.github/workflows/*.yml`, so the
    // `.disabled` suffix stops every Action while keeping the content readable and
    // self-explanatory in the repo (and harmless if copied into student repos).
    // Nothing to park (no grade.yml) is the normal case for a handout created
    // repo-only; that's a 404 and we just proceed. Any OTHER failure must abort
    // BEFORE the delete below — parking exists precisely so the delete is safe,
    // so deleting anyway would destroy the customized workflow this is meant to
    // protect. Better to fail the toggle and let the instructor retry.
    let liveWorkflow: { content: string; sha?: string } | null = null;
    try {
      liveWorkflow = await getFileFromRepo(templateRepo, GRADE_WORKFLOW_PATH, scope);
    } catch (e) {
      if (!(e instanceof RequestError && e.status === 404)) throw e;
    }

    if (liveWorkflow) {
      try {
        await writeFileToRepo(
          templateRepo,
          DISABLED_GRADE_WORKFLOW_PATH,
          liveWorkflow.content,
          "Park autograder workflow: this assignment has no autograder",
          // Overwrite an older parked copy if one is already there.
          (await getFileShaIfExists(templateRepo, DISABLED_GRADE_WORKFLOW_PATH, scope)) ?? undefined,
          scope
        );
      } catch (e) {
        scope.setTag("park_workflow_failed", "true");
        Sentry.captureException(e, scope);
        const msg = e instanceof Error ? e.message : String(e);
        throw new UserVisibleError(
          `Could not preserve a copy of ${GRADE_WORKFLOW_PATH} from ${templateRepo}, so the autograder was left ` +
            `enabled rather than risk losing a customized workflow. Please try again: ${msg}`,
          502
        );
      }
    }
    scope.setTag("parked_workflow", String(!!liveWorkflow));

    const { deleted } = await deleteFileFromRepo(
      templateRepo,
      GRADE_WORKFLOW_PATH,
      "Remove autograder workflow: this assignment has no autograder",
      scope
    );
    return {
      action: deleted ? ("removed" as const) : ("unchanged" as const),
      has_autograder: false,
      template_repo: templateRepo,
      realigned_assignments: realigned
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
    return {
      action: "unchanged" as const,
      has_autograder: true,
      template_repo: templateRepo,
      realigned_assignments: realigned
    };
  }

  // Prefer the copy parked when the autograder was turned off — it may carry this
  // assignment's customizations, which the class template would not. Fall back to
  // the class template when there is nothing parked (e.g. the handout was created
  // repo-only and never had a workflow).
  let workflowContent: string | undefined;
  let restoredFrom: "parked" | "class_template" = "parked";
  let parkedSha: string | undefined;
  try {
    const parkedFile = await getFileFromRepo(templateRepo, DISABLED_GRADE_WORKFLOW_PATH, scope);
    workflowContent = parkedFile.content;
    parkedSha = parkedFile.sha;
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 404)) throw e;
  }

  if (workflowContent === undefined) {
    restoredFrom = "class_template";
    const { handout: handoutTemplateRepo } = await resolveTemplateRepos(adminSupabase, class_id);
    scope.setTag("source_template_repo", handoutTemplateRepo);
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
  }
  scope.setTag("restored_workflow_from", restoredFrom);

  await writeFileToRepo(
    templateRepo,
    GRADE_WORKFLOW_PATH,
    workflowContent,
    restoredFrom === "parked"
      ? "Restore autograder workflow from the parked copy: this assignment now has an autograder"
      : "Restore autograder workflow from the class handout template: this assignment now has an autograder",
    undefined,
    scope
  );

  // From here the handout has a RUNNABLE workflow. If anything below fails we
  // throw, and callers roll has_autograder back to false — which would leave a
  // live grade.yml on a no-autograder assignment: Actions would fire on pushes
  // while the webhook also created direct submissions. So undo the restore before
  // rethrowing, keeping the repo consistent with the flag the caller restores.
  try {
    await updateAutograderWorkflowHash(templateRepo);
  } catch (e) {
    scope.setTag("restore_rollback", "true");
    try {
      await deleteFileFromRepo(
        templateRepo,
        GRADE_WORKFLOW_PATH,
        "Roll back autograder workflow restore: enabling the autograder failed",
        scope
      );
    } catch (rollbackError) {
      // Report the failed rollback too — the repo is now genuinely inconsistent
      // and an instructor needs to know which state it is in.
      scope.setTag("restore_rollback_failed", "true");
      Sentry.captureException(rollbackError, scope);
    }
    throw e;
  }

  // The autograder is live and hashed, so the toggle has succeeded. Clearing the
  // parked copy is tidy-up only: a leftover grade.yml.disabled runs nothing, so a
  // failure here must NOT undo a working restore or flip has_autograder back.
  // Deliberately after the hash update, so a hash failure still leaves the
  // preserved content available for the next attempt.
  if (parkedSha) {
    try {
      await deleteFileFromRepo(
        templateRepo,
        DISABLED_GRADE_WORKFLOW_PATH,
        "Remove parked autograder workflow: the live workflow has been restored",
        scope
      );
    } catch (cleanupError) {
      scope.setTag("parked_copy_cleanup_failed", "true");
      Sentry.captureException(cleanupError, scope);
    }
  }

  return {
    action: "added" as const,
    has_autograder: true,
    template_repo: templateRepo,
    realigned_assignments: realigned
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
