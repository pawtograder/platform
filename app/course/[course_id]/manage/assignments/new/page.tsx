"use client";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { useForm } from "@refinedev/react-hook-form";
import { useRouter, useParams } from "next/navigation";
import { useCallback } from "react";
import CreateAssignment from "./form";
import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { toaster } from "@/components/ui/toaster";
import { useCreate } from "@refinedev/core";
import { interval } from "date-fns";
import { useClassProfiles } from "@/hooks/useClassProfiles";

export default function NewAssignmentPage() {
  const { course_id } = useParams();
  const form = useForm<Assignment>({ refineCoreProps: { resource: "assignments", action: "create" } });
  const router = useRouter();
  const { getValues } = form;
  const {mutate, mutateAsync} = useCreate();
  const {profiles:classProfiles} = useClassProfiles();
  const onSubmit = useCallback(async () => {
    async function create() {
      const supabase = createClient();
      // create the self eval configuration first 
      const settings = await mutateAsync({
        resource:"self_review_settings",
        values: {
          enabled:getValues("eval_config") === "use_eval",
          deadline_offset:getValues("deadline_offset"),
          allow_early:getValues("allow_early"),
          class_id:course_id
        }
      });
      if(!settings.data.id) {
        return;
      }
    
      const { data, error } = await supabase
        .from("assignments")
        .insert({
          title: getValues("title"),
          slug: getValues("slug"),
          release_date: getValues("release_date"),
          due_date: getValues("due_date"),
          allow_late: getValues("allow_late"),
          description: getValues("description"),
          max_late_tokens: getValues("max_late_tokens") || null,
          total_points: getValues("total_points"),
          template_repo: getValues("template_repo"),
          submission_files: getValues("submission_files"),
          class_id: Number.parseInt(course_id as string),
          group_config: getValues("group_config"),
          min_group_size: getValues("min_group_size") || null,
          max_group_size: getValues("max_group_size") || null,
          allow_student_formed_groups: getValues("allow_student_formed_groups"),
          group_formation_deadline: getValues("group_formation_deadline") || null
        })
        .select("id, self_review_rubric_id")
        .single();
      if (error || !data) {
        toaster.error({
          title: "Error creating assignment: " + error.name,
          description: error.message
        });
      } else {
        await githubRepoConfigureWebhook(
          { assignment_id: data.id, new_repo: getValues("template_repo"), watch_type: "template_repo" },
          supabase
        );
        //Potentially copy groups from another assignment
        if (getValues("copy_groups_from_assignment")) {
          await assignmentGroupCopyGroupsFromAssignment(
            {
              source_assignment_id: getValues("copy_groups_from_assignment"),
              target_assignment_id: data.id,
              class_id: Number.parseInt(course_id as string)
            },
            supabase
          );
        }
        router.push(`/course/${course_id}/manage/assignments/${data.id}/autograder`);
      }
    }
    await create();
  }, [course_id, getValues, router]);
  return <CreateAssignment form={form} onSubmit={onSubmit} />;
}
