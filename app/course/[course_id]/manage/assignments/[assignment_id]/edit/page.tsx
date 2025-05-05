"use client";

import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Skeleton } from "@chakra-ui/react";
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

  useEffect(() => {
    if (form.refineCore.query?.data?.data) {
      form.reset(form.refineCore.query.data.data);
    }
  }, [form]);

  const onFinish = useCallback(
    async (values: FieldValues) => {
      const supabase = createClient();
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
