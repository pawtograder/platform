"use client";
import { Field as BaseField, type FieldProps } from "@/components/ui/field";
import {
  Accordion,
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  CardTitle,
  Checkbox,
  Field as CkField,
  Fieldset,
  Input,
  NativeSelectField,
  NativeSelectRoot,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { Controller, FieldErrors, FieldValues } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { summarizeInvalidFields } from "@/lib/assignmentFormErrors";
import { appendTimezoneOffset } from "@/lib/utils";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useList } from "@refinedev/core";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { LabSection, LabSectionMeeting } from "@/utils/supabase/DatabaseTypes";
import { useTableControllerTableValues } from "@/lib/TableController";

/**
 * Form-local Field wrapper. For `orientation="horizontal"` it lays the field out as a
 * 3-column grid — label | control | helper/error — so that across every field in a section
 * the labels, inputs, and helper text line up in consistent columns. Vertical fields (e.g.
 * checkboxes) fall through to the shared Field unchanged. Scoped to this form so the shared
 * `@/components/ui/field` (used elsewhere) is untouched.
 */
function Field({ orientation, ...props }: FieldProps) {
  if (orientation !== "horizontal") {
    return <BaseField orientation={orientation} {...props} />;
  }
  const { label, children, helperText, errorText, optionalText, required, invalid, ...rest } = props;
  return (
    <CkField.Root
      required={required}
      invalid={invalid}
      display="grid"
      gridTemplateColumns={{ base: "1fr", md: "minmax(150px, 220px) minmax(0, 1fr) minmax(0, 1.1fr)" }}
      alignItems="start"
      columnGap={4}
      rowGap={1}
      {...rest}
    >
      {label ? (
        <CkField.Label m={0} pt={2}>
          {label}
          <CkField.RequiredIndicator fallback={optionalText} />
        </CkField.Label>
      ) : (
        <span />
      )}
      <Box minW={0} w="100%">
        {children}
      </Box>
      <Box minW={0} gridColumn={{ base: "1", md: "3" }}>
        {helperText ? <CkField.HelperText mt={0}>{helperText}</CkField.HelperText> : null}
        {errorText ? <CkField.ErrorText>{errorText}</CkField.ErrorText> : null}
      </Box>
    </CkField.Root>
  );
}

// Helper function to calculate effective due date for a lab section
function calculateLabSectionDueDate(
  labSection: LabSection,
  labSectionMeetings: LabSectionMeeting[],
  originalDueDate: Date,
  minutesDueAfterLab: number,
  timezone: string
): Date | null {
  // Find the most recent lab section meeting before the assignment's original due date
  const relevantMeetings = labSectionMeetings
    .filter((meeting) => {
      if (meeting.lab_section_id !== labSection.id || meeting.cancelled) {
        return false;
      }

      // Combine meeting date with lab section end time
      const meetingEndTime = new TZDate(meeting.meeting_date + "T" + (labSection.end_time || "23:59:59"), timezone);

      return meetingEndTime <= originalDueDate;
    })
    .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime());

  if (relevantMeetings.length === 0) {
    return null; // No lab meeting found before due date
  }

  // Get the most recent lab meeting
  const mostRecentMeeting = relevantMeetings[0];

  // Combine meeting date with lab section end time
  const labMeetingEndTime = new TZDate(
    mostRecentMeeting.meeting_date + "T" + (labSection.end_time || "23:59:59"),
    timezone
  );

  // Add the minutes offset
  return addMinutes(labMeetingEndTime, minutesDueAfterLab);
}

function LabDueDatePreview({ form, timezone }: { form: UseFormReturnType<Assignment>; timezone: string }) {
  const dueDate = form.watch("due_date");
  const minutesDueAfterLab = form.watch("minutes_due_after_lab");
  const controller = useCourseController();
  const labSections = useTableControllerTableValues(controller.labSections);
  const labSectionMeetings = useTableControllerTableValues(controller.labSectionMeetings);

  if (
    !dueDate ||
    minutesDueAfterLab === null ||
    minutesDueAfterLab === undefined ||
    minutesDueAfterLab === "" ||
    labSections.length === 0
  ) {
    return (
      <Field
        label="Lab Section Due Date Preview"
        helperText="Shows when the assignment will be due for each lab section"
        w="100%"
      >
        <Box p="3" bg="bg.info" borderRadius="md" w="100%">
          <Text fontSize="sm" color="fg.muted">
            {!dueDate && "Set a due date to see lab section preview"}
            {dueDate &&
              (minutesDueAfterLab === null || minutesDueAfterLab === undefined || minutesDueAfterLab === "") &&
              "Set minutes due after lab to see preview"}
            {dueDate &&
              minutesDueAfterLab !== null &&
              minutesDueAfterLab !== undefined &&
              minutesDueAfterLab !== "" &&
              labSections.length === 0 &&
              "No lab sections found"}
          </Text>
        </Box>
      </Field>
    );
  }

  const originalDueDate = new TZDate(dueDate, timezone);

  return (
    <Field label="Lab Section Due Date Preview" helperText="Shows when the assignment will be due for each lab section">
      <Box borderWidth="1px" borderColor="border.info" borderRadius="md" overflow="hidden">
        <Table.Root size="sm" variant="outline" striped w="100%">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader py="2" fontSize="xs" fontWeight="semibold" bg="bg.info">
                Lab Section
              </Table.ColumnHeader>
              <Table.ColumnHeader py="2" fontSize="xs" fontWeight="semibold" textAlign="right" bg="bg.info">
                Effective Due Date
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {labSections.map((labSection) => {
              const effectiveDueDate = calculateLabSectionDueDate(
                labSection,
                labSectionMeetings,
                originalDueDate,
                minutesDueAfterLab,
                timezone
              );

              return (
                <Table.Row key={labSection.id}>
                  <Table.Cell py="1.5" fontSize="sm" fontWeight="medium">
                    {labSection.name}
                  </Table.Cell>
                  <Table.Cell
                    py="1.5"
                    fontSize="sm"
                    textAlign="right"
                    color={effectiveDueDate ? "fg.default" : "fg.error"}
                    fontWeight={effectiveDueDate ? "normal" : "semibold"}
                  >
                    {effectiveDueDate ? (
                      <TimeZoneAwareDate date={effectiveDueDate} format="full" />
                    ) : (
                      "No lab meeting before due date"
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
    </Field>
  );
}

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

  const { onChange: onGroupConfigChange, ...groupConfigRegisterRest } = register("group_config", { required: true });

  return (
    <CardRoot>
      <CardHeader>
        <CardTitle>Groups</CardTitle>
        <Text fontSize="sm" color="fg.muted">
          Whether students submit individually or as a group, group size limits, and how groups are formed.
        </Text>
      </CardHeader>
      <CardBody gap="5px">
        <Fieldset.Content>
          <Field
            orientation="horizontal"
            label="Submission type"
            helperText="Choose whether students submit individually or as a group."
            errorText={errors.group_config?.message?.toString()}
            invalid={errors.group_config ? true : false}
            required={true}
          >
            <NativeSelectRoot>
              <NativeSelectField
                {...groupConfigRegisterRest}
                onChange={(e) => {
                  onGroupConfigChange(e);
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
                orientation="horizontal"
                label="Minimum group size"
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
                orientation="horizontal"
                label="Maximum group size"
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
                orientation="horizontal"
                label="Group formation method"
                helperText="Choose whether students can form their own groups or if all groups will be assigned by instructors"
                errorText={errors.allow_student_formed_groups?.message?.toString()}
                invalid={errors.allow_student_formed_groups ? true : false}
                required={withGroups}
              >
                <Controller
                  name="allow_student_formed_groups"
                  control={control}
                  rules={{
                    validate: (v) => {
                      const gc = getValues("group_config");
                      if (gc !== "groups" && gc !== "both") return true;
                      return v === true || v === false ? true : "This is required for group assignments";
                    }
                  }}
                  render={({ field }) => (
                    <NativeSelectRoot>
                      <NativeSelectField
                        name={field.name}
                        ref={field.ref}
                        value={field.value === true ? "true" : field.value === false ? "false" : ""}
                        onBlur={field.onBlur}
                        onChange={(e) => {
                          const raw = e.target.value;
                          field.onChange(raw === "true" ? true : raw === "false" ? false : null);
                        }}
                      >
                        <option value="true">Students can form groups</option>
                        <option value="false">Instructor only</option>
                      </NativeSelectField>
                    </NativeSelectRoot>
                  )}
                />
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                orientation="horizontal"
                label="Copy groups from assignment"
                helperText="Copy groups from another assignment"
              >
                <NativeSelectRoot>
                  <NativeSelectField {...register("copy_groups_from_assignment", { required: false })}>
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
                orientation="horizontal"
                label="Group formation deadline"
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

function LabDueDateSubform({ form }: { form: UseFormReturnType<Assignment> }) {
  const [withLabDueDate, setWithLabDueDate] = useState<boolean>(() => {
    const minutesDueAfterLab = form.getValues("minutes_due_after_lab");
    return minutesDueAfterLab !== null && minutesDueAfterLab !== undefined;
  });

  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const timezone = course.time_zone || "America/New_York";

  const {
    register,
    watch,
    formState: { errors }
  } = form;

  // Watch for changes to minutes_due_after_lab to handle form reset/loading
  useEffect(() => {
    const subscription = watch((value, { name }) => {
      if (name === "minutes_due_after_lab" || !name) {
        const minutesDueAfterLab = value.minutes_due_after_lab;
        setWithLabDueDate(minutesDueAfterLab !== null && minutesDueAfterLab !== undefined && minutesDueAfterLab !== "");
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  return (
    <>
      <Fieldset.Content>
        <Field helperText="When enabled, the assignment due date will be calculated as a number of minutes after the student's most recent lab section meeting before the original due date. This allows for flexible due dates that align with each student's lab schedule.">
          <Checkbox.Root
            checked={withLabDueDate}
            onCheckedChange={(checked) => {
              setWithLabDueDate(!!checked.checked);
              if (!checked.checked) {
                // Clear the minutes_due_after_lab field when unchecked
                form.setValue("minutes_due_after_lab", null, { shouldDirty: true });
              } else {
                // Set a default value when checked - use string since valueAsNumber will convert it
                form.setValue("minutes_due_after_lab", "60", { shouldValidate: true, shouldDirty: true });
              }
            }}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control>
              <LuCheck />
            </Checkbox.Control>
            <Checkbox.Label>Custom due date based on lab meeting time</Checkbox.Label>
          </Checkbox.Root>
        </Field>
      </Fieldset.Content>
      {withLabDueDate && (
        <Fieldset.Content>
          <Field
            orientation="horizontal"
            label="Minutes due after lab meeting"
            helperText="The number of minutes after the lab meeting ends when the assignment becomes due. For example, 60 minutes means the assignment is due 1 hour after the lab meeting ends."
            errorText={errors.minutes_due_after_lab?.message?.toString()}
            invalid={errors.minutes_due_after_lab ? true : false}
            required={withLabDueDate}
          >
            <Input
              type="number"
              {...register("minutes_due_after_lab", {
                required: withLabDueDate ? "This is required when using lab-based due dates" : false,
                min: { value: 0, message: "Minutes must be at least 0" },
                valueAsNumber: true
              })}
            />
          </Field>
        </Fieldset.Content>
      )}
      {withLabDueDate && (
        <Fieldset.Content>
          <LabDueDatePreview form={form} timezone={timezone} />
        </Fieldset.Content>
      )}
    </>
  );
}

function SelfEvaluationSubform({ form, timezone }: { form: UseFormReturnType<Assignment>; timezone: string }) {
  const [withEval, setWithEval] = useState<boolean>(false);
  const [allowEarly, setAllowEarly] = useState<boolean>(form.getValues("allow_early") == true);

  const {
    register,
    getValues,
    watch,
    control,
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
        <CardTitle>Self-evaluation</CardTitle>
        <Text fontSize="sm" color="fg.muted">
          Optionally require students to complete a self-evaluation after this assignment&apos;s deadline.
        </Text>
      </CardHeader>
      <CardBody gap="5px">
        <Fieldset.Content>
          <Field
            orientation="horizontal"
            label="Require self-evaluation"
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
                <option value="base_only">Assignment only</option>
                <option value="use_eval">Assignment and self-evaluation</option>
              </NativeSelectField>
            </NativeSelectRoot>
          </Field>
        </Fieldset.Content>
        {withEval && (
          <>
            <Fieldset.Content>
              <Field
                orientation="horizontal"
                label="Hours due after this assignment"
                helperText="The number of hours between this assignment's deadline and when the self-evaluation is due"
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
              helperText="Students can submit the self-evaluation before this assignment's deadline"
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
            <Fieldset.Content>
              <Field
                orientation="horizontal"
                label={`Release self-evaluation at (${timezone}, optional)`}
                helperText="If set, the self-evaluation is released to all students at this wall-clock time, ignoring per-student due-date exceptions. Leave blank to release when this assignment's due date passes."
              >
                <Controller
                  name="self_review_release_at"
                  control={control}
                  render={({ field }) => {
                    const raw = field.value as string | null | undefined;
                    const hasATimezoneOffset =
                      typeof raw === "string" &&
                      raw.length >= 6 &&
                      (raw.charAt(raw.length - 6) === "+" || raw.charAt(raw.length - 6) === "-");
                    const localValue =
                      raw && hasATimezoneOffset ? formatInTimeZone(raw, timezone, "yyyy-MM-dd'T'HH:mm") : (raw ?? "");
                    return (
                      <Input
                        type="datetime-local"
                        value={localValue}
                        onChange={(e) => field.onChange(e.target.value || null)}
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
    watch,
    // refineCore: {
    //     onFinish
    // },
    formState: { errors }
  } = form;

  const { role: classRole } = useClassProfiles();
  const course = classRole.classes;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [allowNotGradedSubmissions, setAllowNotGradedSubmissions] = useState<boolean>(
    form.getValues("allow_not_graded_submissions") == true
  );
  const [requireTokensBeforeDueDate, setRequireTokensBeforeDueDate] = useState<boolean>(
    form.getValues("require_tokens_before_due_date") == true
  );
  const timezone = course.time_zone || "America/New_York";
  const isEditing = !!form.getValues("id");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Called by react-hook-form when Save is pressed but validation fails. Without
  // this the submit handler never runs and the only signal is inline error text
  // that is usually scrolled off-screen, so the page appears to do nothing.
  const onInvalid = useCallback((formErrors: FieldErrors<Assignment>) => {
    const invalidKeys = Object.keys(formErrors);
    if (invalidKeys.length === 0) return;
    const { names, hasAdvancedError } = summarizeInvalidFields(invalidKeys);
    // Reveal the Advanced section if a hidden field is the problem.
    if (hasAdvancedError) {
      setAdvancedOpen(true);
    }
    toaster.error({
      title: "Couldn't save — please fix the highlighted fields",
      description: `Check: ${names.join(", ")}`
    });
    // Defer to the next frame so a just-expanded Advanced field is in the DOM, and
    // scope the query to this form so we never grab an unrelated invalid input elsewhere.
    requestAnimationFrame(() => {
      const firstInvalid = formRef.current?.querySelector('[aria-invalid="true"]');
      firstInvalid?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  // Keep checkbox state synced with form value
  useEffect(() => {
    const subscription = watch((value, { name }) => {
      if (name === "allow_not_graded_submissions" || !name) {
        setAllowNotGradedSubmissions(value.allow_not_graded_submissions);
      }
      if (name === "require_tokens_before_due_date" || !name) {
        setRequireTokensBeforeDueDate(value.require_tokens_before_due_date);
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);
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
        suggested_due_date: values.suggested_due_date
          ? appendTimezoneOffset(values.suggested_due_date, timezone)
          : null,
        group_formation_deadline: appendTimezoneOffset(values.group_formation_deadline, timezone),
        regrade_deadline: appendTimezoneOffset(values.regrade_deadline, timezone),
        self_review_release_at: values.self_review_release_at
          ? appendTimezoneOffset(values.self_review_release_at, timezone)
          : null
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
      <form ref={formRef} onSubmit={handleSubmit(onSubmitWrapper, onInvalid)}>
        <Fieldset.Root>
          <VStack align="stretch" gap={6} w="100%">
            <CardRoot>
              <CardHeader>
                <CardTitle>Basics</CardTitle>
                <Text fontSize="sm" color="fg.muted">
                  The assignment&apos;s title, its short URL identifier, and the total points possible.
                </Text>
              </CardHeader>
              <CardBody gap="5px">
                <Fieldset.Content>
                  <Field
                    orientation="horizontal"
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
                    orientation="horizontal"
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
                    orientation="horizontal"
                    label="Points possible"
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
              </CardBody>
            </CardRoot>
            <CardRoot>
              <CardHeader>
                <CardTitle>Schedule</CardTitle>
                <Text fontSize="sm" color="fg.muted">
                  When students can see and submit the assignment, including optional lab-based due dates. All times are
                  in <strong>{course.time_zone}</strong> — students see this time zone by default, or times converted to
                  their own local time.
                </Text>
              </CardHeader>
              <CardBody gap="5px">
                <Fieldset.Content>
                  <Field
                    orientation="horizontal"
                    label="Release date"
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
                  <Field
                    orientation="horizontal"
                    label="Suggested due date"
                    helperText="Optional recommended target date shown to students. The Due Date below remains the hard deadline; students may resubmit freely until then."
                    errorText={errors.suggested_due_date?.message?.toString()}
                    invalid={errors.suggested_due_date ? true : false}
                  >
                    <Controller
                      name="suggested_due_date"
                      control={control}
                      rules={{
                        validate: (value: string) => {
                          if (!value) return true;
                          const dueDate = form.getValues("due_date");
                          if (!dueDate) return true;
                          const suggested = new TZDate(value, timezone).getTime();
                          const due = new TZDate(dueDate, timezone).getTime();
                          return suggested <= due || "Suggested due date must be on or before the due date";
                        },
                        deps: ["due_date"]
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
                    orientation="horizontal"
                    label="Due date"
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
                <LabDueDateSubform form={form} />
              </CardBody>
            </CardRoot>
            <CardRoot>
              <CardHeader>
                <CardTitle>Late submissions</CardTitle>
                <Text fontSize="sm" color="fg.muted">
                  How work submitted after the due date is handled — late tokens and ungraded late submissions.
                </Text>
              </CardHeader>
              <CardBody gap="5px">
                <Fieldset.Content>
                  <Field
                    orientation="horizontal"
                    label="Max late tokens"
                    helperText="The maximum number of late tokens a student can use for this assignment (0 means no late tokens are allowed)"
                    invalid={!!errors.max_late_tokens}
                    errorText={errors.max_late_tokens?.message?.toString()}
                  >
                    <Input
                      type="number"
                      defaultValue={0}
                      {...register("max_late_tokens", {
                        required: false,
                        min: { value: 0, message: "Max late tokens must be at least 0" },
                        validate: (value) =>
                          !form.getValues("require_tokens_before_due_date") && (!value || value <= 0)
                            ? "Max late tokens must be greater than 0 when 'Require students to apply late tokens before the original due date' is unchecked"
                            : undefined
                      })}
                    />
                  </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                  <Field helperText="When checked, students must apply late tokens manually before the original due date. When unchecked, a late token is applied automatically when a student submits after the deadline.">
                    <Checkbox.Root {...register("require_tokens_before_due_date")} checked={requireTokensBeforeDueDate}>
                      <Checkbox.HiddenInput />
                      <Checkbox.Control>
                        <LuCheck />
                      </Checkbox.Control>
                      <Checkbox.Label>
                        Require students to apply late tokens before the original due date
                      </Checkbox.Label>
                    </Checkbox.Root>
                  </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                  <Field helperText="Allow students to submit after the deadline by including #NOT-GRADED in their commit message. These submissions will not be graded and cannot become active, but students can still see autograder feedback.">
                    <Checkbox.Root {...register("allow_not_graded_submissions")} checked={allowNotGradedSubmissions}>
                      <Checkbox.HiddenInput />
                      <Checkbox.Control>
                        <LuCheck />
                      </Checkbox.Control>
                      <Checkbox.Label>Allow NOT-GRADED submissions after deadline</Checkbox.Label>
                    </Checkbox.Root>
                  </Field>
                </Fieldset.Content>
              </CardBody>
            </CardRoot>
            <GroupConfigurationSubform form={form} timezone={timezone} />
            <SelfEvaluationSubform form={form} timezone={timezone} />
            <CardRoot>
              <Accordion.Root
                collapsible
                value={advancedOpen ? ["advanced"] : []}
                onValueChange={(details) => setAdvancedOpen(details.value.includes("advanced"))}
              >
                <Accordion.Item value="advanced">
                  <Accordion.ItemTrigger p={4}>
                    <Box flex="1" textAlign="left">
                      <CardTitle>Advanced settings</CardTitle>
                      <Text fontSize="sm" color="fg.muted">
                        Regrade deadline, anonymous grading, leaderboard, repository analytics
                      </Text>
                    </Box>
                    <Accordion.ItemIndicator />
                  </Accordion.ItemTrigger>
                  <Accordion.ItemContent>
                    <Box px={4} pb={4}>
                      <Fieldset.Content>
                        <Field
                          orientation="horizontal"
                          label={`Regrade Request Deadline (${course.time_zone})`}
                          helperText="The deadline after which students cannot submit new regrade requests. Leave empty for no deadline."
                          errorText={errors.regrade_deadline?.message?.toString()}
                          invalid={!!errors.regrade_deadline}
                        >
                          <Controller
                            name="regrade_deadline"
                            control={control}
                            rules={{ required: false }}
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
                        <Field helperText="When enabled, graders' names will appear as pseudonyms to students. Staff members will still see the real name of the grader.">
                          <Controller
                            name="grader_pseudonymous_mode"
                            control={control}
                            render={({ field }) => (
                              <Checkbox.Root
                                checked={field.value || false}
                                onCheckedChange={(checked) => field.onChange(!!checked.checked)}
                              >
                                <Checkbox.HiddenInput />
                                <Checkbox.Control>
                                  <LuCheck />
                                </Checkbox.Control>
                                <Checkbox.Label>Anonymous grading (show grader pseudonyms to students)</Checkbox.Label>
                              </Checkbox.Root>
                            )}
                          />
                        </Field>
                      </Fieldset.Content>
                      <Fieldset.Content>
                        <Field helperText="When enabled, students can see a leaderboard showing top autograder scores using pseudonyms.">
                          <Controller
                            name="show_leaderboard"
                            control={control}
                            render={({ field }) => (
                              <Checkbox.Root
                                checked={field.value || false}
                                onCheckedChange={(checked) => field.onChange(!!checked.checked)}
                              >
                                <Checkbox.HiddenInput />
                                <Checkbox.Control>
                                  <LuCheck />
                                </Checkbox.Control>
                                <Checkbox.Label>Show autograder leaderboard to students</Checkbox.Label>
                              </Checkbox.Root>
                            )}
                          />
                        </Field>
                      </Fieldset.Content>
                      <Fieldset.Content>
                        <Field helperText="When enabled, GitHub repository analytics (commits, PRs, issues, comments) will be collected and visible to graders/instructors on each submission.">
                          <Controller
                            name="enable_repo_analytics"
                            control={control}
                            render={({ field }) => (
                              <Checkbox.Root
                                checked={field.value || false}
                                onCheckedChange={(checked) => field.onChange(!!checked.checked)}
                              >
                                <Checkbox.HiddenInput />
                                <Checkbox.Control>
                                  <LuCheck />
                                </Checkbox.Control>
                                <Checkbox.Label>Enable repository analytics</Checkbox.Label>
                              </Checkbox.Root>
                            )}
                          />
                        </Field>
                      </Fieldset.Content>
                    </Box>
                  </Accordion.ItemContent>
                </Accordion.Item>
              </Accordion.Root>
            </CardRoot>
            <Button type="submit" loading={isSubmitting} colorPalette="green" formNoValidate alignSelf="flex-start">
              Save
            </Button>
          </VStack>
        </Fieldset.Root>
      </form>
    </div>
  );
}
