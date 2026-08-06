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
  const { data } = useOne<Assignment>({ resource: "assignments", id: assignment_id as string });

  const { reset, refineCore } = form;
  const queryData = refineCore.query?.data?.data;
  const { mutate: update, mutateAsync: updateAsync } = useUpdate();

  useEffect(() => {
    if (queryData) {
      reset(queryData);
    }
  }, [queryData, reset]);

  const { data: selfReviewSetting } = useOne<SelfReviewSettings>({
    resource: "assignment_self_review_settings",
    id: queryData?.self_review_setting_id
  });
  useEffect(() => {
    if (queryData) {
      form.setValue("eval_config", selfReviewSetting?.data.enabled ? "use_eval" : "base_only");
      form.setValue("deadline_offset", selfReviewSetting?.data.deadline_offset);
      form.setValue("allow_early", selfReviewSetting?.data.allow_early);
      form.setValue("self_review_release_at", selfReviewSetting?.data.release_at ?? null);
    }
  }, [
    queryData,
    form,
    selfReviewSetting?.data.allow_early,
    selfReviewSetting?.data.deadline_offset,
    selfReviewSetting?.data.enabled,
    selfReviewSetting?.data.release_at
  ]);

  const onFinish = useCallback(
    async (values: FieldValues) => {
      try {
        const supabase = createClient();
        if (values) {
          const isEnabled = values.eval_config == "use_eval";
          update(
            {
              resource: "assignment_self_review_settings",
              id: data?.data.self_review_setting_id,
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
            if (needsWorkflowSync && (isDisabling || values.submission_mode !== "pr")) {
              const syncResult = await assignmentSyncAutograderWorkflow(
                {
                  assignment_id: Number.parseInt(assignment_id as string),
                  class_id: Number.parseInt(course_id as string)
                },
                supabase
              );
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
            // Clamp the restored value to what the row NOW allows. `onFinish` above has
            // already committed the coerced fields, so restoring the raw prior flag onto
            // a row that is now PR mode (or a no-repo mode) would recreate exactly the
            // combination the coercions exist to prevent: a pr-mode assignment claiming
            // an autograder, whose students' forks then run a grade.yml the Actions path
            // rejects. Only a mode that can actually host an autograder gets `true` back.
            // Restore the MODE too, not just the flag. A push -> PR conversion commits
            // submission_mode, the upstream fields AND has_autograder=false in one
            // onFinish; clamping the flag against the newly-saved PR mode then derived
            // `prior = false` and restored nothing at all, leaving the assignment in PR
            // mode with a live workflow still in its handout while the UI reported the
            // update had failed. Rolling the mode back first makes the clamp evaluate
            // against the mode being restored, so the flag can come back too.
            const modeChanged =
              queryData?.submission_mode !== undefined &&
              (queryData.submission_mode !== values.submission_mode || queryData.repo_mode !== values.repo_mode);
            if (modeChanged) {
              try {
                await updateAsync({
                  resource: "assignments",
                  id: Number.parseInt(assignment_id as string),
                  values: {
                    submission_mode: queryData!.submission_mode,
                    repo_mode: queryData!.repo_mode,
                    upstream_repo: queryData!.upstream_repo,
                    upstream_base_branch: queryData!.upstream_base_branch,
                    pr_identification: queryData!.pr_identification,
                    pr_branch_convention: queryData!.pr_branch_convention,
                    require_pr_open: queryData!.require_pr_open
                  }
                });
              } catch (rollbackError) {
                console.error("Failed to roll back the submission mode after a sync failure", rollbackError);
              }
            }
            const restoredSubmissionMode = modeChanged ? queryData!.submission_mode : values.submission_mode;
            const restoredRepoMode = modeChanged ? queryData!.repo_mode : values.repo_mode;
            const modeAllowsAutograder =
              restoredSubmissionMode !== "pr" && restoredRepoMode !== "none" && restoredRepoMode !== "no_submission";
            const prior = queryData?.has_autograder === true && modeAllowsAutograder;
            if (queryData?.has_autograder !== undefined && prior !== values.has_autograder) {
              // Awaited: a fire-and-forget rollback would let the error toast claim
              // the save failed while the row keeps the new flag, which is the exact
              // disagreement this rollback exists to prevent.
              //
              // Guarded: an unhandled rejection here would replace `syncError`, so the
              // instructor would be told why the ROLLBACK failed and never learn what
              // actually went wrong.
              try {
                await updateAsync({
                  resource: "assignments",
                  id: Number.parseInt(assignment_id as string),
                  values: { has_autograder: prior }
                });
              } catch (rollbackError) {
                console.error("Failed to roll back has_autograder after a sync failure", rollbackError);
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
    [
      form.refineCore,
      assignment_id,
      course_id,
      data?.data.self_review_setting_id,
      update,
      updateAsync,
      queryData?.has_autograder
    ]
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
