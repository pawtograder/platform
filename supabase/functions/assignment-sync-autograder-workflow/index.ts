import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentSyncAutograderWorkflowRequest } from "../_shared/FunctionTypes.d.ts";
import { RequestError } from "npm:octokit";
import {
  deleteFileFromRepo,
  getDefaultBranchHeadSha,
  getFileFromRepo,
  GRADE_WORKFLOW_PATH,
  renameFileInRepo,
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
/**
 * Push the current handout revision out to EXISTING student repos.
 *
 * Needed on BOTH toggle directions, and for the same underlying reason: the toggle only
 * edits the handout, so until each student repo syncs it still has (or still lacks)
 * grade.yml at its own commits.
 *   - enabling: those repos have no workflow while has_autograder is already true, so a
 *     `#submit` push dispatches something that is not there and an unmarked push records
 *     nothing — student work is lost.
 *   - disabling: those repos keep a live workflow, so every push still burns Actions
 *     minutes and shows the failing check this whole feature exists to remove.
 *
 * `queue_repository_syncs` is the same mechanism a handout push uses and skips repos
 * already at the target revision, so calling it unconditionally is safe. It MUST run on a
 * user-scoped client: it opens with `if auth.uid() is null then raise exception` and so
 * failed silently on the service-role client.
 *
 * Best-effort by design — the repo edit has already succeeded and is the thing the
 * instructor asked for — but failures are captured, because the consequence is student
 * pushes going unrecorded (or Actions still firing) until some later sync.
 */
async function queueHandoutSyncsForAssignments(
  adminSupabase: SupabaseClient<Database>,
  authHeader: string | null,
  assignmentIds: number[],
  scope: Sentry.Scope
): Promise<void> {
  const { data: repoRows, error: repoRowsError } = await adminSupabase
    .from("repositories")
    .select("id")
    .in("assignment_id", assignmentIds);
  if (repoRowsError) {
    scope.setTag("queue_repo_syncs_lookup_failed", "true");
    Sentry.captureException(repoRowsError, scope);
    return;
  }
  if (!repoRows || repoRows.length === 0) return;
  if (!authHeader) {
    scope.setTag("queue_repo_syncs_skipped", "no_user_context");
    console.log("Skipping repository sync queueing: no Authorization header to satisfy queue_repository_syncs");
    return;
  }
  const userSupabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } }
  });
  const { error: queueError } = await userSupabase.rpc("queue_repository_syncs", {
    p_repository_ids: repoRows.map((r) => r.id)
  });
  if (queueError) {
    scope.setTag("queue_repo_syncs_failed", "true");
    Sentry.captureException(queueError, scope);
    return;
  }
  scope.setTag("queued_repo_syncs", String(repoRows.length));
}

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
    .select("id, slug, title, has_autograder, submission_mode, template_repo, repo_mode, classes(slug,github_org)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new UserVisibleError("Assignment not found", 400);
  }

  // PR-mode assignments never have an autograder: their submissions are ingested by
  // the PR webhook and produce no Actions results. The create/edit paths coerce the
  // flag, but the autograder page's Enabled radio can still set it, and trusting a
  // stale `true` here would restore grade.yml into the upstream students fork from —
  // whose Actions runs then get rejected, showing PR students failing checks.
  // Treat PR mode as authoritative over the flag rather than the reverse.
  const isPrMode = assignment.submission_mode === "pr";
  // No-repo modes cannot host an autograder either: it runs as a GitHub Actions
  // workflow inside the student repo. The create/edit forms coerce this, but the
  // autograder page's Enabled radio is always reachable, so the flag can still arrive
  // true — and the !templateRepo return below would then report the autograder as
  // enabled with nowhere for it to run. repo_mode was already fetched and tagged here;
  // it just was not part of the decision.
  const isNoRepoMode = assignment.repo_mode === "none" || assignment.repo_mode === "no_submission";
  const hasAutograder = !isPrMode && !isNoRepoMode && assignment.has_autograder !== false;
  const templateRepo = assignment.template_repo;
  scope.setTag("has_autograder", String(hasAutograder));
  scope.setTag("submission_mode", assignment.submission_mode ?? "push");
  scope.setTag("repo_mode", assignment.repo_mode);
  if ((isPrMode || isNoRepoMode) && assignment.has_autograder !== false) {
    // Correct the row so the webhook and UI stop disagreeing with the mode, then
    // continue down the disable path below to strip any workflow already present.
    const { error: coerceError } = await adminSupabase
      .from("assignments")
      .update({ has_autograder: false })
      .eq("id", assignment_id)
      .eq("class_id", class_id);
    if (coerceError) {
      Sentry.captureException(coerceError, scope);
      throw coerceError;
    }
    scope.setTag("coerced_autograder_off", isPrMode ? "pr_mode" : "no_repo_mode");
  }

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
    .select("id, title, class_id, has_autograder, submission_mode")
    .eq("template_repo", templateRepo)
    .neq("id", assignment_id);
  if (sharersError) {
    Sentry.captureException(sharersError, scope);
    throw sharersError;
  }
  const allSharers = sharers ?? [];
  scope.setTag("template_repo_sharers", String(allSharers.length));

  // Only `class_id` was authorized above, and the writes below use the
  // service-role client. So the realignment must be confined to THIS class:
  // otherwise an instructor who administers one section could silently flip
  // has_autograder for another class that happens to point at the same
  // `owner/repo` handout.
  const foreignSharers = allSharers.filter((a) => a.class_id !== class_id);
  // A PR-mode assignment's EFFECTIVE setting is always false, whatever its row says —
  // PR submissions never run Actions. Comparing against a stale `true` would make a
  // foreign PR sharer look aligned while enabling, skipping the 403 below and letting
  // the toggle proceed to rewrite a repo another class depends on.
  const effectiveHasAutograder = (a: { has_autograder: boolean | null; submission_mode: string | null }) =>
    a.submission_mode !== "pr" && a.has_autograder !== false;
  const outOfStepForeign = foreignSharers.filter((a) => effectiveHasAutograder(a) !== hasAutograder);
  scope.setTag("template_repo_foreign_sharers", String(foreignSharers.length));
  if (outOfStepForeign.length > 0) {
    // We cannot authorize those assignments, and editing the shared repo would
    // change grading for them anyway. Refuse rather than reach outside the class.
    throw new UserVisibleError(
      `The handout ${templateRepo} is also used by ${outOfStepForeign.length} assignment` +
        `${outOfStepForeign.length === 1 ? "" : "s"} in another class with a different autograder setting. ` +
        `Changing it here would alter grading for a class you do not administer, so this handout cannot be ` +
        `toggled. Give this assignment its own handout repository first.`,
      403
    );
  }

  // In-class sharers CAN be realigned, but not yet: this function is about to
  // edit the repo, and if that fails the callers only roll back the assignment
  // the instructor opened. Flipping the others first would leave them disagreeing
  // with a handout that never changed. Collect them now, write them at the end.
  //
  // PR-mode sharers are excluded: their submissions are ingested by the PR webhook
  // and never produce Actions grader results, so has_autograder must stay false for
  // them (the create/edit paths and the backfill migration all enforce that).
  // Flipping one to true here would make its submissions render as an autograder
  // run that never completes. They keep their own correct value while the shared
  // handout's workflow follows this assignment.
  const inClassOutOfStep = allSharers.filter(
    (a) => a.class_id === class_id && a.submission_mode !== "pr" && effectiveHasAutograder(a) !== hasAutograder
  );
  const prSharers = allSharers.filter((a) => a.submission_mode === "pr");
  // Excluding PR sharers from the FLAG update is not sufficient when enabling: the
  // shared handout is the upstream those PR students fork from, so writing grade.yml
  // into it hands their forks a workflow whose runs `autograder-create-submission`
  // rejects — failing checks for students on an assignment that legitimately has no
  // autograder. The repo cannot serve both modes, so refuse rather than half-apply.
  if (hasAutograder && prSharers.length > 0) {
    // Name only the assignments this instructor is authorized for. `prSharers` is not
    // class-scoped — it cannot be, since a foreign PR sharer is just as affected by the
    // repo write — but leaking another class's assignment titles and ids to someone
    // authorized only for `class_id` is an information disclosure. Foreign ones are
    // reported as a bare count.
    const inClassPr = prSharers.filter((a) => a.class_id === class_id);
    const foreignPrCount = prSharers.length - inClassPr.length;
    const named = inClassPr.map((a) => `"${a.title}" (#${a.id})`).join(", ");
    const others =
      foreignPrCount > 0
        ? `${named ? " and " : ""}${foreignPrCount} assignment${foreignPrCount === 1 ? "" : "s"} in another class`
        : "";
    throw new UserVisibleError(
      `The handout ${templateRepo} is also used by ${named || ""}${others}, which submit by pull request. ` +
        `Adding the grading workflow to that handout would give their forks a workflow that cannot report ` +
        `results, so the autograder cannot be enabled while the handout is shared with a pull-request ` +
        `assignment. Give this assignment its own handout repository first.`,
      409
    );
  }
  const skippedPrSharers = prSharers.filter((a) => a.class_id === class_id).length;
  scope.setTag("template_repo_sharers_to_realign", String(inClassOutOfStep.length));
  scope.setTag("template_repo_pr_sharers_skipped", String(skippedPrSharers));

  /**
   * Bring in-class sharers to the chosen setting. Called only after the repo edit
   * has succeeded, so a GitHub failure never leaves them out of step with the
   * handout.
   *
   * FATAL on failure. By this point the shared handout already carries the new
   * workflow state, so a sharer left on the old flag would take the wrong
   * submission path — its webhook would dispatch a grade.yml that is gone, or
   * create direct submissions while a live workflow also runs. Reporting success
   * with those rows unfixed is worse than surfacing the error, so this throws and
   * lets the caller roll the flag back.
   */
  async function realignInClassSharers(): Promise<{ id: number; title: string }[]> {
    if (inClassOutOfStep.length === 0) return [];
    const { error: alignError } = await adminSupabase
      .from("assignments")
      .update({ has_autograder: hasAutograder })
      .eq("class_id", class_id)
      .in(
        "id",
        inClassOutOfStep.map((a) => a.id)
      );
    if (alignError) {
      scope.setTag("sharer_realign_failed", "true");
      Sentry.captureException(alignError, scope);
      throw new UserVisibleError(
        `The handout ${templateRepo} is shared with ` +
          `${inClassOutOfStep.map((a) => `"${a.title}" (#${a.id})`).join(", ")}, and those assignments could not be ` +
          `updated to match the new autograder setting: ${alignError.message}. The handout workflow was already ` +
          `changed, so please retry — leaving them out of step would send their submissions down the wrong path.`,
        502
      );
    }
    console.log(
      `Realigned has_autograder=${hasAutograder} for assignments sharing ${templateRepo}: ` +
        inClassOutOfStep.map((a) => a.id).join(", ")
    );
    return inClassOutOfStep.map((a) => ({ id: a.id, title: a.title }));
  }

  if (!hasAutograder) {
    // Park the workflow rather than just deleting it: instructors customize grade.yml
    // (runner labels, grading_server, extra steps) and the handout holds the only
    // assignment-specific copy, so a plain delete would lose it and re-enabling would
    // silently substitute the stock class template. GitHub only runs workflows matching
    // `.github/workflows/*.yml`, so the `.disabled` suffix stops every Action while
    // keeping the content readable in the repo.
    //
    // Done as ONE commit (a rename), not park-then-delete. Two commits left an
    // intermediate revision on the default branch holding both copies — i.e. a still
    // runnable grade.yml — and the template-repo push webhook sets latest_template_sha
    // from whichever delivery it happens to process. An out-of-order pair could
    // therefore advertise that intermediate commit as the handout head, and a later
    // student sync would reinstall the workflow on a no-autograder assignment.
    // Correcting the pointer afterwards was a patch; one commit removes the bad
    // revision entirely, so there is nothing to point at.
    let renameCommitSha: string | undefined;
    let moved = false;
    try {
      const result = await renameFileInRepo(
        templateRepo,
        GRADE_WORKFLOW_PATH,
        DISABLED_GRADE_WORKFLOW_PATH,
        "Disable autograder workflow: this assignment has no autograder",
        scope
      );
      moved = result.moved;
      renameCommitSha = result.commit_sha;
    } catch (e) {
      scope.setTag("park_workflow_failed", "true");
      Sentry.captureException(e, scope);
      const msg = e instanceof Error ? e.message : String(e);
      throw new UserVisibleError(
        `Could not move ${GRADE_WORKFLOW_PATH} out of the way in ${templateRepo}, so the autograder was left ` +
          `enabled rather than risk losing a customized workflow. Please try again: ${msg}`,
        502
      );
    }
    // `moved: false` means there was no grade.yml — the normal case for a handout
    // created repo-only.
    scope.setTag("parked_workflow", String(moved));
    const deleted = moved;
    const deleteCommitSha = renameCommitSha;

    // Same hazard as the restore path, mirrored: realignInClassSharers throws on
    // failure, and by now the live workflow is GONE. If that throw escaped, the
    // caller would roll has_autograder back to true and the assignment would claim
    // an autograder with no workflow to run. Put the workflow back before
    // rethrowing so the repo matches the flag the caller restores.
    let realigned: { id: number; title: string }[] = [];
    try {
      realigned = await realignInClassSharers();
    } catch (e) {
      if (moved) {
        scope.setTag("disable_rollback", "true");
        try {
          // The reverse rename, also one commit. No need to hold the content in
          // memory: the parked copy IS the content, so moving it back restores
          // exactly what was there.
          const { commit_sha: rollbackCommitSha } = await renameFileInRepo(
            templateRepo,
            DISABLED_GRADE_WORKFLOW_PATH,
            GRADE_WORKFLOW_PATH,
            "Roll back autograder workflow removal: disabling the autograder failed",
            scope
          );
          // Move the advertised head off the delete commit as well. Leaving it there
          // would have handout syncs strip grade.yml from student repos while the caller
          // restores has_autograder=true, so those repos could neither run Actions nor
          // take the push-direct path (which requires the flag to be false).
          if (rollbackCommitSha) {
            const { error: rollbackShaError } = await adminSupabase
              .from("assignments")
              // Repo-wide, matching the forward pin above and for the same reason: the
              // commit exists for every sharer, so leaving a foreign sharer pointed at
              // the delete commit would have its sync strip grade.yml from student repos
              // even though the workflow is back.
              .update({ latest_template_sha: rollbackCommitSha })
              .eq("template_repo", templateRepo);
            if (rollbackShaError) {
              scope.setTag("disable_rollback_sha_failed", "true");
              Sentry.captureException(rollbackShaError, scope);
            }
          }
        } catch (rollbackError) {
          scope.setTag("disable_rollback_failed", "true");
          Sentry.captureException(rollbackError, scope);
        }
      }
      throw e;
    }

    // Advertise the disable commit as the handout head. Repo-sync targets
    // latest_template_sha, so returning while assignments still point at the older
    // revision lets a sync that runs before the template-repo webhook copy the live
    // grade.yml back into student repos even though has_autograder=false.
    //
    // AFTER realignment, mirroring the enable path: a rollback above restores the
    // workflow, and pinning first would leave the pointer on a commit that no longer
    // reflects the repo. Repo-wide rather than class-scoped — the commit exists for
    // every sharer, and the 403 guard established that any foreign sharer already
    // agrees with this setting.
    if (deleted && deleteCommitSha) {
      const { error: shaError } = await adminSupabase
        .from("assignments")
        .update({ latest_template_sha: deleteCommitSha })
        .eq("template_repo", templateRepo);
      if (shaError) {
        // Not survivable: while the pointer names the pre-delete revision, a student
        // handout sync copies the live grade.yml back even though has_autograder is
        // false. Reporting success here would leave that window open silently, so fail
        // and let the caller roll the flag back.
        scope.setTag("pin_latest_template_sha_failed", "true");
        Sentry.captureException(shaError, scope);
        // Undo the repo edit AND the sharer realignment before throwing, as the other
        // failure branches do. Throwing bare made the caller restore this assignment's
        // flag to true while grade.yml stayed parked and the sharers stayed disabled —
        // an assignment claiming an autograder with no runnable workflow, whose
        // `#submit` pushes attempt a dispatch that is not there while also bypassing
        // direct ingestion, losing the work.
        if (moved) {
          scope.setTag("disable_rollback", "true");
          try {
            await renameFileInRepo(
              templateRepo,
              DISABLED_GRADE_WORKFLOW_PATH,
              GRADE_WORKFLOW_PATH,
              "Roll back autograder workflow removal: the handout revision pointer could not be updated",
              scope
            );
          } catch (rollbackError) {
            scope.setTag("disable_rollback_failed", "true");
            Sentry.captureException(rollbackError, scope);
          }
        }
        if (realigned.length > 0) {
          const { error: revertError } = await adminSupabase
            .from("assignments")
            .update({ has_autograder: !hasAutograder })
            .eq("class_id", class_id)
            .in(
              "id",
              realigned.map((a) => a.id)
            );
          if (revertError) {
            scope.setTag("pin_failure_sharer_rollback_failed", "true");
            Sentry.captureException(revertError, scope);
          }
        }
        throw new UserVisibleError(
          `The autograder workflow was removed from ${templateRepo}, but the handout revision pointer could not ` +
            `be updated (${shaError.message}). The change was rolled back — please try again.`,
          502
        );
      }
    }

    // Same need as the enable path, opposite direction: existing student repos still
    // carry the live grade.yml until they sync, so every push keeps burning Actions
    // minutes and showing the failing check this feature exists to remove. Queue after
    // pinning, so the syncs target the revision that no longer has the workflow.
    await queueHandoutSyncsForAssignments(
      adminSupabase,
      req.headers.get("Authorization"),
      [assignment_id, ...realigned.map((a) => a.id)],
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
    // Realign BEFORE hashing. realignInClassSharers throws on failure and the callers
    // answer that by rolling has_autograder back to false; writing workflow_sha first
    // would leave that hash behind on an assignment the caller just marked
    // no-autograder, which the has_autograder backfill reads as evidence that the
    // autograder was in use.
    //
    // That ordering means a hash failure would otherwise leave the SHARERS enabled
    // while the callers roll back only the assignment being edited — they know
    // nothing about the sharing set. So compensate here: put the sharers back before
    // rethrowing, since the caller cannot.
    const realigned = await realignInClassSharers();
    try {
      await updateAutograderWorkflowHash(templateRepo);
    } catch (e) {
      if (realigned.length > 0) {
        scope.setTag("sharer_realign_rollback", "true");
        const { error: revertError } = await adminSupabase
          .from("assignments")
          .update({ has_autograder: !hasAutograder })
          .eq("class_id", class_id)
          .in(
            "id",
            realigned.map((a) => a.id)
          );
        if (revertError) {
          scope.setTag("sharer_realign_rollback_failed", "true");
          Sentry.captureException(revertError, scope);
        }
      }
      throw e;
    }

    // No workflow file was written, but the assignment may still be pointing at the
    // WRONG revision: the edit flow reaches this branch when template_repo is replaced
    // with a handout that already has grade.yml, in which case latest_template_sha is
    // still a commit from the OLD repo and existing student repos still hold the old
    // workflow. Resolve this repo's head, pin it, and queue the syncs — the same three
    // steps the file-writing paths do, just without a write of our own.
    const unchangedHeadSha = await getDefaultBranchHeadSha(templateRepo, scope).catch((headErr) => {
      scope.setTag("unchanged_head_lookup_failed", "true");
      Sentry.captureException(headErr, scope);
      return undefined;
    });
    if (unchangedHeadSha) {
      const { error: shaError } = await adminSupabase
        .from("assignments")
        .update({ latest_template_sha: unchangedHeadSha })
        .eq("template_repo", templateRepo);
      if (shaError) {
        scope.setTag("pin_latest_template_sha_failed", "true");
        Sentry.captureException(shaError, scope);
      }
    }
    await queueHandoutSyncsForAssignments(
      adminSupabase,
      req.headers.get("Authorization"),
      [assignment_id, ...realigned.map((a) => a.id)],
      scope
    );

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

  const { commit_sha: restoreCommitSha } = await writeFileToRepo(
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
  //
  // The sharer realignment MUST sit inside this guard. It throws on failure, and
  // running it after the guard let that throw escape with the workflow live while
  // the caller set has_autograder=false — precisely the state this comment says
  // must not happen.
  let realignedOnRestore: { id: number; title: string }[] = [];
  try {
    await updateAutograderWorkflowHash(templateRepo);
    realignedOnRestore = await realignInClassSharers();
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

  // Advertise the restore commit as the handout head, mirroring what the disable
  // branch does for the delete commit: repo-sync targets `latest_template_sha`, so
  // until the template-repo push webhook catches up an instructor syncing student
  // repos right after re-enabling would be told they are already current, or would
  // sync the previous revision that has no workflow.
  //
  // Deliberately AFTER the guard above. Pinning before it meant a rollback deleted
  // the restored grade.yml while this pointer still named the restore commit that
  // CONTAINS it — so a later student sync would reintroduce the workflow on an
  // assignment whose flag the caller had just set back to false. Leaving the
  // pointer at the older, workflow-free revision is the safe direction.
  // Not class-scoped, for the same reason as the delete-commit pin above: the repo edit
  // reached every sharer, so every sharer's advertised head must follow it.
  if (restoreCommitSha) {
    const { error: shaError } = await adminSupabase
      .from("assignments")
      .update({ latest_template_sha: restoreCommitSha })
      .eq("template_repo", templateRepo);
    if (shaError) {
      // Symmetric to the disable path: without the pointer, nothing tells student repos
      // there is a new handout revision to pull, so they never receive the restored
      // workflow.
      //
      // This sits OUTSIDE the restore-rollback guard above, so throwing bare would let
      // the callers reset this assignment's flag to false while the live workflow stayed
      // in the handout and the realigned sharers stayed enabled — pushes taking the
      // direct-ingestion path while a stale Actions run also fired. Undo both before
      // propagating.
      scope.setTag("pin_latest_template_sha_failed", "true");
      Sentry.captureException(shaError, scope);
      try {
        await deleteFileFromRepo(
          templateRepo,
          GRADE_WORKFLOW_PATH,
          "Roll back autograder workflow restore: the handout revision pointer could not be updated",
          scope
        );
      } catch (rollbackError) {
        scope.setTag("pin_failure_workflow_rollback_failed", "true");
        Sentry.captureException(rollbackError, scope);
      }
      if (realignedOnRestore.length > 0) {
        const { error: revertError } = await adminSupabase
          .from("assignments")
          .update({ has_autograder: !hasAutograder })
          .eq("class_id", class_id)
          .in(
            "id",
            realignedOnRestore.map((a) => a.id)
          );
        if (revertError) {
          scope.setTag("pin_failure_sharer_rollback_failed", "true");
          Sentry.captureException(revertError, scope);
        }
      }
      throw new UserVisibleError(
        `The autograder workflow was restored to ${templateRepo}, but the handout revision pointer could not be ` +
          `updated (${shaError.message}). Student repositories would never receive the workflow, so the change ` +
          `was rolled back — please try again.`,
        502
      );
    }
  }

  await queueHandoutSyncsForAssignments(
    adminSupabase,
    req.headers.get("Authorization"),
    [assignment_id, ...realignedOnRestore.map((a) => a.id)],
    scope
  );

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
        scope,
        parkedSha
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
    realigned_assignments: realignedOnRestore
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
