"use client";

import { toaster } from "@/components/ui/toaster";
import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment, SelfReviewSettings } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Skeleton } from "@chakra-ui/react";
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
      console.log(selfReviewSetting?.data.enabled);
      form.setValue("eval_config", selfReviewSetting?.data.enabled ? "use_eval" : "base_only");
      form.setValue("deadline_offset", selfReviewSetting?.data.deadline_offset);
      form.setValue("allow_early", selfReviewSetting?.data.allow_early);
    }
  }, [queryData, form]);

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
        await form.refineCore.onFinish(values);
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
    [form.refineCore, assignment_id, course_id]
  );

  if (form.refineCore.query?.isLoading || form.refineCore.formLoading) {
    return <Skeleton height="100vh" />;
  }
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
