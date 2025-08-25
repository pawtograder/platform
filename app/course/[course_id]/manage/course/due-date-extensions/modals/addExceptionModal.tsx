"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles } from "@/hooks/useCourseController";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Assignment, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Dialog, HStack, Input, Portal, Textarea, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

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
  const { course_id } = useParams<{ course_id: string }>();
  const { private_profile_id } = useClassProfiles();

  const students = useAllStudentProfiles();

  // Load all assignments for this class
  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id) }],
    pagination: { pageSize: 1000 },
    sorters: [
      { field: "due_date", order: "asc" },
      { field: "id", order: "asc" }
    ]
  });

  const assignmentOptions = useMemo(
    () =>
      (assignmentsData?.data || []).map((a) => ({
        value: a.id,
        label: a.title || `Assignment #${a.id}`
      })),
    [assignmentsData?.data]
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
    setValue,
    formState: { errors, isSubmitting },
    refineCore
  } = useForm<ADEInsert>({ refineCoreProps: { resource: "assignment_due_date_exceptions", action: "create" } });

  const onCloseInternal = () => {
    reset();
    onClose();
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedAssignmentId || !selectedStudentId) {
      toaster.error({
        title: "Missing data",
        description: !selectedAssignmentId ? "Please select an assignment." : "Please select a student."
      });
      return;
    }
    setValue("class_id", Number(course_id));
    setValue("assignment_id", selectedAssignmentId);
    setValue("student_id", selectedStudentId);
    setValue("creator_id", private_profile_id || "");
    handleSubmit(async (values) => {
      try {
        await refineCore.onFinish?.(values);
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
    })();
  };

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
