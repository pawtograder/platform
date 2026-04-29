"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster, Toaster } from "@/components/ui/toaster";
import type { GradingAssignmentDefaultProfile } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  CardTitle,
  Checkbox,
  Fieldset,
  Heading,
  HStack,
  Input,
  NativeSelectField,
  NativeSelectRoot,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { LuCheck } from "react-icons/lu";

type GradingCcEmails = { emails: string[] };

type FormValues = {
  name: GradingAssignmentDefaultProfile["name"];
  description: string;
  auto_assign_at_deadline: GradingAssignmentDefaultProfile["auto_assign_at_deadline"];
  auto_assign_assignee_pool: GradingAssignmentDefaultProfile["auto_assign_assignee_pool"];
  auto_assign_review_due_hours: GradingAssignmentDefaultProfile["auto_assign_review_due_hours"];
  late_grading_reminders_enabled: GradingAssignmentDefaultProfile["late_grading_reminders_enabled"];
  late_grading_reminder_interval_hours: GradingAssignmentDefaultProfile["late_grading_reminder_interval_hours"];
  late_grading_reply_to: string;
  late_grading_cc_emails: GradingCcEmails;
};

const defaultValues: FormValues = {
  name: "",
  description: "",
  auto_assign_at_deadline: false,
  auto_assign_assignee_pool: "graders",
  auto_assign_review_due_hours: 72,
  late_grading_reminders_enabled: false,
  late_grading_reminder_interval_hours: 12,
  late_grading_reply_to: "",
  late_grading_cc_emails: { emails: [] }
};

const parseCcEmails = (value: string): GradingCcEmails => ({
  emails: value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
});

const normalizeCcEmails = (value: unknown): GradingCcEmails => {
  if (value && typeof value === "object" && "emails" in value) {
    const emails = (value as { emails?: unknown }).emails;
    if (Array.isArray(emails)) {
      return {
        emails: emails
          .filter((email): email is string => typeof email === "string")
          .map((email) => email.trim())
          .filter((email) => email.length > 0)
      };
    }
  }

  return { emails: [] };
};

const toCcText = (value: unknown): string => normalizeCcEmails(value).emails.join(", ");

export default function GradingAssignmentDefaultsPage() {
  const { course_id } = useParams();
  const classId = Number(course_id);
  const isValidClassId = Number.isFinite(classId);
  const [editingId, setEditingId] = useState<number | null>(null);

  const form = useForm<FormValues>({ defaultValues });
  const {
    register,
    control,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting }
  } = form;

  const remindersEnabled = watch("late_grading_reminders_enabled");
  const autoAssignEnabled = watch("auto_assign_at_deadline");
  const ccValue = watch("late_grading_cc_emails");
  const ccText = toCcText(ccValue);

  const { data: profileData, refetch } = useList<GradingAssignmentDefaultProfile>({
    resource: "grading_assignment_default_profiles",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    sorters: [{ field: "name", order: "asc" }],
    pagination: { pageSize: 200 },
    queryOptions: { enabled: isValidClassId }
  });

  const profiles = useMemo(() => profileData?.data ?? [], [profileData?.data]);

  const { mutateAsync: createProfile } = useCreate();
  const { mutateAsync: updateProfile } = useUpdate();
  const { mutateAsync: deleteProfile } = useDelete();

  const startEdit = (profile: GradingAssignmentDefaultProfile) => {
    setEditingId(profile.id);
    reset({
      name: profile.name,
      description: profile.description ?? "",
      auto_assign_at_deadline: profile.auto_assign_at_deadline,
      auto_assign_assignee_pool: profile.auto_assign_assignee_pool,
      auto_assign_review_due_hours: profile.auto_assign_review_due_hours,
      late_grading_reminders_enabled: profile.late_grading_reminders_enabled,
      late_grading_reminder_interval_hours: profile.late_grading_reminder_interval_hours ?? 12,
      late_grading_reply_to: profile.late_grading_reply_to ?? "",
      late_grading_cc_emails: normalizeCcEmails(profile.late_grading_cc_emails)
    });
  };

  const clearForm = () => {
    setEditingId(null);
    reset(defaultValues);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    if (!isValidClassId) {
      toaster.error({
        title: "Invalid course",
        description: "Cannot save grading defaults without a valid course id."
      });
      return;
    }

    const payload = {
      class_id: classId,
      name: values.name.trim(),
      description: values.description?.trim() || null,
      auto_assign_at_deadline: values.auto_assign_at_deadline,
      auto_assign_assignee_pool: values.auto_assign_assignee_pool,
      auto_assign_review_due_hours: values.auto_assign_review_due_hours ?? 72,
      late_grading_reminders_enabled: values.late_grading_reminders_enabled,
      late_grading_reminder_interval_hours: values.late_grading_reminders_enabled
        ? (values.late_grading_reminder_interval_hours ?? 12)
        : null,
      late_grading_reply_to: values.late_grading_reply_to?.trim() || null,
      late_grading_cc_emails: normalizeCcEmails(values.late_grading_cc_emails)
    };

    try {
      if (editingId) {
        await updateProfile({
          resource: "grading_assignment_default_profiles",
          id: editingId,
          values: payload
        });
        toaster.success({ title: "Profile updated" });
      } else {
        await createProfile({
          resource: "grading_assignment_default_profiles",
          values: payload
        });
        toaster.success({ title: "Profile created" });
      }
      clearForm();
      await refetch();
    } catch (error) {
      toaster.error({
        title: editingId ? "Failed to update profile" : "Failed to create profile",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  const handleDelete = async (id: number) => {
    const confirmed = window.confirm("Delete this grading default profile?");
    if (!confirmed) {
      return;
    }

    try {
      await deleteProfile({ resource: "grading_assignment_default_profiles", id });
      toaster.success({ title: "Profile deleted" });
      if (editingId === id) {
        clearForm();
      }
      await refetch();
    } catch (error) {
      toaster.error({
        title: "Failed to delete profile",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  if (!isValidClassId) {
    return (
      <Box p={4}>
        <Heading size="lg">Grading Assignment Defaults</Heading>
        <Text color="fg.error">Invalid course id.</Text>
      </Box>
    );
  }

  return (
    <Box p={4}>
      <Toaster />
      <VStack align="stretch" gap={6}>
        <Box>
          <Heading size="lg">Grading Assignment Defaults</Heading>
          <Text fontSize="sm" color="fg.muted" maxW="4xl">
            Create reusable profiles for grading auto-assignment at deadline and late grading reminders. Instructors can
            apply these profiles when creating or editing assignments.
          </Text>
        </Box>

        <CardRoot>
          <CardHeader>
            <CardTitle>{editingId ? "Edit grading profile" : "New grading profile"}</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={onSubmit}>
              <Fieldset.Root maxW="2xl">
                <Fieldset.Content>
                  <Field
                    label="Profile name"
                    required
                    errorText={errors.name?.message?.toString()}
                    invalid={!!errors.name}
                  >
                    <Input {...register("name", { required: "Profile name is required" })} />
                  </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                  <Field label="Description">
                    <Input {...register("description")} placeholder="Optional note about when to use this profile" />
                  </Field>
                </Fieldset.Content>
                <Fieldset.Content>
                  <Field helperText="Automatically assign grading reviews right at assignment deadline.">
                    <Controller
                      name="auto_assign_at_deadline"
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
                          <Checkbox.Label>Auto assign at deadline</Checkbox.Label>
                        </Checkbox.Root>
                      )}
                    />
                  </Field>
                </Fieldset.Content>
                {autoAssignEnabled && (
                  <>
                    <Fieldset.Content>
                      <Field label="Assignee pool">
                        <NativeSelectRoot>
                          <NativeSelectField {...register("auto_assign_assignee_pool")}>
                            <option value="graders">Graders</option>
                            <option value="instructors">Instructors</option>
                            <option value="instructors_and_graders">Instructors and graders</option>
                          </NativeSelectField>
                        </NativeSelectRoot>
                      </Field>
                    </Fieldset.Content>
                    <Fieldset.Content>
                      <Field
                        label="Review due hours after deadline"
                        errorText={errors.auto_assign_review_due_hours?.message?.toString()}
                        invalid={!!errors.auto_assign_review_due_hours}
                      >
                        <Input
                          type="number"
                          {...register("auto_assign_review_due_hours", {
                            valueAsNumber: true,
                            min: { value: 0, message: "Must be at least 0 hours" }
                          })}
                        />
                      </Field>
                    </Fieldset.Content>
                  </>
                )}
                <Fieldset.Content>
                  <Field helperText="Send late grading reminders at deadline and on a repeat interval.">
                    <Controller
                      name="late_grading_reminders_enabled"
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
                          <Checkbox.Label>Enable late grading reminders</Checkbox.Label>
                        </Checkbox.Root>
                      )}
                    />
                  </Field>
                </Fieldset.Content>
                {remindersEnabled && (
                  <>
                    <Fieldset.Content>
                      <Field
                        label="Reminder interval (hours)"
                        errorText={errors.late_grading_reminder_interval_hours?.message?.toString()}
                        invalid={!!errors.late_grading_reminder_interval_hours}
                      >
                        <Input
                          type="number"
                          {...register("late_grading_reminder_interval_hours", {
                            valueAsNumber: true,
                            min: { value: 1, message: "Must be at least 1 hour" }
                          })}
                        />
                      </Field>
                    </Fieldset.Content>
                    <Fieldset.Content>
                      <Field label="Reply-to email">
                        <Input type="email" {...register("late_grading_reply_to")} />
                      </Field>
                    </Fieldset.Content>
                    <Fieldset.Content>
                      <Field label="CC emails" helperText="Comma-separated emails copied on reminders.">
                        <Input
                          value={ccText}
                          onChange={(event) => setValue("late_grading_cc_emails", parseCcEmails(event.target.value))}
                          placeholder="staff@example.edu, lead-ta@example.edu"
                        />
                      </Field>
                    </Fieldset.Content>
                  </>
                )}
                <Fieldset.Content>
                  <HStack>
                    <Button type="submit" loading={isSubmitting} colorPalette="green">
                      {editingId ? "Update profile" : "Create profile"}
                    </Button>
                    {editingId && (
                      <Button type="button" variant="outline" onClick={clearForm}>
                        Cancel editing
                      </Button>
                    )}
                  </HStack>
                </Fieldset.Content>
              </Fieldset.Root>
            </form>
          </CardBody>
        </CardRoot>

        <CardRoot>
          <CardHeader>
            <CardTitle>Saved profiles</CardTitle>
          </CardHeader>
          <CardBody>
            {profiles.length === 0 ? (
              <Text color="fg.muted">No grading default profiles yet.</Text>
            ) : (
              <VStack align="stretch" gap={3}>
                {profiles.map((profile) => (
                  <Box key={profile.id} borderWidth="1px" borderRadius="md" p={3}>
                    <HStack justify="space-between" align="start">
                      <Box>
                        <Text fontWeight="semibold">{profile.name}</Text>
                        {profile.description && <Text color="fg.muted">{profile.description}</Text>}
                        <Text fontSize="sm" color="fg.muted">
                          Auto assign: {profile.auto_assign_at_deadline ? "on" : "off"} | Reminder:{" "}
                          {profile.late_grading_reminders_enabled
                            ? `every ${profile.late_grading_reminder_interval_hours}h`
                            : "off"}
                        </Text>
                      </Box>
                      <HStack>
                        <Button size="sm" variant="outline" onClick={() => startEdit(profile)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          colorPalette="red"
                          variant="outline"
                          onClick={() => void handleDelete(profile.id)}
                        >
                          Delete
                        </Button>
                      </HStack>
                    </HStack>
                  </Box>
                ))}
              </VStack>
            )}
          </CardBody>
        </CardRoot>
      </VStack>
    </Box>
  );
}
