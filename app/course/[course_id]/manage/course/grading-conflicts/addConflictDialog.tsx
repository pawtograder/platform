"use client";

import { useMemo, useEffect } from "react";
import { Textarea, VStack, Portal, HStack, Dialog, Text } from "@chakra-ui/react";
import { useList, useCreate, HttpError } from "@refinedev/core";
import { Button } from "@/components/ui/button";
import { Database, TablesInsert } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { Field } from "@/components/ui/field";
import { useForm } from "@refinedev/react-hook-form";
import { Controller, SubmitHandler } from "react-hook-form";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import PersonName from "@/components/ui/person-name";

type GradingConflict = Database["public"]["Tables"]["grading_conflicts"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"];

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

  const { data: staffData, isLoading: isLoadingStaff } = useList<UserRoleRow & { profiles: ProfileRow }>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "role", operator: "in", value: ["instructor", "grader"] }
    ],
    meta: {
      select: "*, profiles!private_profile_id(id, name, sortable_name)"
    },
    // Only load staff data if user is instructor
    queryOptions: {
      enabled: isInstructor
    }
  });

  const staffOptions: FormOption[] = useMemo(
    () =>
      staffData?.data
        ?.map((userRole) => ({
          value: userRole.profiles.id,
          label: userRole.profiles.sortable_name || userRole.profiles.name || userRole.profiles.id
        }))
        .sort((a, b) => a.label.localeCompare(b.label)) || [],
    [staffData]
  );

  const { data: studentData, isLoading: isLoadingStudents } = useList<UserRoleRow & { profiles: ProfileRow }>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "role", operator: "eq", value: "student" }
    ],
    meta: {
      select: "*, profiles!private_profile_id(id, name, sortable_name)"
    }
  });

  const studentOptions: FormOption[] = useMemo(
    () =>
      studentData?.data
        ?.map((userRole) => ({
          value: userRole.profiles.id,
          label: userRole.profiles.sortable_name || userRole.profiles.name || userRole.profiles.id
        }))
        .sort((a, b) => a.label.localeCompare(b.label)) || [],
    [studentData]
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
                            isLoading={isLoadingStaff}
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
                        <Text fontSize="sm" color="fg.muted">Please contact your instructor to report conflicts regarding other graders</Text>
                      </VStack>
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
                          isLoading={isLoadingStudents}
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
