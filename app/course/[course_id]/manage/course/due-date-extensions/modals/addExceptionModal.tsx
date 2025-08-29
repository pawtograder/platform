"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAllStudentProfiles, useAssignments, useCourseController } from "@/hooks/useCourseController";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Dialog, HStack, Input, Portal, Textarea, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

type ADEInsert = Database["public"]["Tables"]["assignment_due_date_exceptions"]["Insert"];

export type AddExtensionDefaults = {
  assignmentId?: number;
  studentId?: string;
};

/**
 * Modal to create a new assignment_due_date_exceptions row.
 */
export default function AddExceptionModal({
  isOpen,
  onClose,
  defaults
}: {
  isOpen: boolean;
  onClose: () => void;
  defaults?: AddExtensionDefaults;
}) {
  const { private_profile_id, role } = useClassProfiles();
  const course_id = role.class_id;

  const students = useAllStudentProfiles();
  const assignments = useAssignments();
  const { assignmentDueDateExceptions } = useCourseController();

  const assignmentOptions = useMemo(
    () =>
      (assignments || []).map((a) => ({
        value: a.id,
        label: a.title || `Assignment #${a.id}`
      })),
    [assignments]
  );

  const studentOptions = useMemo(
    () =>
      (students || []).map((s: UserProfile) => ({
        value: s.id,
        label: s.name || s.id
      })),
    [students]
  );

  const [selectedAssignmentId, setSelectedAssignmentId] = useState<number | undefined>(defaults?.assignmentId);
  const [selectedStudentId, setSelectedStudentId] = useState<string | undefined>(defaults?.studentId);

  useEffect(() => {
    setSelectedAssignmentId(defaults?.assignmentId);
    setSelectedStudentId(defaults?.studentId);
  }, [defaults?.assignmentId, defaults?.studentId]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ADEInsert>();

  const onCloseInternal = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const onSubmitCallback = useCallback(
    async (values: ADEInsert) => {
      if (!selectedAssignmentId || !selectedStudentId) {
        toaster.error({
          title: "Missing data",
          description: !selectedAssignmentId ? "Please select an assignment." : "Please select a student."
        });
        return;
      }

      if (!private_profile_id) {
        toaster.error({
          title: "Missing creator",
          description: "Your profile isn't loaded yet. Please try again in a moment."
        });
        return;
      }

      const data: ADEInsert = {
        ...values,
        class_id: course_id,
        assignment_id: selectedAssignmentId,
        student_id: selectedStudentId,
        creator_id: private_profile_id
      };

      try {
        await assignmentDueDateExceptions.create(data);
        toaster.create({
          title: "Extension added",
          description: "The due date exception has been created.",
          type: "success"
        });
        onCloseInternal();
      } catch (error) {
        toaster.error({
          title: "Failed to add extension",
          description: error instanceof Error ? error.message : "An unknown error occurred."
        });
      }
    },
    [
      selectedAssignmentId,
      selectedStudentId,
      private_profile_id,
      course_id,
      onCloseInternal,
      assignmentDueDateExceptions
    ]
  );

  const onSubmit = handleSubmit(onSubmitCallback);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(d) => !d.open && onCloseInternal()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={onSubmit}>
            <Dialog.Header>
              <Dialog.Title>Add Due Date Exception</Dialog.Title>
              <Dialog.CloseTrigger onClick={onCloseInternal} />
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={4} align="stretch">
                <Field label="Assignment" required>
                  <Select
                    options={assignmentOptions}
                    value={assignmentOptions.find((o) => o.value === selectedAssignmentId) || null}
                    onChange={(opt) => setSelectedAssignmentId((opt as { value: number } | null)?.value)}
                    placeholder="Select assignment"
                  />
                </Field>
                <Field label="Student" required>
                  <Select
                    options={studentOptions}
                    value={studentOptions.find((o) => o.value === selectedStudentId) || null}
                    onChange={(opt) => setSelectedStudentId((opt as { value: string } | null)?.value)}
                    placeholder="Select student"
                  />
                </Field>
                <HStack gap={3} alignItems="flex-start">
                  <Field label="Hours" errorText={errors.hours?.message?.toString()} invalid={!!errors.hours} required>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      {...register("hours", { valueAsNumber: true, min: 0, required: true })}
                    />
                  </Field>
                  <Field label="Minutes" errorText={errors.minutes?.message?.toString()} invalid={!!errors.minutes}>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      step={1}
                      defaultValue={0}
                      {...register("minutes", { valueAsNumber: true, min: 0, max: 59 })}
                    />
                  </Field>
                  <Field
                    label="Tokens Consumed"
                    errorText={errors.tokens_consumed?.message?.toString()}
                    invalid={!!errors.tokens_consumed}
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={0}
                      {...register("tokens_consumed", { valueAsNumber: true, min: 0 })}
                    />
                  </Field>
                </HStack>
                <Field label="Note" errorText={errors.note?.message?.toString()} invalid={!!errors.note}>
                  <Textarea placeholder="Optional note" {...register("note")} />
                </Field>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={3} justifyContent="flex-end">
                <Button variant="outline" colorPalette="red" onClick={onCloseInternal} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button colorPalette="green" type="submit" loading={isSubmitting}>
                  Add Exception
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
