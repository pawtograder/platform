"use client";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { useCourse } from "@/hooks/useCourseController";
import {
  cloudWorkspacesEnabled,
  forgejoChoiceUnavailableReason,
  forgejoConflicts,
  GIT_PROVIDER_LABELS,
  hostLockReason,
  showRepositoryHostPicker,
  type GitProviderName,
  type HostLockState,
  type SavedHostValues
} from "@/lib/gitProviderOptions";
import { createClient } from "@/utils/supabase/client";
import { Assignment, CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Fieldset, NativeSelectField, NativeSelectRoot, Text } from "@chakra-ui/react";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useEffect, useRef, useState } from "react";
import { Controller } from "react-hook-form";

/** The row the edit form was loaded with, or undefined on the create form. */
export function useSavedAssignment(form: UseFormReturnType<Assignment>): Assignment | undefined {
  return form.refineCore.query?.data?.data as Assignment | undefined;
}

/** The current host choice. Falls back to GitHub when unset. */
export function useSelectedGitProvider(form: UseFormReturnType<Assignment>): string {
  return form.watch("git_provider") ?? "github";
}

/**
 * Keeps a new assignment's `git_provider` synced to the course default until the instructor
 * changes it manually. Never called on the edit form, so existing assignments keep their host.
 */
export function useSyncCourseDefaultGitProvider(
  form: UseFormReturnType<Assignment>,
  courseDefaultProvider: GitProviderName
): void {
  const { watch, getValues, setValue } = form;
  const userChoseRef = useRef(false);
  const syncingRef = useRef(false);

  useEffect(() => {
    const subscription = watch((_values, { name }) => {
      if (name === "git_provider" && !syncingRef.current) {
        userChoseRef.current = true;
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  useEffect(() => {
    if (userChoseRef.current) return;
    if (getValues("git_provider") === courseDefaultProvider) return;
    syncingRef.current = true;
    try {
      setValue("git_provider", courseDefaultProvider, { shouldDirty: false });
    } finally {
      syncingRef.current = false;
    }
  }, [courseDefaultProvider, getValues, setValue]);
}

/**
 * Reads what the database lock checks: the handout and grader pointers, repository rows, and
 * assignments that fork from this one. Until the answer arrives the picker stays locked.
 */
function useHostLockState(saved: Assignment | undefined): HostLockState {
  const assignmentId = saved?.id;
  const templateRepo = saved?.template_repo;
  const [state, setState] = useState<HostLockState>({ status: assignmentId ? "loading" : "new" });
  useEffect(() => {
    if (!assignmentId) {
      setState({ status: "new" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const supabase = createClient();
    Promise.all([
      supabase.from("repositories").select("id", { count: "exact", head: true }).eq("assignment_id", assignmentId),
      supabase.from("autograder").select("grader_repo").eq("id", assignmentId).maybeSingle(),
      supabase.from("assignments").select("id", { count: "exact", head: true }).eq("source_assignment_id", assignmentId)
    ]).then(
      ([repositories, autograder, forkTargets]) => {
        if (cancelled) return;
        if (
          repositories.error ||
          autograder.error ||
          forkTargets.error ||
          repositories.count === null ||
          forkTargets.count === null
        ) {
          setState({ status: "error" });
          return;
        }
        setState({
          status: "loaded",
          facts: {
            templateRepo,
            graderRepo: autograder.data?.grader_repo,
            repositoryCount: repositories.count,
            forkTargetCount: forkTargets.count
          }
        });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [assignmentId, templateRepo]);
  return state;
}

/**
 * Repository host picker for Create and Edit Assignment (#1091). Shown for code assignments in a
 * course with Cloud workspaces on. Self-contained so Forgejo handout creation can extend it.
 */
export default function RepositoryHostPicker({ form }: { form: UseFormReturnType<Assignment> }) {
  const course = useCourse() as CourseWithFeatures | undefined;
  const flagEnabled = cloudWorkspacesEnabled(course?.features);
  const saved = useSavedAssignment(form);
  const savedHost: SavedHostValues | undefined = saved;
  const provider = useSelectedGitProvider(form);
  const assignmentType = form.watch("assignment_type");
  const repoMode = form.watch("repo_mode");
  const submissionMode = form.watch("submission_mode");
  const lockState = useHostLockState(saved);

  const visible = showRepositoryHostPicker({ flagEnabled, assignmentType, savedProvider: saved?.git_provider });
  const lockReason = hostLockReason(lockState);
  const forgejoReason = forgejoChoiceUnavailableReason({ flagEnabled, savedProvider: saved?.git_provider });
  const conflicts = visible
    ? forgejoConflicts(provider, { repo_mode: repoMode, submission_mode: submissionMode }, savedHost)
    : [];

  // The validate rule is registered once, so it reads the current conflicts through a ref.
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;

  if (!visible) return null;

  return (
    <Fieldset.Content>
      <Controller
        name="git_provider"
        control={form.control}
        rules={{ validate: () => conflictsRef.current[0] ?? true }}
        render={({ field, fieldState }) => (
          <Field
            label="Repository host"
            helperText={
              lockReason ??
              "Where student repositories for this assignment live. The host can't change once repositories exist."
            }
            errorText={fieldState.error?.message}
            invalid={!!fieldState.error}
            // Field.Root passes disabled down to the select element; NativeSelectRoot alone doesn't.
            disabled={!!lockReason}
          >
            <NativeSelectRoot>
              <NativeSelectField
                name={field.name}
                ref={field.ref}
                value={field.value ?? "github"}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                aria-label="Repository host"
              >
                <option value="github">{GIT_PROVIDER_LABELS.github}</option>
                <option value="forgejo" disabled={!!forgejoReason}>
                  {GIT_PROVIDER_LABELS.forgejo}
                  {forgejoReason ? ` (${forgejoReason})` : ""}
                </option>
              </NativeSelectField>
            </NativeSelectRoot>
          </Field>
        )}
      />
      {provider === "forgejo" && (
        <Alert status="info" title="Forgejo assignments" mt={2}>
          <Text>
            Options Forgejo doesn&apos;t support yet are disabled below, with the reason. Forgejo assignments can&apos;t
            be deleted yet; while no repositories exist, switch the host back to GitHub first.
          </Text>
        </Alert>
      )}
      {conflicts.length > 0 && (
        <Text fontSize="sm" color="fg.error" mt={2} data-testid="repository-host-conflict">
          {conflicts.join(" ")}
        </Text>
      )}
    </Fieldset.Content>
  );
}
