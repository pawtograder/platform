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
            // migration leaves it false whenever there is no grader_repo. PR mode is
            // excluded outright: its submissions never run Actions, so the handout's
            // workflow is irrelevant, and the handout doubles as the upstream students
            // fork — not something to rewrite as a side effect of an unrelated edit.
            const autograderFlagChanged =
              queryData?.has_autograder !== undefined && queryData.has_autograder !== values.has_autograder;
            if (autograderFlagChanged && values.submission_mode !== "pr") {
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
            const prior = queryData?.has_autograder;
            if (prior !== undefined && prior !== values.has_autograder) {
              // Awaited: a fire-and-forget rollback would let the error toast claim
              // the save failed while the row keeps the new flag, which is the exact
              // disagreement this rollback exists to prevent.
              await updateAsync({
                resource: "assignments",
                id: Number.parseInt(assignment_id as string),
                values: { has_autograder: prior }
              });
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
