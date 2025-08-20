"use client";
import { Field } from "@/components/ui/field";
import {
  CardBody,
  CardHeader,
  CardRoot,
  CardTitle,
  Checkbox,
  Fieldset,
  Input,
  NativeSelectField,
  NativeSelectRoot
} from "@chakra-ui/react";
import { Controller, FieldValues } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { toaster, Toaster } from "@/components/ui/toaster";
import { appendTimezoneOffset } from "@/lib/utils";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addMinutes } from "date-fns";
import { useList } from "@refinedev/core";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { useClassProfiles } from "@/hooks/useClassProfiles";

function GroupConfigurationSubform({ form, timezone }: { form: UseFormReturnType<Assignment>; timezone: string }) {
  const { course_id } = useParams();
  const { data: otherAssignments } = useList({
    resource: "assignments",
    queryOptions: { enabled: !!course_id },
    filters: [
      { field: "class_id", operator: "eq", value: Number.parseInt(course_id as string) },
      { field: "group_config", operator: "ne", value: "individual" }
    ],
    pagination: { pageSize: 1000 }
  });

  const [withGroups, setWithGroups] = useState<boolean>(() => {
    const groupConfig = form.getValues("group_config");
    return groupConfig === "groups" || groupConfig === "both";
  });
  const groupConfig = form.watch("group_config");
  useEffect(() => {
    setWithGroups(groupConfig === "groups" || groupConfig === "both");
  }, [groupConfig]);

  const {
    register,
    getValues,
    control,
    formState: { errors }
  } = form;
  return (
    <CardRoot>
      <CardHeader>
        <CardTitle>Group Configuration</CardTitle>
      </CardHeader>
      <CardBody gap="5px">
        <Fieldset.Content>
          <Field
            label="Group configuration"
            helperText="If you want to use groups for this assignment, select the group configuration you want to use."
            errorText={errors.group_config?.message?.toString()}
            invalid={errors.group_config ? true : false}
            required={true}
          >
            <NativeSelectRoot {...register("group_config", { required: true })}>
              <NativeSelectField
                name="group_config"
                defaultValue="individual"
                onChange={(e) => {
                  setWithGroups(e.target.value !== "individual");
                }}
              >
                <option value="individual">Individual Submissions Only</option>
                <option value="groups">Group Submissions Only</option>
                <option value="both">Individual or Group Submissions</option>
              </NativeSelectField>
            </NativeSelectRoot>
          </Field>
        </Fieldset.Content>
        {withGroups && (
          <>
            <Fieldset.Content>
              <Field
                label="Minimum Group Size"
                helperText="The minimum number of students allowed in a group"
                errorText={errors.min_group_size?.message?.toString()}
                invalid={errors.min_group_size ? true : false}
                required={withGroups}
              >
                <Input
                  type="number"
                  {...register("min_group_size", {
                    required:
                      getValues("group_config") === "groups" || getValues("group_config") === "both"
                        ? "This is required for group assignments"
                        : false,
                    min: { value: 1, message: "Minimum group size must be at least 1" }
                  })}
                />
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                label="Maximum Group Size"
                helperText="The maximum number of students allowed in a group"
                errorText={errors.max_group_size?.message?.toString()}
                invalid={errors.max_group_size ? true : false}
                required={withGroups}
              >
                <Input
                  type="number"
                  {...register("max_group_size", {
                    required:
                      getValues("group_config") === "groups" || getValues("group_config") === "both"
                        ? "This is required for group assignments"
                        : false,
                    min: { value: 1, message: "Maximum group size must be at least 1" }
                  })}
                />
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                label="Group Formation Method"
                helperText="Choose whether students can form their own groups or if all groups will be assigned by instructors"
                errorText={errors.allow_student_formed_groups?.message?.toString()}
                invalid={errors.allow_student_formed_groups ? true : false}
                required={withGroups}
              >
                <NativeSelectRoot
                  {...register("allow_student_formed_groups", {
                    required:
                      getValues("group_config") === "groups" || getValues("group_config") === "both"
                        ? "This is required for group assignments"
                        : false
                  })}
                >
                  <NativeSelectField name="allow_student_formed_groups">
                    <option value="true">Students can form groups</option>
                    <option value="false">Instructor only</option>
                  </NativeSelectField>
                </NativeSelectRoot>
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field label="Copy groups from assignment" helperText="Copy groups from another assignment">
                <NativeSelectRoot {...register("copy_groups_from_assignment", { required: false })}>
                  <NativeSelectField name="copy_groups_from_assignment">
                    <option value="">None</option>
                    {otherAssignments?.data?.map((assignment) => (
                      <option key={assignment.id} value={assignment.id}>
                        {assignment.title}
                      </option>
                    ))}
                  </NativeSelectField>
                </NativeSelectRoot>
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                label="Group Formation Deadline"
                helperText="The deadline by which groups must be formed. If set, students will not be able to change groups after this deadline."
                errorText={errors.group_formation_deadline?.message?.toString()}
                invalid={errors.group_formation_deadline ? true : false}
                required={withGroups}
              >
                <Controller
                  name="group_formation_deadline"
                  control={control}
                  rules={{ required: "This is required" }}
                  render={({ field }) => {
                    const hasATimezoneOffset =
                      field.value &&
                      (field.value.charAt(field.value.length - 6) === "+" ||
                        field.value.charAt(field.value.length - 6) === "-");
                    const localValue =
                      field.value && hasATimezoneOffset
                        ? new TZDate(field.value, timezone).toISOString().slice(0, -13)
                        : field.value;
                    return (
                      <Input
                        type="datetime-local"
                        value={localValue || ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    );
                  }}
                />
              </Field>
            </Fieldset.Content>
          </>
        )}
      </CardBody>
    </CardRoot>
  );
}

function SelfEvaluationSubform({ form }: { form: UseFormReturnType<Assignment> }) {
  const [withEval, setWithEval] = useState<boolean>(false);
  const [allowEarly, setAllowEarly] = useState<boolean>(form.getValues("allow_early") == true);

  const {
    register,
    getValues,
    watch,
    formState: { errors }
  } = form;

  // capture eval state changes with delayed loading
  useEffect(() => {
    const subscription = watch((value, { name }) => {
      if (name === "eval_config" || !name) {
        setWithEval(value.eval_config === "use_eval");
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  useEffect(() => {
    const subscription = watch((value, { name }) => {
      if (name === "allow_early" || !name) {
        setAllowEarly(value.allow_early);
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  return (
    <CardRoot>
      <CardHeader>
        <CardTitle>Self Evaluation Configuration</CardTitle>
      </CardHeader>
      <CardBody gap="5px">
        <Fieldset.Content>
          <Field
            label="Assignment setting"
            errorText={errors.group_config?.message?.toString()}
            invalid={errors.group_config ? true : false}
            required={true}
          >
            <NativeSelectRoot {...register("eval_config", { required: true })}>
              <NativeSelectField
                name="eval_config"
                onChange={(e) => {
                  setWithEval(e.target.value == "use_eval");
                }}
              >
                <option value="base_only">Programming assignment only</option>
                <option value="use_eval">Programming assignment and self evaluation</option>
              </NativeSelectField>
            </NativeSelectRoot>
          </Field>
        </Fieldset.Content>
        {withEval && (
          <>
            <Fieldset.Content>
              <Field
                label="Hours due after programming assignment"
                helperText="The number of hours between the deadline of the programming assignment and when the self evaluation is due"
                errorText={errors.min_group_size?.message?.toString()}
                invalid={errors.min_group_size ? true : false}
                required={withEval}
              >
                <Input
                  type="number"
                  {...register("deadline_offset", {
                    required:
                      getValues("eval_config") === "use_eval"
                        ? "This is required for self evaluation assignments"
                        : false,
                    min: { value: 0, message: "Offset must be a positive number" }
                  })}
                />
              </Field>
            </Fieldset.Content>
            <Field
              helperText="Students can submit self evaluation before programming assignment deadline"
              required={withEval}
            >
              <Checkbox.Root {...register("allow_early")} checked={allowEarly}>
                <Checkbox.HiddenInput />
                <Checkbox.Control>
                  {" "}
                  <LuCheck />
                </Checkbox.Control>
                <Checkbox.Label>Allow early submission</Checkbox.Label>
              </Checkbox.Root>
            </Field>
          </>
        )}
      </CardBody>
    </CardRoot>
  );
}

export default function AssignmentForm({
  form,
  onSubmit
}: {
  form: UseFormReturnType<Assignment>;
  onSubmit: (values: FieldValues) => void;
}) {
  const {
    handleSubmit,
    register,
    control,
    // refineCore: {
    //     onFinish
    // },
    formState: { errors }
  } = form;

  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const timezone = course.time_zone || "America/New_York";
  const isEditing = !!form.getValues("id");
  // Enforce that release date must be strictly in the future
  const nowPlusOneMinute = addMinutes(TZDate.tz(timezone), 1);
  const minReleaseLocal = new TZDate(nowPlusOneMinute, timezone).toISOString().slice(0, -13);
  const onSubmitWrapper = useCallback(
    async (values: FieldValues) => {
      setIsSubmitting(true);
      // Convert the release and due dates to UTC
      const valuesWithDates = {
        ...values,
        release_date: appendTimezoneOffset(values.release_date, timezone),
        due_date: appendTimezoneOffset(values.due_date, timezone),
        group_formation_deadline: appendTimezoneOffset(values.group_formation_deadline, timezone)
      };
      try {
        await onSubmit(valuesWithDates);
      } catch (error) {
        toaster.error({
          title: "Changes not saved",
          description: "An error occurred while saving the assignment. Please try again."
        });
        toaster.error({
          title: "Error creating assignment: " + (error instanceof Error ? error.name : "Unknown"),
          description: error instanceof Error ? error.message : "An unexpected error occurred. Please try again."
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [onSubmit, timezone]
  );

  return (
    <div>
      <Toaster />
      <form onSubmit={handleSubmit(onSubmitWrapper)}>
        <Fieldset.Root maxW="lg">
          <Fieldset.Content>
            <Field
              label="Title"
              errorText={errors.title?.message?.toString()}
              invalid={errors.title ? true : false}
              required={true}
            >
              <Input {...register("title", { required: "This is required" })} />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label="Slug"
              helperText={
                isEditing
                  ? "Slug cannot be changed when editing an assignment"
                  : "A short identifier for the assignment, e.g. 'hw1' or 'project2'. Must contain only lowercase letters, numbers, underscores, and hyphens, and be less than 16 characters."
              }
              errorText={errors.slug?.message?.toString()}
              invalid={errors.slug ? true : false}
              required={true}
            >
              <Input
                {...register("slug", {
                  required: "This is required",
                  pattern: {
                    value: /^[a-z0-9_-]+$/,
                    message: "Slug must contain only lowercase letters, numbers, underscores, and hyphens"
                  },
                  maxLength: { value: 16, message: "Slug must be less than 16 characters" }
                })}
                disabled={isEditing}
              />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label={`Release Date (${course.time_zone})`}
              helperText="Date that students can see the assignment. Student repositories will be created at the release date. Ensure all handout materials are in place before this time."
              errorText={errors.release_date?.message?.toString()}
              invalid={errors.release_date ? true : false}
              required={true}
            >
              <Controller
                name="release_date"
                control={control}
                rules={{
                  required: "This is required",
                  validate: (value: string) => {
                    if (!value) return "This is required";
                    // Only enforce future date requirement when creating new assignments
                    if (!isEditing) {
                      const selected = new TZDate(value, timezone).getTime();
                      const now = TZDate.tz(timezone).getTime();
                      return selected > now || "Release date must be in the future";
                    }
                    return true;
                  }
                }}
                render={({ field }) => {
                  const hasATimezoneOffset =
                    field.value &&
                    (field.value.charAt(field.value.length - 6) === "+" ||
                      field.value.charAt(field.value.length - 6) === "-");
                  const localValue =
                    field.value && hasATimezoneOffset
                      ? new TZDate(field.value, timezone).toISOString().slice(0, -13)
                      : field.value;
                  return (
                    <Input
                      type="datetime-local"
                      min={isEditing ? undefined : minReleaseLocal}
                      value={localValue || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  );
                }}
              />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Alert status="warning" variant="subtle" title="Student repositories will be created at the release date">
              Ensure all handout materials are in place before this time. Repositories for students are created at the
              release date.
            </Alert>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label={`Due Date (${course.time_zone})`}
              helperText="No submissions accepted after this time unless late submissions are allowed"
              errorText={errors.due_date?.message?.toString()}
              invalid={errors.due_date ? true : false}
              required={true}
            >
              <Controller
                name="due_date"
                control={control}
                rules={{ required: "This is required" }}
                render={({ field }) => {
                  const hasATimezoneOffset =
                    field.value &&
                    (field.value.charAt(field.value.length - 6) === "+" ||
                      field.value.charAt(field.value.length - 6) === "-");
                  const localValue =
                    field.value && hasATimezoneOffset
                      ? new TZDate(field.value, timezone).toISOString().slice(0, -13)
                      : field.value;
                  return (
                    <Input
                      type="datetime-local"
                      value={localValue || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  );
                }}
              />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label="Max Late Tokens"
              helperText="The maximum number of late tokens a student can use for this assignment (0 means no late tokens are allowed)"
            >
              <Input
                type="number"
                defaultValue={0}
                {...register("max_late_tokens", {
                  required: false,
                  min: { value: 0, message: "Max late tokens must be at least 0" }
                })}
              />
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field helperText="Allow students to submit after the deadline by including #NOT-GRADED in their commit message. These submissions will not be graded and cannot become active, but students can still see autograder feedback.">
              <Checkbox.Root {...register("allow_not_graded_submissions")} defaultChecked={true}>
                <Checkbox.HiddenInput />
                <Checkbox.Control>
                  <LuCheck />
                </Checkbox.Control>
                <Checkbox.Label>Allow NOT-GRADED submissions after deadline</Checkbox.Label>
              </Checkbox.Root>
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field helperText="Create an assignment that does not require submissions. Student repositories will still be created to distribute handouts, but GitHub Actions/check runs and the gradebook column will be disabled.">
              <Checkbox.Root>
                <Checkbox.HiddenInput {...register("no_submission")} />
                <Checkbox.Control>
                  <LuCheck />
                </Checkbox.Control>
                <Checkbox.Label>No submission required</Checkbox.Label>
              </Checkbox.Root>
            </Field>
          </Fieldset.Content>
          <Fieldset.Content>
            <Field
              label="Points Possible"
              errorText={errors.total_points?.message?.toString()}
              invalid={!!errors.total_points}
              required={true}
            >
              <Input
                type="number"
                {...register("total_points", {
                  required: "This is required",
                  min: { value: 0, message: "Points possible must be at least 0" }
                })}
              />
            </Field>
          </Fieldset.Content>
          <GroupConfigurationSubform form={form} timezone={timezone} />
          <SelfEvaluationSubform form={form} />
          <Fieldset.Content>
            <Button type="submit" loading={isSubmitting} colorPalette="green" formNoValidate>
              Save
            </Button>
          </Fieldset.Content>
        </Fieldset.Root>
      </form>
    </div>
  );
}
