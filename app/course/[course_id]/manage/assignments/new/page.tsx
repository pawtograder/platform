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
      has_autograder: true,
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

        // Validate the fork/source autograder agreement BEFORE inserting anything.
        // assignment-create-handout-repo rejects this mismatch, but by then the
        // assignment and its self-review settings already exist and nothing deletes
        // them — the instructor is left with a partial assignment that has no handout.
        // The form warns about this inline; this is the enforcement.
        if (repoMode === "fork_from_prior_assignment") {
          const sourceId = getValues("source_assignment_id");
          if (sourceId) {
            const supabase = createClient();
            const { data: source, error: sourceError } = await supabase
              .from("assignments")
              .select("title, has_autograder")
              .eq("id", Number(sourceId))
              .maybeSingle();
            // Fail CLOSED on a failed or empty lookup. Ignoring the error left `source`
            // null, the guard passed, and creation proceeded into exactly the partial
            // assignment this check exists to prevent.
            if (sourceError || !source) {
              toaster.error({
                title: "Could not read the source assignment",
                description:
                  `This assignment forks from another assignment, but that assignment could not be read` +
                  `${sourceError ? `: ${sourceError.message}` : " (not found, or not visible to you)"}. ` +
                  `Nothing was created — please re-select the source assignment and try again.`
              });
              return;
            }
            const wantsAutograder = !isNoRepo && !isPr && getValues("has_autograder") !== false;
            if ((source.has_autograder !== false) !== wantsAutograder) {
              // Say WHY when the mode, not the checkbox, forces the mismatch. PR mode and
              // the no-repo modes pin wantsAutograder to false, so against an autograded
              // source neither checkbox state satisfies this test — telling the instructor
              // to "make them match" would send them round a loop with no way out.
              const modeForcesOff = isNoRepo || isPr;
              toaster.error({
                title: "Autograder setting must match the source assignment",
                description:
                  `This assignment forks from "${source.title}", so both share that assignment's handout ` +
                  `repository and must have the same autograder setting. "${source.title}" has the autograder ` +
                  `${source.has_autograder === false ? "disabled" : "enabled"}. ` +
                  (modeForcesOff && source.has_autograder !== false
                    ? isPr
                      ? `This assignment submits by pull request, and those submissions are graded without GitHub Actions, ` +
                        `so it cannot have an autograder. Choose a source assignment with the autograder disabled, or a ` +
                        `repository configuration that gives this assignment its own handout. `
                      : `This assignment has no student repository, so it cannot have an autograder. Choose a source ` +
                        `assignment with the autograder disabled, or a repository configuration that creates repos. `
                    : "") +
                  `Nothing was created.`
              });
              return;
            }
          }
        }

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
          // Optional chaining because a policy that permits INSERT but not SELECT on the new row
          // yields a resolved mutation with no `data` at all, and throwing here would replace the
          // message below with an unactionable "cannot read properties of undefined".
          const selfReviewSettingId = settings?.data?.id;
          if (!selfReviewSettingId) {
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
              // `|| null`, not `?? null`: a cleared `datetime-local` reports "", which
              // `appendTimezoneOffset` passes straight through, and "" is not nullish — so `??`
              // would send an empty string to a timestamptz column and Postgres would reject the
              // whole insert with "invalid input syntax for type timestamp with time zone".
              release_date: values.release_date || "",
              due_date: values.due_date || "",
              suggested_due_date: values.suggested_due_date || null,
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
              // results-page empty state). No-repo modes ('none'/'no_submission') can never have one
              // — the autograder runs as a GitHub Actions workflow inside the student repo. PR mode
              // cannot either: those submissions are ingested by the PR webhook and never produce
              // grader_results, which is why the backfill migration excludes them too. Otherwise
              // it's the instructor's choice: unchecking it gives a "repo only" assignment (#895),
              // where the handout is created without grade.yml so no Actions ever run. Instructors
              // can still toggle this later on the autograder config page.
              has_autograder: !isNoRepo && !isPr && getValues("has_autograder") !== false,
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
              regrade_deadline: values.regrade_deadline || null,
              self_review_setting_id: selfReviewSettingId as number,
              group_formation_deadline: values.group_formation_deadline || null,
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
            // Same cleanup as the success and catch paths: without it the loading toast never goes
            // away and the 5-second timer still rewrites it to "Finishing up..." for an insert that
            // already failed. `error` is read defensively because the condition also covers the
            // no-error-but-no-row case.
            clearTimeout(messageUpdateTimer);
            toaster.dismiss(loadingToast);
            toaster.error({
              title: "Error creating assignment",
              description: error?.message ?? "The assignment was not created. Please try again."
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
