"use client";

import { toaster } from "@/components/ui/toaster";
import { assignmentSyncAutograderWorkflow, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { revalidateCourseDerivedCachesClient } from "@/lib/revalidateCourseDerivedCachesClient";
import { createClient } from "@/utils/supabase/client";
import { Assignment, SelfReviewSettings } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading } from "@chakra-ui/react";
import { useOne, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { FieldValues } from "react-hook-form";
import AssignmentForm from "../../new/form";

export default function EditAssignment() {
  const { course_id, assignment_id } = useParams();
  const form = useForm<Assignment>({
    refineCoreProps: { resource: "assignments", action: "edit", id: Number.parseInt(assignment_id as string) }
  });
  const { reset, refineCore } = form;
  const queryData = refineCore.query?.data?.data;
  const { mutate: update, mutateAsync: updateAsync } = useUpdate();

  useEffect(() => {
    if (queryData) {
      reset(queryData);
    }
  }, [queryData, reset]);

  const selfReviewSettingId = queryData?.self_review_setting_id;
  const { data: selfReviewSetting, isFetched: selfReviewSettingFetched } = useOne<SelfReviewSettings>({
    resource: "assignment_self_review_settings",
    id: selfReviewSettingId,
    queryOptions: { enabled: selfReviewSettingId !== undefined }
  });
  useEffect(() => {
    // Wait for the settings query to settle before seeding these fields: the
    // form renders while it is still in flight, and writing the "no settings"
    // fallbacks (base_only, null offsets, cleared release time) in the meantime
    // would silently disable an assignment's self review if the user saved
    // before the real values arrived.
    if (queryData && selfReviewSettingFetched) {
      form.setValue("eval_config", selfReviewSetting?.data?.enabled ? "use_eval" : "base_only");
      form.setValue("deadline_offset", selfReviewSetting?.data?.deadline_offset);
      form.setValue("allow_early", selfReviewSetting?.data?.allow_early);
      form.setValue("self_review_release_at", selfReviewSetting?.data?.release_at ?? null);
    }
  }, [
    queryData,
    form,
    selfReviewSettingFetched,
    selfReviewSetting?.data?.allow_early,
    selfReviewSetting?.data?.deadline_offset,
    selfReviewSetting?.data?.enabled,
    selfReviewSetting?.data?.release_at
  ]);

  const onFinish = useCallback(
    async (values: FieldValues) => {
      try {
        const supabase = createClient();
        // Without the id from the loaded assignment there is no row to write to;
        // sending `id: undefined` would just make the update fail server-side.
        if (values && selfReviewSettingId !== undefined) {
          const isEnabled = values.eval_config == "use_eval";
          update(
            {
              resource: "assignment_self_review_settings",
              id: selfReviewSettingId,
              values: {
                enabled: isEnabled,
                deadline_offset: isEnabled ? values.deadline_offset : null,
                allow_early: isEnabled ? values.allow_early : null,
                release_at: isEnabled ? values.self_review_release_at || null : null,
                class_id: course_id
              }
            },
            {
              onError: (error) => {
                toaster.error({ title: "Error creating self review settings", description: error.message });
              }
            }
          );
        }
        values.eval_config = undefined;
        values.allow_early = undefined;
        values.deadline_offset = undefined;
        values.self_review_release_at = undefined;
        // Coerce repo-config fields to satisfy the assignments_no_protection_when_no_repo
        // and assignments_source_assignment_iff_fork constraints when the user flips
        // between modes. The form only DISABLES the branch-protection inputs for
        // no-repo modes, it doesn't reset their stored values — so without this
        // the constraint will reject the update.
        const isNoRepo = values.repo_mode === "none" || values.repo_mode === "no_submission";
        if (isNoRepo) {
          values.protect_block_force_push = false;
          values.protect_require_pull_request = false;
          values.protect_required_reviewers = 0;
          values.template_repo = null;
          // The autograder is a GitHub Actions workflow in the student repo, so it
          // cannot exist without one. Mirrors the create-page coercion.
          values.has_autograder = false;
        }
        if (values.repo_mode !== "fork_from_prior_assignment") {
          values.source_assignment_id = null;
        }
        // Enabling the autograder from THIS form skips the grader-repo setup the
        // autograder page performs, so without a configured grader repo we would
        // happily restore grade.yml to the handout and leave has_autograder true —
        // and the next Actions submission would fail with "grader config not
        // found". Refuse and point at the page that can configure it.
        if (values.has_autograder === true && queryData?.has_autograder === false) {
          const { data: graderRow } = await supabase
            .from("autograder")
            .select("grader_repo")
            .eq("id", Number.parseInt(assignment_id as string))
            .maybeSingle();
          if (!graderRow?.grader_repo) {
            throw new Error(
              "This assignment has no grader repository configured, so the autograder cannot be enabled here. " +
                "Set it up on the assignment's Autograder page first, which creates and validates the grader repo."
            );
          }
        }
        // Submission-mode / upstream coupling (Option A): for PR mode the
        // upstream repo IS the handout (template_repo), so keep them equal.
        // When not PR, clear PR/upstream config so toggling back to push doesn't
        // leave stale upstream values behind.
        if (values.submission_mode === "pr") {
          // PR submissions are ingested by the PR webhook and never produce
          // grader_results, so the autograder flag must be false here — mirrors the
          // create page and the backfill migration, both of which exclude PR mode.
          values.has_autograder = false;
          values.upstream_repo = values.template_repo ?? null;
          // "branch_convention" identification is only meaningful with a non-empty regex; if it's
          // blank, fall back to "base_branch" so we never persist an inconsistent PR config
          // (branch_convention with no rule to match the submission PR).
          const convention = (values.pr_branch_convention ?? "").trim();
          values.pr_branch_convention = convention || null;
          if (values.pr_identification === "branch_convention" && !convention) {
            values.pr_identification = "base_branch";
          }
        } else {
          values.upstream_repo = null;
          values.pr_branch_convention = null;
          values.require_pr_open = false;
        }
        await form.refineCore.onFinish(values);
        await revalidateCourseDerivedCachesClient(Number.parseInt(course_id as string, 10));
        if (values.template_repo) {
          // Both GitHub-touching calls sit in ONE rollback scope. The row is already
          // saved by this point, so anything that throws here would otherwise leave
          // has_autograder at its new value with the handout untouched — and the
          // webhook-configure step runs first, so keeping it outside the try meant a
          // transient GitHub failure there skipped the rollback entirely.
          try {
            await githubRepoConfigureWebhook(
              {
                assignment_id: Number.parseInt(assignment_id as string),
                new_repo: values.template_repo,
                watch_type: "template_repo"
              },
              supabase
            );
            // The form exposes the autograder toggle, so keep the handout's grade.yml in
            // step with it (added when enabled, removed when disabled).
            //
            // ONLY when the flag actually changed. The sync is idempotent in outcome but
            // NOT in effect: it rewrites the handout repo, re-pins latest_template_sha,
            // and realigns every in-class assignment sharing that handout. Running it on
            // every save meant an unrelated edit (a due date, say) stripped grade.yml from
            // the handout of any assignment already sitting at has_autograder=false — a
            // state reached without the instructor asking for it, since the backfill
            // migration leaves it false whenever there is no grader_repo.
            //
            // PR mode is excluded only in the ENABLE direction. Disabling must still run,
            // including when the disable is a side effect of converting push -> PR: the
            // handout doubles as the upstream students fork, so leaving grade.yml there
            // hands every fork a workflow whose runs are rejected as
            // "assignment has no autograder" — failing checks on student PRs until
            // someone removes the file by hand. (The earlier note here claimed the
            // handout's workflow was irrelevant in PR mode; it is not, for exactly that
            // reason.) The sync itself refuses to ENABLE on a PR-mode assignment.
            const autograderFlagChanged =
              queryData?.has_autograder !== undefined && queryData.has_autograder !== values.has_autograder;
            // A NEW handout also needs reconciling even when the flag did not move. On a
            // has_autograder=false assignment the freshly selected repo may carry the
            // stock grade.yml, and githubRepoConfigureWebhook skips workflow handling for
            // a disabled assignment — so student repos and handout syncs would inherit a
            // live workflow while pushes simultaneously take the direct-submission path,
            // producing rejected runs. This is a real repo change, not the unrelated edit
            // the flag-only guard exists to ignore.
            const templateRepoChanged =
              queryData?.template_repo !== undefined && queryData.template_repo !== values.template_repo;
            const needsWorkflowSync = autograderFlagChanged || templateRepoChanged;
            const isDisabling = values.has_autograder === false;
            // Reconcile a PR-mode handout that may still hold a live grade.yml.
            //
            // The 20260805170500 backfill flips existing repository-backed PR assignments to
            // has_autograder=false, but a migration cannot edit GitHub — so their handout, and
            // the student forks made from it, keep the workflow. Nothing else would ever remove
            // it: the flag no longer CHANGES on later saves, so the guard above skips the sync
            // forever, and the enable direction is refused for PR mode, so an instructor cannot
            // toggle it off and on to force the cleanup either.
            //
            // Sent as reconcile_only, because this page cannot tell whether the handout actually
            // disagrees — that answer lives in GitHub. The sync returns immediately when there is
            // nothing to park, so an assignment whose handout is already correct pays one API
            // read per save rather than a re-pin and a repository-sync queue.
            const needsPrWorkflowReconcile =
              !needsWorkflowSync &&
              values.submission_mode === "pr" &&
              values.has_autograder === false &&
              !!values.template_repo;
            if ((needsWorkflowSync && (isDisabling || values.submission_mode !== "pr")) || needsPrWorkflowReconcile) {
              const syncResult = await assignmentSyncAutograderWorkflow(
                {
                  assignment_id: Number.parseInt(assignment_id as string),
                  class_id: Number.parseInt(course_id as string),
                  reconcile_only: needsPrWorkflowReconcile
                },
                supabase
              );
              if (syncResult?.repo_sync_queue_failed) {
                // The handout is correct but existing student repositories were not queued, so they
                // still hold the previous workflow state. Silence here would leave students pushing
                // into a repo that can neither run the autograder nor take the direct-ingestion
                // path, with nothing to explain it.
                toaster.create({
                  title: "Student repositories were not synced",
                  description:
                    "The handout repository was updated, but the sync jobs for existing student " +
                    "repositories could not be queued. Sync them from the assignment's repositories " +
                    "page — until then they still have the previous autograder setup.",
                  type: "warning"
                });
              }
              if ((syncResult?.unsynced_other_class_count ?? 0) > 0) {
                // Count only: naming assignments in another class would disclose them to an
                // instructor who is not authorized for it.
                const otherCount = syncResult!.unsynced_other_class_count!;
                toaster.create({
                  title: `${otherCount} assignment${otherCount === 1 ? "" : "s"} in another class share this handout`,
                  description:
                    "Their handout repository was updated too, but their student repositories cannot be synced from " +
                    "here — an instructor in those classes needs to sync them.",
                  type: "info"
                });
              }
              // The workflow file belongs to the shared handout repo, so sharers cannot
              // disagree and the sync brings them along. Say so — FunctionTypes.d.ts makes
              // this the caller's job, and the autograder page already does it; without it
              // an instructor silently changes assignments they never opened.
              const realigned = syncResult?.realigned_assignments ?? [];
              if (realigned.length > 0) {
                toaster.create({
                  title: `Also updated ${realigned.length} assignment${realigned.length === 1 ? "" : "s"}`,
                  description:
                    `${realigned.map((a) => a.title).join(", ")} share this handout repository, so the autograder ` +
                    `was turned ${values.has_autograder ? "on" : "off"} for ${
                      realigned.length === 1 ? "it" : "them"
                    } too.`,
                  type: "info"
                });
              }
            }
          } catch (syncError) {
            // Restore EVERY assignment field this save wrote, not a hand-picked subset.
            //
            // `onFinish(values)` above has already committed the whole form, so a save that
            // changed a due date or a title ALONGSIDE the repository configuration used to
            // leave those unrelated edits persisted while the toast said nothing had been
            // saved. Deferring the row write until after the sync is not an option — the
            // sync function reads has_autograder from the database — so the rollback has to
            // be complete instead.
            //
            // Keyed off the submitted values, so it restores exactly the columns that were
            // written and nothing else: a key absent from the loaded row (`eval_config` and
            // the other self-review fields, which live on another table) is skipped, and no
            // column is touched that this save did not already touch. `latest_template_sha`
            // is added explicitly because the sync re-pins it server-side without it ever
            // passing through the form.
            //
            // This also removes the flag clamp that used to live here. Restoring the whole
            // prior row means the mode and the flag come back TOGETHER, and that row was
            // already valid — the database trigger enforces the invariant — so there is no
            // longer a newly-saved PR mode for a restored `true` to contradict.
            const priorValues: Record<string, unknown> = {};
            if (queryData) {
              const loadedRow = queryData as unknown as Record<string, unknown>;
              for (const key of [...Object.keys(values), "latest_template_sha"]) {
                if (key in loadedRow) priorValues[key] = loadedRow[key];
              }
            }
            if (Object.keys(priorValues).length > 0) {
              // CONDITIONAL on the row still holding what this save wrote.
              //
              // The GitHub work above takes seconds, which is long enough for a second
              // instructor to save the same assignment. An unconditional restore of this page's
              // load-time snapshot would then erase their title, dates, repository settings or
              // latest_template_sha — undoing a save that succeeded in order to undo one that
              // failed.
              //
              // Matching on the values this save committed makes it all-or-nothing: if anything
              // has changed since, no rows match and nothing is clobbered. That is the right
              // direction to fail — the instructor sees "not saved" over a row someone else
              // owns, rather than silently losing that person's work — and it is logged so the
              // case is visible.
              //
              // Awaited, because a fire-and-forget rollback would let the error toast claim the
              // save failed while the row keeps the new values. Guarded, because an unhandled
              // rejection here would replace `syncError` and the instructor would learn why the
              // ROLLBACK failed instead of what actually went wrong.
              try {
                const writtenValues: Record<string, unknown> = {};
                for (const key of Object.keys(priorValues)) {
                  if (key in values) writtenValues[key] = (values as Record<string, unknown>)[key];
                }
                const { data: rolledBack, error: rollbackDbError } = await supabase
                  .from("assignments")
                  .update(priorValues)
                  .eq("id", Number.parseInt(assignment_id as string))
                  .match(writtenValues)
                  .select("id");
                if (rollbackDbError) throw rollbackDbError;
                if ((rolledBack ?? []).length === 0) {
                  console.warn(
                    "Not rolling back the assignment: it no longer holds the values this save wrote, so another " +
                      "save has superseded it."
                  );
                }
              } catch (rollbackError) {
                console.error("Failed to roll back the assignment after a sync failure", rollbackError);
              }
            }
            // autograder.workflow_sha lives on a different table and was already rewritten
            // from the NEW handout's grade.yml by githubRepoConfigureWebhook before
            // reconciliation ran. Restoring template_repo without it leaves the old handout
            // paired with the new handout's hash, and every Actions run is then rejected for
            // a workflow-sha mismatch. Re-derive it from the handout being restored rather
            // than trying to remember the old value.
            // Recomputed rather than reused: the flag of the same name is scoped to the try
            // block above. Same comparison — the handout the row was loaded with against the
            // one this save committed.
            const handoutWasReplaced =
              queryData?.template_repo !== undefined && queryData.template_repo !== values.template_repo;
            if (handoutWasReplaced && queryData?.template_repo) {
              try {
                await githubRepoConfigureWebhook(
                  {
                    assignment_id: Number.parseInt(assignment_id as string),
                    new_repo: queryData.template_repo,
                    watch_type: "template_repo"
                  },
                  supabase
                );
              } catch (hashRollbackError) {
                console.error(
                  "Failed to restore the autograder workflow hash for the previous handout",
                  hashRollbackError
                );
              }
            }
            throw syncError;
          }
        }
        toaster.create({
          title: "Assignment Updated",
          description: "The assignment has been successfully updated.",
          type: "success"
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        toaster.create({
          title: "Update Error",
          description: `Failed to update the assignment: ${errorMessage}`,
          type: "error"
        });
      }
    },
    [form.refineCore, assignment_id, course_id, selfReviewSettingId, update, updateAsync, queryData?.has_autograder]
  );

  if (form.refineCore.query?.error) {
    return <div>Error: {form.refineCore.query.error.message}</div>;
  }
  return (
    <Box>
      <Heading size="md">Edit Assignment</Heading>
      <AssignmentForm form={form} onSubmit={onFinish} />
    </Box>
  );
}
