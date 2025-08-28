"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useUserRolesWithProfiles, useCourseController } from "@/hooks/useCourseController";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Checkbox, Dialog, HStack, Input, Portal, Text, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

type SDEInsert = Database["public"]["Tables"]["student_deadline_extensions"]["Insert"];

export type AddExtensionDefaults = {
  studentId?: string;
  hours?: number;
  includes_lab?: boolean;
};

/**
 * Modal to create a new student-wide deadline extension (student_deadline_extensions).
 */
export default function AddExtensionModal({
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
  const allUserRoles = useUserRolesWithProfiles();
  const { studentDeadlineExtensions } = useCourseController();

  const studentOptions = useMemo(
    () =>
      allUserRoles
        .filter((role) => role.role === "student" && !role.disabled)
        .map((role) => ({
          value: role.private_profile_id,
          label: role.profiles?.name || role.users?.name || role.user_id
        })),
    [allUserRoles]
  );

  const [selectedStudentId, setSelectedStudentId] = useState<string | undefined>(defaults?.studentId);
  const [includeLab, setIncludeLab] = useState<boolean>(defaults?.includes_lab ?? false);
  const [defaultHours, setDefaultHours] = useState<number>(defaults?.hours ?? 24);

  useEffect(() => {
    setSelectedStudentId(defaults?.studentId);
    setIncludeLab(defaults?.includes_lab ?? false);
    setDefaultHours(defaults?.hours ?? 24);
  }, [defaults?.studentId, defaults?.includes_lab, defaults?.hours]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<SDEInsert>();

  const onCloseInternal = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const onSubmitCallback = useCallback(
    async (values: SDEInsert) => {
      if (!selectedStudentId) {
        toaster.error({ title: "Missing data", description: "Please select a student." });
        return;
      }

      if (!private_profile_id) {
        toaster.error({
          title: "Missing creator",
          description: "Your profile isn't loaded yet. Please try again in a moment."
        });
        return;
      }

      const data: SDEInsert = {
        ...values,
        class_id: course_id,
        student_id: selectedStudentId,
        includes_lab: includeLab
      };

      try {
        await studentDeadlineExtensions.create(data);
        toaster.create({
          title: "Extension added",
          description: "The student-wide extension has been created.",
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
    [selectedStudentId, private_profile_id, course_id, includeLab, onCloseInternal, studentDeadlineExtensions]
  );

  const onSubmit = handleSubmit(onSubmitCallback);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(d) => !d.open && onCloseInternal()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={onSubmit}>
            <Dialog.Header>
              <Dialog.Title>Add Student-Wide Extension</Dialog.Title>
              <Dialog.CloseTrigger onClick={onCloseInternal} />
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={4} align="stretch">
                <Field label="Student" required>
                  <Select
                    options={studentOptions}
                    value={studentOptions.find((o) => o.value === selectedStudentId) || null}
                    onChange={(opt) => setSelectedStudentId((opt as { value: string } | undefined | null)?.value)}
                    placeholder="Select student"
                    isClearable
                  />
                </Field>
                <Field label="Hours" errorText={errors.hours?.message?.toString()} invalid={!!errors.hours} required>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={defaultHours}
                    {...register("hours", { valueAsNumber: true, min: 0, required: true })}
                  />
                </Field>
                <HStack>
                  <Checkbox.Root
                    checked={!!includeLab}
                    onCheckedChange={(c) => setIncludeLab(c.checked.valueOf() === true)}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Text ml={2}>Include lab assignments</Text>
                  </Checkbox.Root>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={3} justifyContent="flex-end">
                <Button variant="outline" colorPalette="red" onClick={onCloseInternal} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button colorPalette="green" type="submit" loading={isSubmitting}>
                  Add Extension
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
