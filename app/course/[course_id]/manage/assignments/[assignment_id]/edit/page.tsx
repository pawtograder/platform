"use client";

import { toaster } from "@/components/ui/toaster";
import { assignmentGroupCopyGroupsFromAssignment, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { enumerateDeadlineRegradeCandidates, fetchRegradeCandidates } from "@/lib/deadlineRegrade";
import { revalidateCourseDerivedCachesClient } from "@/lib/revalidateCourseDerivedCachesClient";
import { createClient } from "@/utils/supabase/client";
import { Assignment, SelfReviewSettings } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Dialog, Heading, Text } from "@chakra-ui/react";
import { useOne, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
  const router = useRouter();
  // When the deadline is extended, offer to review late commits for re-grading.
  const [regradePrompt, setRegradePrompt] = useState<{ batchId: number; count: number } | null>(null);

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

        // If the deadline moved later, offer to re-grade late commits. This is
        // best-effort: any failure here must not fail the assignment update.
        try {
          const oldDue = data?.data.due_date;
          const newDue = values.due_date as string | undefined;
          if (oldDue && newDue && new Date(newDue).getTime() > new Date(oldDue).getTime()) {
            const batchId = await enumerateDeadlineRegradeCandidates(supabase, {
              assignment_id: Number.parseInt(assignment_id as string),
              old_due_date: oldDue
            });
            const rows = await fetchRegradeCandidates(supabase, batchId);
            if (rows.length > 0) {
              setRegradePrompt({ batchId, count: rows.length });
            }
          }
        } catch (regradeError) {
          // Surface softly; the deadline change itself succeeded.
          toaster.create({
            title: "Could not scan for late commits",
            description: regradeError instanceof Error ? regradeError.message : "Unknown error",
            type: "warning"
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        toaster.create({
          title: "Update Error",
          description: `Failed to update the assignment: ${errorMessage}`,
          type: "error"
        });
      }
    },
    [form.refineCore, assignment_id, course_id, data?.data.self_review_setting_id, data?.data.due_date, update]
  );

  if (form.refineCore.query?.error) {
    return <div>Error: {form.refineCore.query.error.message}</div>;
  }
  return (
    <Box>
      <Heading size="md">Edit Assignment</Heading>
      <AssignmentForm form={form} onSubmit={onFinish} />

      <Dialog.Root open={regradePrompt !== null} onOpenChange={(d) => !d.open && setRegradePrompt(null)}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Re-grade late commits?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text>
                You extended this assignment&apos;s deadline. {regradePrompt?.count} student
                {regradePrompt?.count === 1 ? "" : "s"}/group(s) pushed a commit after the old deadline that was never
                graded. Would you like to review those commits and decide which to accept for grading? You&apos;ll see a
                before/after score and nothing changes until you promote a commit.
              </Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => setRegradePrompt(null)}>
                Not now
              </Button>
              <Button
                colorPalette="blue"
                onClick={() => {
                  const batchId = regradePrompt?.batchId;
                  setRegradePrompt(null);
                  if (batchId) {
                    router.push(
                      `/course/${course_id}/manage/assignments/${assignment_id}/regrade-late-commits?batch=${batchId}`
                    );
                  }
                }}
              >
                Review late commits
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Box>
  );
}
