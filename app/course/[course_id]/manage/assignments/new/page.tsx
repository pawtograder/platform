"use client";
import { toaster } from "@/components/ui/toaster";
import { assignmentCreateHandoutRepo, assignmentCreateSolutionRepo } from "@/lib/edgeFunctions";
import { revalidateCourseDerivedCachesClient } from "@/lib/revalidateCourseDerivedCachesClient";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { useCreate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";
import type { FieldValues } from "react-hook-form";
import CreateAssignment from "./form";
import { Box, Heading, Text } from "@chakra-ui/react";

export default function NewAssignmentPage() {
  const { course_id } = useParams();
  const form = useForm<Assignment>({
    refineCoreProps: { resource: "assignments", action: "create" },
    defaultValues: {
      allow_not_graded_submissions: true,
      permit_empty_submissions: false,
      require_tokens_before_due_date: true,
      // Default the group-formation method so the Groups subform's <select>
      // reflects a real selection instead of an empty (apparently unselected)
      // value. `false` = instructor-formed groups, matching how the rest of the
      // app treats an unset value (`allow_student_formed_groups !== true`).
      allow_student_formed_groups: false,
      repo_mode: "template_only_staff",
      protect_block_force_push: true,
      protect_require_pull_request: false,
      protect_required_reviewers: 0
    }
  });
  const router = useRouter();
  const { getValues } = form;

  const { mutateAsync } = useCreate();
  // `values` arrives from the shared form's `onSubmitWrapper`, which has already run every
  // datetime-local field through `appendTimezoneOffset(..., course time zone)`. Read the dates
  // from here rather than re-deriving them from `getValues()`: a naive "2026-09-01T09:00" has no
  // offset, so `new Date`/`TZDate` string parsing anchors it to the *browser's* zone and shifts
  // the wall clock whenever the instructor is not sitting in the course time zone (#890).
  const onSubmit = useCallback(
    async (values: FieldValues) => {
      async function create() {
        const repoMode = getValues("repo_mode") || "template_only_staff";
        const isNoRepo = repoMode === "none" || repoMode === "no_submission";
        const isPr = getValues("submission_mode") === "pr";
        const willCreateRepos = !isNoRepo;

        // Show loading toast before starting the process
        const loadingToast = toaster.create({
          title: "Creating Assignment",
          description: willCreateRepos
            ? "Creating GitHub repositories for handout and grader... This may take a few moments."
            : "Setting up assignment...",
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
                release_at: isEnabled && values.self_review_release_at ? values.self_review_release_at : null,
                class_id: course_id
              }
            },
            {
              onError: (error) => {
                toaster.error({ title: "Error creating self review settings", description: error.message });
              }
            }
          );

          // A successful response with no id never reaches the cleanup below, so without this the
          // loading toast would stay up forever and the 5-second timer would still rewrite it to
          // "Finishing up..." for a creation that never started. (`onError` only covers throws.)
          if (!settings.data.id) {
            clearTimeout(messageUpdateTimer);
            toaster.dismiss(loadingToast);
            toaster.error({
              title: "Error creating assignment",
              description: "Self review settings were not created. Please try again."
            });
            return;
          }

          const isFork = repoMode === "fork_from_prior_assignment";
          // PR-mode identification: "branch_convention" is only meaningful with a non-empty
          // regex. If the convention is blank, fall back to "base_branch" so we never persist an
          // internally inconsistent config (branch_convention with no rule to match the PR).
          const prBranchConvention = isPr ? (getValues("pr_branch_convention") || "").trim() || null : null;
          const prIdentification = isPr
            ? getValues("pr_identification") === "branch_convention" && !prBranchConvention
              ? "base_branch"
              : getValues("pr_identification") || "base_branch"
            : "base_branch";
          const { data, error } = await supabase
            .from("assignments")
            .insert({
              title: getValues("title"),
              slug: getValues("slug"),
              release_date: values.release_date ?? "",
              due_date: values.due_date ?? "",
              suggested_due_date: values.suggested_due_date ?? null,
              allow_late: getValues("allow_late"),
              description: getValues("description"),
              max_late_tokens: getValues("max_late_tokens") || null,
              require_tokens_before_due_date: getValues("require_tokens_before_due_date") !== false,
              allow_not_graded_submissions: getValues("allow_not_graded_submissions"),
              permit_empty_submissions: false,
              total_points: getValues("total_points"),
              template_repo: isNoRepo ? null : getValues("template_repo"),
              submission_files: getValues("submission_files"),
              // has_autograder must reflect reality (it gates the webhook's autograder run and the
              // results-page empty state). The form provisions a grader/solution repo only for repo
              // modes, so no-repo modes ('none'/'no_submission') have no autograder. Instructors can
              // still toggle this on the autograder config page.
              has_autograder: !isNoRepo,
              has_handgrader: true,
              class_id: Number.parseInt(course_id as string),
              group_config: getValues("group_config"),
              min_group_size: getValues("min_group_size") || null,
              max_group_size: getValues("max_group_size") || null,
              allow_student_formed_groups: getValues("allow_student_formed_groups"),
              enable_repo_analytics: getValues("enable_repo_analytics") || false,
              grader_pseudonymous_mode: getValues("grader_pseudonymous_mode") || false,
              show_leaderboard: getValues("show_leaderboard") || false,
              minutes_due_after_lab:
                getValues("minutes_due_after_lab") === null ||
                getValues("minutes_due_after_lab") === undefined ||
                (getValues("minutes_due_after_lab") as unknown as string) === ""
                  ? null
                  : getValues("minutes_due_after_lab"),
              regrade_deadline: values.regrade_deadline ?? null,
              self_review_setting_id: settings.data.id as number,
              group_formation_deadline: values.group_formation_deadline ?? null,
              repo_mode: repoMode,
              source_assignment_id: isFork ? getValues("source_assignment_id") || null : null,
              // DB constraint `assignments_no_protection_when_no_repo` rejects non-default
              // protect_* when repo_mode is none/no_submission, so coerce here rather than
              // surfacing a constraint error from the disabled-but-still-set checkboxes.
              protect_block_force_push: isNoRepo ? false : getValues("protect_block_force_push") !== false,
              protect_require_pull_request: isNoRepo ? false : getValues("protect_require_pull_request") === true,
              protect_required_reviewers: isNoRepo ? 0 : Number(getValues("protect_required_reviewers") || 0),
              // Submission-mode axis. Only persist the upstream/PR config when the
              // instructor actually selected PR mode; otherwise leave the columns at
              // their push-mode defaults.
              submission_mode: isPr ? "pr" : "push",
              // Option A: the upstream repo IS the handout (template_repo). At
              // create time template_repo is usually null (the handout is created
              // afterwards, where the edge function points upstream_repo at it);
              // for inherited/fork modes it may already be set, so carry it here.
              upstream_repo: isPr ? getValues("template_repo") || null : null,
              upstream_base_branch: isPr ? getValues("upstream_base_branch") || "main" : "main",
              pr_identification: prIdentification,
              pr_branch_convention: prBranchConvention,
              require_pr_open: isPr ? getValues("require_pr_open") === true : false
            })
            .select("id")
            .single();
          if (error || !data) {
            toaster.error({
              title: "Error creating assignment: " + error.name,
              description: error.message
            });
          } else {
            if (!isNoRepo) {
              await assignmentCreateHandoutRepo(
                { assignment_id: data.id, class_id: Number.parseInt(course_id as string) },
                supabase
              );
              await assignmentCreateSolutionRepo(
                { assignment_id: data.id, class_id: Number.parseInt(course_id as string) },
                supabase
              );
            }

            // Clear the timer and dismiss the loading toast
            clearTimeout(messageUpdateTimer);
            toaster.dismiss(loadingToast);
            toaster.create({
              title: "Assignment Created Successfully",
              description: willCreateRepos
                ? "GitHub repositories have been created and the assignment is ready."
                : "The assignment is ready.",
              type: "success"
            });

            void revalidateCourseDerivedCachesClient(Number.parseInt(course_id as string, 10));
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
    },
    [course_id, getValues, router, mutateAsync]
  );
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
