"use client";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { useForm } from "@refinedev/react-hook-form";
import { useRouter, useParams } from "next/navigation";
import { useCallback } from "react";
import CreateAssignment from "./form";
import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
export default function NewAssignmentPage() {
  const { course_id } = useParams();
  const form = useForm<Assignment>({ refineCoreProps: { resource: "assignments", action: "create" } });
  const router = useRouter();
  const { getValues } = form;
  const onSubmit = useCallback(async () => {
    async function create() {
      const supabase = createClient();
      // console.log(getValues("submission_files"));
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
        .select("id")
        .single();
      if (error || !data) {
        console.error(error);
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
