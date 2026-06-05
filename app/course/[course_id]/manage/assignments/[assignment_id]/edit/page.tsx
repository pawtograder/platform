"use client";

import { toaster } from "@/components/ui/toaster";
import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
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
  const { mutate: update } = useUpdate();

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
        if (values.copy_groups_from_assignment !== undefined) {
          if (values.copy_groups_from_assignment !== "") {
            await assignmentGroupCopyGroupsFromAssignment(
              {
                source_assignment_id: values.copy_groups_from_assignment,
                target_assignment_id: Number.parseInt(assignment_id as string),
                class_id: Number.parseInt(course_id as string)
              },
              supabase
            );
          }
          delete values.copy_groups_from_assignment;
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
        }
        if (values.repo_mode !== "fork_from_prior_assignment") {
          values.source_assignment_id = null;
        }
        // Clear PR/upstream config when not in PR submission mode so toggling
        // back to push doesn't leave stale upstream values behind.
        if (values.submission_mode !== "pr") {
          values.upstream_repo = null;
          values.pr_branch_convention = null;
          values.require_pr_open = false;
        }
        await form.refineCore.onFinish(values);
        await revalidateCourseDerivedCachesClient(Number.parseInt(course_id as string, 10));
        if (values.template_repo) {
          await githubRepoConfigureWebhook(
            {
              assignment_id: Number.parseInt(assignment_id as string),
              new_repo: values.template_repo,
              watch_type: "template_repo"
            },
            supabase
          );
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
    [form.refineCore, assignment_id, course_id, data?.data.self_review_setting_id, update]
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
