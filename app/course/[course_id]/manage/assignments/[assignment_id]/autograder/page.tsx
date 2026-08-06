"use client";

import AutograderConfiguration from "@/components/ui/autograder-configuration";
import RepoFileEditor from "@/components/github/RepoFileEditor";
import { Field } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import { toaster } from "@/components/ui/toaster";
import { assignmentSyncAutograderWorkflow, githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { Assignment, AutograderWithAssignment } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import {
  Button,
  Fieldset,
  Heading,
  Input,
  Link,
  NativeSelectField,
  NativeSelectRoot,
  RadioGroup
} from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, FieldValues } from "react-hook-form";

export default function AutograderPage() {
  const { assignment_id, course_id } = useParams();
  const [loading, setLoading] = useState(false);
  const { mutateAsync: mutateAssignment } = useUpdate<Assignment>({
    resource: "assignments",
    id: Number.parseInt(assignment_id as string)
  });
  const {
    refineCore: { formLoading, query },
    register,
    handleSubmit,
    refineCore,
    control,
    watch,
    reset,
    setValue,
    formState: { errors }
  } = useForm<AutograderWithAssignment>({
    refineCoreProps: {
      action: "edit",
      resource: "autograder",
      id: Number.parseInt(assignment_id as string),
      meta: {
        select: "*, assignments(*)"
      }
    }
  });

  // Last value of has_autograder known to be persisted, used as the rollback
  // target when the workflow sync fails. It cannot come straight from `query`:
  // saving writes the `assignments` resource while this form reads the nested
  // `autograder` query, so `query` still holds the value from page load. On a
  // second toggle in the same visit that stale baseline would either skip the
  // rollback or restore the wrong value.
  const savedHasAutograder = useRef<boolean | undefined>(undefined);
  // Which assignment the ref describes. The App Router reuses this component across a
  // change of the [assignment_id] param, so refs survive client-side navigation — without
  // this, opening assignment A and then B would leave B's rollback baseline holding A's
  // value.
  const savedForAssignmentId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const data = query?.data?.data;
    if (!data) return;
    const currentId = assignment_id as string;
    // Re-seed on a new assignment, and also whenever the baseline is still unknown --
    // leaving it undefined would silently skip the rollback below.
    const reseed = savedForAssignmentId.current !== currentId || savedHasAutograder.current === undefined;
    if (reseed) {
      savedForAssignmentId.current = currentId;
      savedHasAutograder.current = data.assignments?.has_autograder;
      reset(data);
      return;
    }
    // Once we know what is persisted, that value wins over the nested `assignments`
    // payload. Saving writes the `assignments` resource but this form reads the
    // `autograder` query, and `onFinish` on the autograder row kicks off a refetch
    // BEFORE the flag is written — so the refetch lands carrying the pre-save flag.
    // Letting `reset` apply it snapped the radio back to the old setting after a
    // successful save, and the next save then wrote that stale value back to the DB
    // and pushed grade.yml into the handout again.
    reset({ ...data, assignments: { ...data.assignments, has_autograder: savedHasAutograder.current } });
  }, [query?.data?.data, reset, assignment_id]);

  const onSubmit = useCallback(
    async (values: FieldValues) => {
      const supabase = createClient();
      const priorHasAutograder = savedHasAutograder.current;
      const nextHasAutograder = values.assignments.has_autograder;

      // Only validate the grader repo when the autograder will REMAIN enabled.
      // This reads pawtograder.yml from that repo, so doing it unconditionally
      // meant a broken or missing grader repo blocked the save — making it
      // impossible to turn the autograder OFF precisely when an instructor most
      // needs to, while student pushes keep hitting the broken workflow.
      if (nextHasAutograder) {
        await githubRepoConfigureWebhook(
          {
            assignment_id: Number.parseInt(assignment_id as string),
            new_repo: values.grader_repo,
            watch_type: "grader_solution"
          },
          supabase
        );
      }

      // Save the autograder row FIRST. It is a plain DB write and the only step
      // here that can be retried cleanly, so doing it before the irreversible
      // GitHub work means a failure leaves nothing to unwind — previously it ran
      // last, so a rejected save reported "Changes not saved" while the flag and
      // the handout workflow had already been changed.
      //
      // Ordering alone is not enough, though: whichever write happens first is
      // still applied if a later one fails. So capture the row's prior values and
      // restore them alongside the flag in the catch below, otherwise a failed
      // disable would leave grader_repo/limits persisted while the UI said nothing
      // saved — the worst case being unvalidated config left behind, since
      // validation is deliberately skipped when disabling.
      const priorAutograderRow = {
        // `config` is captured too, because githubRepoConfigureWebhook(grader_solution)
        // above already parsed the NEW grader repo's pawtograder.yml and persisted it.
        // Restoring only grader_repo left that new config paired with the old repo while
        // the UI reported nothing saved — a mismatch that then drives real grading.
        config: query?.data?.data?.config ?? null,
        grader_repo: query?.data?.data?.grader_repo ?? null,
        max_submissions_count: query?.data?.data?.max_submissions_count ?? null,
        max_submissions_period_secs: query?.data?.data?.max_submissions_period_secs ?? null
      };
      const nextAutograderRow = {
        grader_repo: values.grader_repo,
        max_submissions_count: values.max_submissions_count || null,
        max_submissions_period_secs: values.max_submissions_period_secs || null
      };
      // Number-vs-string comparison: `register()` on a `<Input type="number">` yields a
      // string, so a plain `!==` against the number from the DB reported a change on every
      // save and fired a pointless rollback write.
      const sameLimit = (a: string | number | null, b: string | number | null) =>
        a === b || (a !== null && b !== null && Number(a) === Number(b));
      // The configure-webhook call above rewrites `autograder.config` server-side
      // whenever it runs, and `query` still holds the page-load value — so a change
      // cannot be detected by comparing the two. Treat "we ran the validation" as
      // "config may have been replaced" and roll it back on that basis.
      const graderConfigMayHaveChanged = nextHasAutograder === true;
      const autograderRowChanged =
        graderConfigMayHaveChanged ||
        priorAutograderRow.grader_repo !== nextAutograderRow.grader_repo ||
        !sameLimit(priorAutograderRow.max_submissions_count, nextAutograderRow.max_submissions_count) ||
        !sameLimit(priorAutograderRow.max_submissions_period_secs, nextAutograderRow.max_submissions_period_secs);
      await refineCore.onFinish(nextAutograderRow);

      // The flag and the handout's grade.yml must agree, and the sync reads the
      // flag from the DB — so the flag has to be written first. That leaves a
      // window where the sync can fail (shared-handout conflict, GitHub rejects
      // the edit) with the flag already persisted, which would leave the webhook
      // treating the assignment as no-autograder while repos still carry the
      // workflow. Roll the flag back on failure so the two never disagree.
      //
      // The flag write is INSIDE the try: it can fail too (RLS, network), and leaving it
      // outside meant that failure skipped the rollback of the autograder row that was
      // already saved above — reporting "Changes not saved" while an unvalidated
      // grader_repo stayed persisted.
      // Only when the flag actually changed, matching the edit page. The sync is
      // idempotent in outcome but NOT in effect: it rewrites the handout repo, re-pins
      // latest_template_sha for every assignment sharing it, and realigns the in-class
      // sharers. Running it on every save meant an unrelated edit here — changing only a
      // submission limit — could strip grade.yml from a shared handout and turn the
      // autograder off on assignments the instructor never opened.
      const autograderFlagChanged = priorHasAutograder === undefined || priorHasAutograder !== nextHasAutograder;
      try {
        await mutateAssignment({ values: { has_autograder: nextHasAutograder } });
        if (!autograderFlagChanged) {
          savedHasAutograder.current = nextHasAutograder;
          return;
        }
        const syncResult = await assignmentSyncAutograderWorkflow(
          {
            assignment_id: Number.parseInt(assignment_id as string),
            class_id: Number.parseInt(course_id as string)
          },
          supabase
        );
        // Trust what the sync actually PERSISTED, not what was requested. It can
        // legitimately differ: a PR-mode assignment gets coerced back to false there,
        // because PR submissions never run Actions. Recording the requested value left
        // the form and the rollback baseline disagreeing with the row, so the next save
        // showed Enabled or rolled back to the wrong value.
        const persistedHasAutograder = syncResult?.has_autograder ?? nextHasAutograder;
        savedHasAutograder.current = persistedHasAutograder;
        if (persistedHasAutograder !== nextHasAutograder) {
          setValue("assignments.has_autograder", persistedHasAutograder);
          toaster.create({
            title: "Autograder left disabled",
            description:
              "This assignment submits by pull request, and those submissions are graded without GitHub " +
              "Actions, so the autograder cannot be enabled for it.",
            type: "info"
          });
        }
        // The grading workflow lives in the handout repo, so assignments sharing
        // that handout necessarily share the setting. Say so plainly — otherwise
        // an instructor silently changes assignments they did not open.
        const realigned = syncResult?.realigned_assignments ?? [];
        if (realigned.length > 0) {
          toaster.create({
            title: `Also updated ${realigned.length} assignment${realigned.length === 1 ? "" : "s"}`,
            description:
              `${realigned.map((a) => a.title).join(", ")} share this handout repository, so the autograder was ` +
              `turned ${persistedHasAutograder ? "on" : "off"} for ${realigned.length === 1 ? "it" : "them"} too.`,
            type: "info"
          });
        }
      } catch (syncError) {
        // Undo BOTH writes so the reported failure matches what is stored. Each rollback
        // is individually guarded: an unguarded rejection here would replace the original
        // error (so the instructor never learns what actually failed) and skip the
        // remaining rollback.
        if (priorHasAutograder !== undefined && priorHasAutograder !== nextHasAutograder) {
          try {
            await mutateAssignment({ values: { has_autograder: priorHasAutograder } });
          } catch (rollbackError) {
            console.error("Failed to roll back has_autograder after a sync failure", rollbackError);
          }
        }
        if (autograderRowChanged) {
          try {
            await refineCore.onFinish(priorAutograderRow);
          } catch (rollbackError) {
            // Surface the original failure, but don't hide a failed rollback: the
            // row now holds values the instructor was told did not save.
            console.error("Failed to roll back the autograder row after a sync failure", rollbackError);
          }
        }
        throw syncError;
      }
    },
    [refineCore, assignment_id, course_id, mutateAssignment, setValue, query?.data?.data]
  );
  const currentGraderRepo = watch("grader_repo");
  const currentAssignment = watch("assignments");

  // grader_repo is "owner/repo". Parse into exactly two segments so a malformed value
  // (extra slashes) is rejected here rather than silently producing a slash-containing
  // repoName the Contents API can't address.
  const [graderOrg, graderRepoName, ...graderRepoExtra] =
    typeof currentGraderRepo === "string" ? currentGraderRepo.split("/") : [];
  const graderRepoIsValid = !!graderOrg && !!graderRepoName && graderRepoExtra.length === 0;

  if (query?.isLoading || formLoading) {
    return <div>Loading...</div>;
  }
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }

  return (
    <div>
      <Heading size="md">Autograder Configuration</Heading>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setLoading(true);
            await handleSubmit(onSubmit)(e);
          } catch (error) {
            // Surface the underlying message: besides a missing pawtograder.yml, this
            // now also covers the grade.yml add/remove done when the autograder is
            // toggled, whose errors say exactly which repo or file was the problem.
            toaster.error({
              title: "Changes not saved",
              description:
                error instanceof Error && error.message
                  ? error.message
                  : "An error occurred while saving the autograder configuration. Please double-check that the repository exists and that the pawtograder.yml file is present."
            });
            console.error(error);
          } finally {
            setLoading(false);
          }
        }}
      >
        <Fieldset.Root size="lg" maxW="md">
          <Fieldset.Content>
            <Field
              label="Autograder configuration for this assignment"
              helperText="Disabling the autograder removes the grading workflow from the handout repository, so no GitHub Actions run and every push creates a submission for you to grade by hand. Student repositories that already exist keep their copy of the workflow until they are next synced with the handout."
              errorText={errors.enabled?.message?.toString()}
              invalid={errors.enabled ? true : false}
            >
              <Controller
                name="assignments.has_autograder"
                control={control}
                render={({ field }) => (
                  <RadioGroup.Root
                    name={field.name}
                    value={field.value ? "true" : "false"}
                    onValueChange={(details) => field.onChange(details.value === "true")}
                  >
                    <Radio value="true">Enabled</Radio>
                    <Radio value="false">Disabled</Radio>
                  </RadioGroup.Root>
                )}
              />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label="Maximum number of submissions per student (count)"
              helperText="The grader can be configured to allow each student to submit up to a certain number of times within a given time period. This is the count of submissions that will be graded."
            >
              <Input type="number" {...register("max_submissions_count")} />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label="Maximum number of submissions per student (time period)"
              helperText="The grader can be configured to allow each student to submit up to a certain number of times within a given time period. This is that time period."
            >
              <NativeSelectRoot {...register("max_submissions_period_secs")}>
                <NativeSelectField name="max_submissions_period_secs">
                  <option value="">No limit</option>
                  <option value="600">10 minutes</option>
                  <option value="3600">1 hour</option>
                  <option value="86400">24 hours</option>
                  <option value="172800">48 hours</option>
                </NativeSelectField>
              </NativeSelectRoot>
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field label="Solution Repository">
              <Link href={`https://github.com/${currentGraderRepo}`}>{currentGraderRepo}</Link>
            </Field>
          </Fieldset.Content>
        </Fieldset.Root>
        <Button type="submit" loading={loading} colorPalette="green" variant="solid">
          Save
        </Button>
      </form>
      {currentAssignment && typeof currentGraderRepo === "string" && (
        <AutograderConfiguration graderRepo={currentGraderRepo} />
      )}
      {graderRepoIsValid && (
        <Fieldset.Root size="lg" mt={6}>
          <Fieldset.Legend>
            <Heading size="md">Edit config files</Heading>
          </Fieldset.Legend>
          <Fieldset.HelperText mb={2}>
            Edit the autograder config and GitHub Actions workflow files in the solution repository directly, with live
            validation. Changes are committed back to GitHub.
          </Fieldset.HelperText>
          <RepoFileEditor
            courseId={Number(course_id)}
            orgName={graderOrg}
            repoName={graderRepoName}
            path="pawtograder.yml"
            paths={[
              { label: "pawtograder.yml", path: "pawtograder.yml" },
              { label: ".github/workflows/grade.yml", path: ".github/workflows/grade.yml" }
            ]}
          />
        </Fieldset.Root>
      )}
    </div>
  );
}
