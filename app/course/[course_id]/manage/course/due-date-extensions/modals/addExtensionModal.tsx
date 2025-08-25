"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useUserRolesWithProfiles } from "@/hooks/useCourseController";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Checkbox, Dialog, HStack, Input, Portal, Text, VStack } from "@chakra-ui/react";
import { useForm } from "@refinedev/react-hook-form";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

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
  const { course_id } = useParams<{ course_id: string }>();
  const allUserRoles = useUserRolesWithProfiles();

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
    setValue,
    formState: { errors, isSubmitting },
    refineCore
  } = useForm<SDEInsert>({ refineCoreProps: { resource: "student_deadline_extensions", action: "create" } });

  const onCloseInternal = () => {
    reset();
    onClose();
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedStudentId) {
      toaster.error({ title: "Missing data", description: "Please select a student." });
      return;
    }
    setValue("class_id", Number(course_id));
    setValue("student_id", selectedStudentId);
    setValue("includes_lab", includeLab);
    handleSubmit(async (values) => {
      try {
        await refineCore.onFinish?.(values);
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
    })();
  };

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
