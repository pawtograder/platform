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
import AssignmentForm, { AssignmentFormValues } from "../../new/form";

export default function EditAssignment() {
  const { course_id, assignment_id } = useParams();
  const form = useForm<AssignmentFormValues>({
    refineCoreProps: { resource: "assignments", action: "edit", id: Number.parseInt(assignment_id as string) }
  });
  const { data } = useOne<Assignment>({ resource: "assignments", id: assignment_id as string });

  const { reset, refineCore } = form;
  const queryData = refineCore.query?.data?.data;
  const { mutate: update } = useUpdate();

  useEffect(() => {
    if (queryData) {
      const values = queryData as AssignmentFormValues;
      reset({
        ...values,
        grading_default_profile_id: values.grading_default_profile_id ?? null,
        auto_assign_at_deadline: values.auto_assign_at_deadline ?? false,
        auto_assign_assignee_pool: values.auto_assign_assignee_pool ?? "graders",
        auto_assign_review_due_hours: values.auto_assign_review_due_hours ?? 72,
        late_grading_reminders_enabled: values.late_grading_reminders_enabled ?? false,
        late_grading_reminder_interval_hours: values.late_grading_reminder_interval_hours ?? 12,
        late_grading_reply_to: values.late_grading_reply_to ?? null,
        late_grading_cc_emails: values.late_grading_cc_emails ?? { emails: [] }
      });
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
    }
  }, [
    queryData,
    form,
    selfReviewSetting?.data.allow_early,
    selfReviewSetting?.data.deadline_offset,
    selfReviewSetting?.data.enabled
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
        values.late_grading_reminder_interval_hours = values.late_grading_reminders_enabled
          ? (values.late_grading_reminder_interval_hours ?? 12)
          : null;
        values.late_grading_reply_to = values.late_grading_reply_to || null;
        values.late_grading_cc_emails = values.late_grading_cc_emails || { emails: [] };
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
