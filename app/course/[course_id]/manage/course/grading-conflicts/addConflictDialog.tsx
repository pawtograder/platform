"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import PersonName from "@/components/ui/person-name";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles, useGradersAndInstructors, useStudentRoster } from "@/hooks/useClassProfiles";
import { Database, TablesInsert } from "@/utils/supabase/SupabaseTypes";
import { Dialog, HStack, Portal, Text, Textarea, VStack } from "@chakra-ui/react";
import { HttpError, useCreate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import { useEffect, useMemo } from "react";
import { Controller, SubmitHandler } from "react-hook-form";

type GradingConflict = Database["public"]["Tables"]["grading_conflicts"]["Row"];

interface FormOption extends OptionBase {
  value: string;
  label: string;
}

type GradingConflictFormData = {
  grader_profile_id: string;
  student_profile_id: string;
  reason: string;
};

export default function AddConflictDialog({
  courseId,
  onSuccess,
  isOpen,
  closeModal
}: {
  courseId: number;
  onSuccess: () => void;
  isOpen: boolean;
  closeModal: () => void;
}) {
  const { private_profile_id, role } = useClassProfiles();
  const studentRoster = useStudentRoster();
  const gradersAndInstructors = useGradersAndInstructors();
  const isGrader = role.role === "grader";
  const isInstructor = role.role === "instructor";

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    control,
    setValue
  } = useForm<GradingConflictFormData, HttpError, GradingConflictFormData>({
    defaultValues: {
      grader_profile_id: "",
      student_profile_id: "",
      reason: ""
    }
  });

  // Auto-set grader field for graders
  useEffect(() => {
    if (isGrader) {
      setValue("grader_profile_id", private_profile_id);
    }
  }, [isGrader, private_profile_id, setValue]);

  const { mutate: createConflict, isLoading: isCreating } = useCreate<GradingConflict>();

  const staffOptions: FormOption[] = useMemo(
    () =>
      gradersAndInstructors
        ?.map((profile) => ({
          value: profile.id,
          label: profile.sortable_name || profile.name || profile.id
        }))
        .sort((a, b) => a.label.localeCompare(b.label)) || [],
    [gradersAndInstructors]
  );

  const studentOptions: FormOption[] = useMemo(
    () =>
      studentRoster
        ?.map((profile) => ({
          value: profile.id,
          label: profile.sortable_name || profile.name || profile.id
        }))
        .sort((a, b) => a.label.localeCompare(b.label)) || [],
    [studentRoster]
  );

  const onSubmit: SubmitHandler<GradingConflictFormData> = (data: GradingConflictFormData) => {
    createConflict(
      {
        resource: "grading_conflicts",
        values: {
          class_id: courseId,
          grader_profile_id: data.grader_profile_id,
          student_profile_id: data.student_profile_id,
          reason: data.reason,
          created_by_profile_id: private_profile_id
        } as TablesInsert<"grading_conflicts">
      },
      {
        onSuccess: () => {
          toaster.success({ title: "Conflict added successfully" });
          onSuccess();
          closeModal();
          reset();
        },
        onError: (error) => {
          toaster.error({ title: "Error adding conflict", description: error.message });
        }
      }
    );
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details: { open: boolean }) => !details.open && closeModal()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Add New Grading Conflict</Dialog.Title>
              <Dialog.CloseTrigger onClick={closeModal} />
            </Dialog.Header>
            <Dialog.Body>
              <form onSubmit={handleSubmit(onSubmit)}>
                <VStack gap={4} align="stretch">
                  {isInstructor ? (
                    <Field label="Grader" errorText={errors.grader_profile_id?.message as string | undefined}>
                      <Controller
                        control={control}
                        name="grader_profile_id"
                        rules={{ required: "Grader is required" }}
                        render={({ field }) => (
                          <ChakraReactSelect
                            options={staffOptions}
                            placeholder="Select Grader"
                            value={staffOptions.find((c) => c.value === field.value)}
                            onChange={(option: FormOption | null) => setValue("grader_profile_id", option?.value || "")}
                            onBlur={field.onBlur}
                          />
                        )}
                      />
                    </Field>
                  ) : (
                    <Field label="Grader">
                      <VStack align="start" p={3} borderRadius="md" border="1px solid" borderColor="gray.200">
                        <PersonName uid={private_profile_id} />
                      </VStack>
                      <Text fontSize="sm" color="fg.muted">
                        Please contact your instructor to report conflicts regarding other graders
                      </Text>
                    </Field>
                  )}

                  <Field label="Student" errorText={errors.student_profile_id?.message as string | undefined}>
                    <Controller
                      control={control}
                      name="student_profile_id"
                      rules={{ required: "Student is required" }}
                      render={({ field }) => (
                        <ChakraReactSelect
                          options={studentOptions}
                          placeholder="Select Student"
                          value={studentOptions.find((c) => c.value === field.value)}
                          onChange={(option: FormOption | null) => setValue("student_profile_id", option?.value || "")}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                  </Field>
                  <Field label="Reason (Optional)" errorText={errors.reason?.message as string | undefined}>
                    <Textarea {...register("reason")} placeholder="Enter reason for the conflict" />
                  </Field>
                </VStack>
                <HStack justifyContent="flex-end" mt={6}>
                  <Dialog.CloseTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={() => {
                        closeModal();
                        reset();
                      }}
                      colorPalette="red"
                    >
                      Cancel
                    </Button>
                  </Dialog.CloseTrigger>
                  <Button type="submit" loading={isCreating} colorPalette="green">
                    Save Conflict
                  </Button>
                </HStack>
              </form>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
