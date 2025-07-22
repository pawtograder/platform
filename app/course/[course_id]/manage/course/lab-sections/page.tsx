"use client";

import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { PopConfirm } from "@/components/ui/popconfirm";
import useModalManager from "@/hooks/useModalManager";
import { DayOfWeek, LabSectionWithLeader, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Container,
  Dialog,
  Field,
  Heading,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCreate, useDelete, useInvalidate, useList, useUpdate } from "@refinedev/core";
import { format } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { useForm } from "react-hook-form";
import { FaEdit, FaPlus, FaTrash } from "react-icons/fa";

interface CreateLabSectionData {
  name: string;
  day_of_week: DayOfWeek;
  start_time: string;
  end_time?: string;
  lab_leader_id: string;
  description?: string;
}

interface EditLabSectionData extends CreateLabSectionData {
  id: number;
}

const DAYS_OF_WEEK: { value: DayOfWeek; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" }
];

function CreateLabSectionModal({
  isOpen,
  onClose,
  onSuccess,
  initialData
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: EditLabSectionData;
}) {
  const { course_id } = useParams();
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset
  } = useForm<CreateLabSectionData>({
    defaultValues: {
      name: "",
      day_of_week: "monday",
      start_time: "10:00",
      end_time: "11:00",
      lab_leader_id: "",
      description: ""
    }
  });

  const { mutateAsync: createLabSection, isLoading: isCreating } = useCreate();
  const { mutateAsync: updateLabSection, isLoading: isUpdating } = useUpdate();

  // Get instructors and graders for lab leader selection
  const { data: staffRoles } = useList<UserRoleWithPrivateProfileAndUser>({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: course_id as string },
      {
        operator: "or",
        value: [
          { field: "role", operator: "eq", value: "instructor" },
          { field: "role", operator: "eq", value: "grader" }
        ]
      }
    ],
    meta: {
      select: "*, profiles!private_profile_id(*), users(*)"
    }
  });

  useEffect(() => {
    if (initialData) {
      reset({
        name: initialData.name,
        day_of_week: initialData.day_of_week,
        start_time: initialData.start_time,
        end_time: initialData.end_time,
        lab_leader_id: initialData.lab_leader_id,
        description: initialData.description
      });
    } else {
      reset({
        name: "",
        day_of_week: "monday",
        start_time: "10:00",
        end_time: "11:00",
        lab_leader_id: "",
        description: ""
      });
    }
  }, [initialData, isOpen, reset]);

  const onSubmit = useCallback(
    async (data: CreateLabSectionData) => {
      try {
        if (initialData) {
          await updateLabSection({
            resource: "lab_sections",
            id: initialData.id,
            values: {
              ...data,
              class_id: Number(course_id)
            }
          });
          toaster.success({
            title: "Lab section updated successfully"
          });
        } else {
          await createLabSection({
            resource: "lab_sections",
            values: {
              ...data,
              class_id: Number(course_id)
            }
          });
          toaster.success({
            title: "Lab section created successfully"
          });
        }
        onSuccess();
        onClose();
      } catch (error) {
        toaster.error({
          title: "Error saving lab section",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      }
    },
    [initialData, updateLabSection, createLabSection, course_id, onSuccess, onClose]
  );

  return (
    <Portal>
      <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{initialData ? "Edit Lab Section" : "Create Lab Section"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <form onSubmit={handleSubmit(onSubmit)}>
                <VStack gap={4}>
                  <Field.Root invalid={!!errors.name}>
                    <Field.Label>Name</Field.Label>
                    <Input placeholder="e.g., Lab Section A" {...register("name", { required: "Name is required" })} />
                    <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
                  </Field.Root>

                  <Field.Root invalid={!!errors.day_of_week}>
                    <Field.Label>Day of Week</Field.Label>
                    <NativeSelect.Root>
                      <NativeSelect.Field {...register("day_of_week", { required: "Day of week is required" })}>
                        {DAYS_OF_WEEK.map((day) => (
                          <option key={day.value} value={day.value}>
                            {day.label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                    <Field.ErrorText>{errors.day_of_week?.message}</Field.ErrorText>
                  </Field.Root>

                  <HStack gap={4} width="100%">
                    <Field.Root invalid={!!errors.start_time}>
                      <Field.Label>Start Time</Field.Label>
                      <Input type="time" {...register("start_time", { required: "Start time is required" })} />
                      <Field.ErrorText>{errors.start_time?.message}</Field.ErrorText>
                    </Field.Root>

                    <Field.Root invalid={!!errors.end_time}>
                      <Field.Label>End Time</Field.Label>
                      <Input type="time" {...register("end_time")} />
                      <Field.ErrorText>{errors.end_time?.message}</Field.ErrorText>
                    </Field.Root>
                  </HStack>

                  <Field.Root invalid={!!errors.lab_leader_id}>
                    <Field.Label>Lab Leader</Field.Label>
                    <NativeSelect.Root>
                      <NativeSelect.Field {...register("lab_leader_id", { required: "Lab leader is required" })}>
                        <option value="">Select a lab leader...</option>
                        {staffRoles?.data?.map((role) => (
                          <option key={role.private_profile_id} value={role.private_profile_id}>
                            {role.profiles?.name} ({role.role})
                          </option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                    <Field.ErrorText>{errors.lab_leader_id?.message}</Field.ErrorText>
                  </Field.Root>

                  <Field.Root invalid={!!errors.description}>
                    <Field.Label>Description (Optional)</Field.Label>
                    <Input placeholder="Optional description" {...register("description")} />
                    <Field.ErrorText>{errors.description?.message}</Field.ErrorText>
                  </Field.Root>
                </VStack>
              </form>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button onClick={handleSubmit(onSubmit)} loading={isCreating || isUpdating} colorPalette="blue">
                {initialData ? "Update" : "Create"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Portal>
  );
}

function LabSectionsTable() {
  const { course_id } = useParams();
  const invalidate = useInvalidate();
  const { mutateAsync: deleteLabSection, isLoading: isDeleting } = useDelete();

  const {
    isOpen: isCreateModalOpen,
    modalData: editingLabSection,
    openModal: openCreateModal,
    closeModal: closeCreateModal
  } = useModalManager<EditLabSectionData | undefined>();

  // Get lab sections with leader info
  const { data: labSections, isLoading } = useList<LabSectionWithLeader>({
    resource: "lab_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id as string }],
    meta: {
      select: "*, profiles!lab_sections_lab_leader_id_fkey(*)"
    },
    sorters: [
      { field: "day_of_week", order: "asc" },
      { field: "start_time", order: "asc" }
    ]
  });

  const handleCreateNew = () => {
    openCreateModal(undefined);
  };

  const handleEdit = (labSection: LabSectionWithLeader) => {
    openCreateModal({
      id: labSection.id,
      name: labSection.name,
      day_of_week: labSection.day_of_week as DayOfWeek,
      start_time: labSection.start_time,
      end_time: labSection.end_time || undefined,
      lab_leader_id: labSection.lab_leader_id,
      description: labSection.description || undefined
    });
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteLabSection({
        resource: "lab_sections",
        id
      });
      toaster.success({
        title: "Lab section deleted successfully"
      });
      invalidate({ resource: "lab_sections", invalidates: ["list"] });
    } catch (error) {
      toaster.error({
        title: "Error deleting lab section",
        description: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
  };

  const handleModalSuccess = () => {
    invalidate({ resource: "lab_sections", invalidates: ["list"] });
  };

  const formatTime = (time: string) => {
    return format(new Date(`2000-01-01T${time}`), "h:mm a");
  };

  const getDayDisplayName = (day: string) => {
    return DAYS_OF_WEEK.find((d) => d.value === day)?.label || day;
  };

  if (isLoading) {
    return <Text>Loading lab sections...</Text>;
  }

  return (
    <>
      <VStack gap={4}>
        <HStack justify="space-between" width="100%">
          <Heading size="lg">Lab Sections</Heading>
          <Button onClick={handleCreateNew} size="sm">
            <FaPlus /> Create Lab Section
          </Button>
        </HStack>

        {labSections?.data?.length === 0 ? (
          <Box p={8} textAlign="center" border="1px dashed" borderColor="border.muted" borderRadius="md">
            <Text color="fg.muted">No lab sections created yet.</Text>
            <Button mt={2} onClick={handleCreateNew} variant="outline" size="sm">
              Create your first lab section
            </Button>
          </Box>
        ) : (
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Name</Table.ColumnHeader>
                <Table.ColumnHeader>Schedule</Table.ColumnHeader>
                <Table.ColumnHeader>Lab Leader</Table.ColumnHeader>
                <Table.ColumnHeader>Students</Table.ColumnHeader>
                <Table.ColumnHeader>Actions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {labSections?.data?.map((labSection) => (
                <Table.Row key={labSection.id}>
                  <Table.Cell>
                    <VStack gap={1} align="start">
                      <Text fontWeight="medium">{labSection.name}</Text>
                      {labSection.description && (
                        <Text fontSize="sm" color="fg.muted">
                          {labSection.description}
                        </Text>
                      )}
                    </VStack>
                  </Table.Cell>
                  <Table.Cell>
                    <VStack gap={1} align="start">
                      <Text>{getDayDisplayName(labSection.day_of_week)}</Text>
                      <Text fontSize="sm" color="fg.muted">
                        {formatTime(labSection.start_time)}
                        {labSection.end_time && ` - ${formatTime(labSection.end_time)}`}
                      </Text>
                    </VStack>
                  </Table.Cell>
                  <Table.Cell>
                    <Text>{labSection.profiles?.name}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm" color="fg.muted">
                      {/* TODO: Add student count */}0 students
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack gap={2}>
                      <Tooltip content="Edit lab section">
                        <Button size="sm" variant="ghost" onClick={() => handleEdit(labSection)}>
                          <FaEdit />
                        </Button>
                      </Tooltip>
                      <PopConfirm
                        triggerLabel="Delete lab section"
                        trigger={
                            <Button
                              size="sm"
                              variant="ghost"
                              colorPalette="red"
                              loading={isDeleting}
                            >
                              <FaTrash />
                            </Button>
                        }
                        confirmHeader="Delete Lab Section"
                        confirmText={`Are you sure you want to delete "${labSection.name}"? This action cannot be undone.`}
                        onConfirm={() => handleDelete(labSection.id)}
                        onCancel={() => {}}
                      />
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </VStack>

      <CreateLabSectionModal
        isOpen={isCreateModalOpen}
        onClose={closeCreateModal}
        onSuccess={handleModalSuccess}
        initialData={editingLabSection}
      />
    </>
  );
}

export default function LabSectionsPage() {
  return (
    <Container maxW="6xl">
      <LabSectionsTable />
      <Toaster />
    </Container>
  );
}
