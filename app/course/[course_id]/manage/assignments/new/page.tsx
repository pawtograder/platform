"use client";
import { toaster } from "@/components/ui/toaster";
import { useCourse } from "@/hooks/useCourseController";
import {
  assignmentCreateHandoutRepo,
  assignmentCreateSolutionRepo,
  assignmentGroupCopyGroupsFromAssignment
} from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { useCreate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";
import CreateAssignment from "./form";
import { Box, Heading, Text } from "@chakra-ui/react";

export default function NewAssignmentPage() {
  const { course_id } = useParams();
  const form = useForm<Assignment>({
    refineCoreProps: { resource: "assignments", action: "create" },
    defaultValues: {
      allow_not_graded_submissions: true,
      permit_empty_submissions: true
    }
  });
  const router = useRouter();
  const { getValues } = form;
  const { time_zone } = useCourse();
  const timezone = time_zone || "America/New_York";

  const { mutateAsync } = useCreate();
  const onSubmit = useCallback(async () => {
    async function create() {
      // Show loading toast before starting the process
      const loadingToast = toaster.create({
        title: "Creating Assignment",
        description: "Creating GitHub repositories for handout and grader... This may take a few moments.",
        type: "loading"
      });

      // Update the message after 5 seconds
      const messageUpdateTimer = setTimeout(() => {
        if (loadingToast) {
          toaster.update(loadingToast, {
            title: "Creating Assignment",
            description: "Finishing up creating assignment resources...",
            type: "loading"
          });
        }
      }, 5000);

      try {
        const supabase = createClient();
        // create the self eval configuration first
        const isEnabled = getValues("eval_config") === "use_eval";
        const settings = await mutateAsync(
          {
            resource: "assignment_self_review_settings",
            values: {
              enabled: isEnabled,
              deadline_offset: isEnabled ? getValues("deadline_offset") : null,
              allow_early: isEnabled ? getValues("allow_early") : null,
              class_id: course_id
            }
          },
          {
            onError: (error) => {
              toaster.error({ title: "Error creating self review settings", description: error.message });
            }
          }
        );

        if (!settings.data.id) {
          return;
        }

        const { data, error } = await supabase
          .from("assignments")
          .insert({
            title: getValues("title"),
            slug: getValues("slug"),
            release_date: getValues("release_date")
              ? new TZDate(getValues("release_date"), timezone).toISOString()
              : "",
            due_date: getValues("due_date") ? new TZDate(getValues("due_date"), timezone).toISOString() : "",
            allow_late: getValues("allow_late"),
            description: getValues("description"),
            max_late_tokens: getValues("max_late_tokens") || null,
            allow_not_graded_submissions: getValues("allow_not_graded_submissions"),
            permit_empty_submissions: getValues("permit_empty_submissions") !== false,
            total_points: getValues("total_points"),
            template_repo: getValues("template_repo"),
            submission_files: getValues("submission_files"),
            has_autograder: true,
            has_handgrader: true,
            class_id: Number.parseInt(course_id as string),
            group_config: getValues("group_config"),
            min_group_size: getValues("min_group_size") || null,
            max_group_size: getValues("max_group_size") || null,
            allow_student_formed_groups: getValues("allow_student_formed_groups"),
            self_review_setting_id: settings.data.id as number,
            group_formation_deadline: getValues("group_formation_deadline")
              ? new TZDate(getValues("group_formation_deadline"), timezone).toISOString()
              : null
          })
          .select("id")
          .single();
        if (error || !data) {
          toaster.error({
            title: "Error creating assignment: " + error.name,
            description: error.message
          });
        } else {
          await assignmentCreateHandoutRepo(
            { assignment_id: data.id, class_id: Number.parseInt(course_id as string) },
            supabase
          );
          await assignmentCreateSolutionRepo(
            { assignment_id: data.id, class_id: Number.parseInt(course_id as string) },
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

          // Clear the timer and dismiss the loading toast
          clearTimeout(messageUpdateTimer);
          toaster.dismiss(loadingToast);
          toaster.create({
            title: "Assignment Created Successfully",
            description: "GitHub repositories have been created and the assignment is ready.",
            type: "success"
          });

          router.push(`/course/${course_id}/manage/assignments/${data.id}/autograder`);
        }
      } catch (error) {
        // Clear the timer and dismiss the loading toast
        clearTimeout(messageUpdateTimer);
        toaster.dismiss(loadingToast);
        toaster.error({
          title: "Error creating assignment",
          description: error instanceof Error ? error.message : "An unexpected error occurred"
        });
      }
    }
    await create();
  }, [course_id, getValues, router, mutateAsync, timezone]);
  return (
    <Box p={4}>
      <Heading size="lg">Create New Assignment</Heading>
      <Text fontSize="sm" color="fg.muted" maxW="4xl">
        Create a new programming assignment for your course. Each student will automatically have a GitHub repository
        created for them to submit their work, and a new gradebook column will be created to track grades. After
        creating the assignment, you will be able to customize the grading configuration further and edit the handout
        and grader repositories.
      </Text>
      <CreateAssignment form={form} onSubmit={onSubmit} />
    </Box>
  );
}
