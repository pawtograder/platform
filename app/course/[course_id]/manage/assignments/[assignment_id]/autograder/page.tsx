"use client";

import AutograderConfiguration from "@/components/ui/autograder-configuration";
import { Field } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import RepoSelector from "@/components/ui/repo-selector";
import { toaster, Toaster } from "@/components/ui/toaster";
import { githubRepoConfigureWebhook } from "@/lib/edgeFunctions";
import { Assignment, AutograderWithAssignment } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Button, Fieldset, Heading, Input, NativeSelectField, NativeSelectRoot, RadioGroup } from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Controller, FieldValues } from "react-hook-form";

export default function AutograderPage() {
  const { assignment_id } = useParams();
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

  useEffect(() => {
    if (query?.data?.data) {
      reset(query.data.data);
    }
  }, [query?.data?.data, reset]);

  const onSubmit = useCallback(
    async (values: FieldValues) => {
      const supabase = createClient();
      await githubRepoConfigureWebhook(
        {
          assignment_id: Number.parseInt(assignment_id as string),
          new_repo: values.grader_repo,
          watch_type: "grader_solution"
        },
        supabase
      );
      mutateAssignment({
        values: {
          has_autograder: values.assignments.has_autograder
        }
      });
      console.log(values.max_submissions_count, values.max_submissions_period_secs);
      refineCore.onFinish({
        grader_repo: values.grader_repo,
        max_submissions_count: values.max_submissions_count || null,
        max_submissions_period_secs: values.max_submissions_period_secs || null
      });
    },
    [refineCore, assignment_id, mutateAssignment]
  );

  if (query?.isLoading || formLoading) {
    return <div>Loading...</div>;
  }
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  const currentGraderRepo = watch("grader_repo");
  const currentAssignment = watch("assignments");

  return (
    <div>
      <Heading size="md">Autograder Configuration</Heading>
      <Toaster />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setLoading(true);
            await handleSubmit(onSubmit)(e);
          } catch (error) {
            toaster.error({
              title: "Changes not saved",
              description:
                "An error occurred while saving the autograder configuration. Please double-check that the repository exists and that the pawtograder.yml file is present."
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
            <Field
              label="Solution Repository"
              helperText="The repository that contains the solution code for this assignment. This repository must contain a `pawtograder.yml` file at its root."
            >
              <Controller
                name="grader_repo"
                control={control}
                render={({ field }) => {
                  return (
                    <RepoSelector
                      name={field.name}
                      value={field.value || ""}
                      onBlur={field.onBlur}
                      onChange={(repo) => {
                        field.onChange(repo);
                      }}
                    />
                  );
                }}
              />
            </Field>
          </Fieldset.Content>
        </Fieldset.Root>
        <Button type="submit" loading={loading} colorPalette="green" variant="solid">
          Save
        </Button>
      </form>
      {currentAssignment && typeof currentGraderRepo === "string" && (
        <AutograderConfiguration graderRepo={currentGraderRepo} assignment={currentAssignment} />
      )}
    </div>
  );
}
