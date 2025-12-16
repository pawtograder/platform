"use client";

import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { PopConfirm } from "@/components/ui/popconfirm";
import useModalManager from "@/hooks/useModalManager";
import {
  DayOfWeek,
  LabSection,
  LabSectionMeeting,
  UserRoleWithPrivateProfileAndUser
} from "@/utils/supabase/DatabaseTypes";
import {
  Alert,
  Box,
  Container,
  Dialog,
  Field,
  Heading,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { format } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { FaCalendar, FaEdit, FaPlus, FaTrash } from "react-icons/fa";
import { useCourseController } from "@/hooks/useCourseController";
import { useIsTableControllerReady, useTableControllerTableValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Select, MultiValue } from "chakra-react-select";

interface CreateLabSectionData {
  name: string;
  day_of_week: DayOfWeek;
  start_time: string;
  end_time?: string;
  lab_leader_ids: string[];
  meeting_location?: string;
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
  const controller = useCourseController();
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedLeaders, setSelectedLeaders] = useState<MultiValue<{ value: string; label: string }>>([]);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue
  } = useForm<CreateLabSectionData>({
    defaultValues: {
      name: "",
      day_of_week: "monday",
      start_time: "10:00",
      end_time: "11:00",
      lab_leader_ids: [],
      meeting_location: "",
      description: ""
    },
    mode: "onChange"
  });

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

  // Fetch existing lab section leaders when editing
  useEffect(() => {
    const fetchLeaders = async () => {
      if (initialData?.id && initialData.lab_leader_ids) {
        // Fetch profile names for the selected leader IDs
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, name")
          .in("id", initialData.lab_leader_ids);

        if (profiles) {
          const leaderOptions = profiles.map((p) => ({
            value: p.id,
            label: p.name || "Unknown"
          }));
          setSelectedLeaders(leaderOptions);
        }
      } else {
        setSelectedLeaders([]);
      }
    };

    if (isOpen) {
      fetchLeaders();
    }
  }, [initialData, isOpen, supabase]);

  useEffect(() => {
    if (initialData) {
      reset({
        name: initialData.name,
        day_of_week: initialData.day_of_week,
        start_time: initialData.start_time,
        end_time: initialData.end_time,
        lab_leader_ids: initialData.lab_leader_ids || [],
        meeting_location: initialData.meeting_location,
        description: initialData.description
      });
    } else {
      reset({
        name: "",
        day_of_week: "monday",
        start_time: "10:00",
        end_time: "11:00",
        lab_leader_ids: [],
        meeting_location: "",
        description: ""
      });
    }
  }, [initialData, isOpen, reset]);

  const onSubmit = useCallback(
    async (data: CreateLabSectionData) => {
      setIsLoading(true);
      try {
        // Validate at least one lab leader
        if (!data.lab_leader_ids || data.lab_leader_ids.length === 0) {
          toaster.error({
            title: "Validation Error",
            description: "At least one lab leader is required"
          });
          setIsLoading(false);
          return;
        }

        const labSectionData = {
          name: data.name,
          day_of_week: data.day_of_week,
          start_time: data.start_time,
          end_time: data.end_time || null,
          meeting_location: data.meeting_location || null,
          description: data.description || null,
          class_id: Number(course_id),
          campus: null,
          meeting_times: null,
          sis_crn: null
        };

        let labSectionId: number;

        if (initialData) {
          // Update lab section
          await controller.labSections.update(initialData.id, labSectionData);
          labSectionId = initialData.id;

          // Update lab section leaders: delete existing and insert new ones
          const { error: deleteError } = await supabase
            .from("lab_section_leaders")
            .delete()
            .eq("lab_section_id", labSectionId);

          if (deleteError) {
            throw new Error(`Failed to delete existing leaders: ${deleteError.message}`);
          }

          if (data.lab_leader_ids.length > 0) {
            const { error: insertError } = await supabase.from("lab_section_leaders").insert(
              data.lab_leader_ids.map((profile_id) => ({
                lab_section_id: labSectionId,
                profile_id
              }))
            );

            if (insertError) {
              throw new Error(`Failed to insert leaders: ${insertError.message}`);
            }
          }

          // Refresh lab section meetings after update to show recalculated meetings
          await controller.labSectionMeetings.refetchAll();
          toaster.success({
            title: "Lab section updated successfully"
          });
        } else {
          // Create lab section
          const result = await controller.labSections.create(labSectionData);
          labSectionId = result.id;

          // Insert lab section leaders
          if (data.lab_leader_ids.length > 0) {
            const { error: insertError } = await supabase.from("lab_section_leaders").insert(
              data.lab_leader_ids.map((profile_id) => ({
                lab_section_id: labSectionId,
                profile_id
              }))
            );

            if (insertError) {
              throw new Error(`Failed to insert leaders: ${insertError.message}`);
            }
          }

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
      } finally {
        setIsLoading(false);
      }
    },
    [initialData, controller, course_id, onSuccess, onClose, supabase]
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
                  {initialData && (
                    <Alert.Root status="warning">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>Schedule Change Warning</Alert.Title>
                        <Alert.Description>
                          Changing the day of week will automatically recalculate all lab section meetings based on the
                          new schedule. Existing meetings will be removed and new ones generated.
                        </Alert.Description>
                      </Alert.Content>
                    </Alert.Root>
                  )}

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
                      <Input
                        type="time"
                        {...register("end_time", {
                          validate: (value, formValues) => {
                            if (!value || !formValues.start_time) return true;
                            const startTime = new Date(`2000-01-01T${formValues.start_time}`);
                            const endTime = new Date(`2000-01-01T${value}`);
                            return endTime > startTime || "End time must be after start time";
                          }
                        })}
                      />
                      <Field.ErrorText>{errors.end_time?.message}</Field.ErrorText>
                    </Field.Root>
                  </HStack>

                  <Field.Root invalid={!!errors.lab_leader_ids}>
                    <Field.Label>Lab Leaders</Field.Label>
                    <Select
                      isMulti
                      options={staffRoles?.data?.map((role) => ({
                        value: role.private_profile_id,
                        label: `${role.profiles?.name || "Unknown"} (${role.role})`
                      }))}
                      value={selectedLeaders}
                      onChange={(selected) => {
                        const newLeaders = selected || [];
                        setSelectedLeaders(newLeaders);
                        const leaderIds = newLeaders.map((s) => s.value);
                        setValue("lab_leader_ids", leaderIds, {
                          shouldValidate: true
                        });
                      }}
                      placeholder="Select lab leaders..."
                    />
                    <Field.ErrorText>{errors.lab_leader_ids?.message}</Field.ErrorText>
                  </Field.Root>

                  <Field.Root invalid={!!errors.meeting_location}>
                    <Field.Label>Room Location (Optional)</Field.Label>
                    <Input placeholder="e.g., Room 101, Building A" {...register("meeting_location")} />
                    <Field.ErrorText>{errors.meeting_location?.message}</Field.ErrorText>
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
              <Button onClick={handleSubmit(onSubmit)} loading={isLoading} colorPalette="green">
                {initialData ? "Update" : "Create"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Portal>
  );
}

function ManageMeetingsModal({
  isOpen,
  onClose,
  labSection,
  onAddMeeting
}: {
  isOpen: boolean;
  onClose: () => void;
  labSection: LabSection | null;
  onAddMeeting: (labSection: LabSection) => void;
}) {
  const controller = useCourseController();
  const labSectionMeetings = useTableControllerTableValues(controller.labSectionMeetings);
  const [isLoading, setIsLoading] = useState(false);

  if (!labSection) return null;

  const sectionMeetings = labSectionMeetings
    .filter((meeting) => meeting.lab_section_id === labSection.id)
    .sort((a, b) => new Date(a.meeting_date).getTime() - new Date(b.meeting_date).getTime());

  const handleToggleCancelled = async (meeting: LabSectionMeeting) => {
    setIsLoading(true);
    try {
      await controller.labSectionMeetings.update(meeting.id, {
        cancelled: !meeting.cancelled
      });
      toaster.success({
        title: meeting.cancelled ? "Meeting restored" : "Meeting cancelled"
      });
    } catch (error) {
      toaster.error({
        title: "Error updating meeting",
        description: error instanceof Error ? error.message : "An unknown error occurred"
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Portal>
      <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="4xl">
            <Dialog.Header>
              <Dialog.Title>Manage Meetings - {labSection.name}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={4}>
                <HStack justify="space-between" width="100%">
                  <Text fontSize="lg" fontWeight="medium">
                    Scheduled Meetings
                  </Text>
                  <Button size="sm" onClick={() => onAddMeeting(labSection)}>
                    <FaPlus /> Add Meeting
                  </Button>
                </HStack>

                {sectionMeetings.length === 0 ? (
                  <Box p={8} textAlign="center" border="1px dashed" borderColor="border.muted" borderRadius="md">
                    <Text color="fg.muted">No meetings scheduled for this lab section.</Text>
                  </Box>
                ) : (
                  <Table.Root>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Date</Table.ColumnHeader>
                        <Table.ColumnHeader>Status</Table.ColumnHeader>
                        <Table.ColumnHeader>Notes</Table.ColumnHeader>
                        <Table.ColumnHeader>Actions</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {sectionMeetings.map((meeting) => (
                        <Table.Row key={meeting.id}>
                          <Table.Cell>
                            <Text fontWeight="medium">
                              {format(new Date(meeting.meeting_date), "EEEE, MMM d, yyyy")}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text
                              fontSize="sm"
                              color={meeting.cancelled ? "fg.error" : "fg.success"}
                              fontWeight="medium"
                            >
                              {meeting.cancelled ? "Cancelled" : "Scheduled"}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text fontSize="sm" color="fg.muted">
                              {meeting.notes || "No notes"}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Button
                              size="sm"
                              variant="outline"
                              colorPalette={meeting.cancelled ? "green" : "red"}
                              onClick={() => handleToggleCancelled(meeting)}
                              loading={isLoading}
                            >
                              {meeting.cancelled ? "Restore" : "Cancel"}
                            </Button>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </Dialog.ActionTrigger>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Portal>
  );
}

interface CreateMeetingData {
  meeting_date: string;
  notes?: string;
}

function CreateMeetingModal({
  isOpen,
  onClose,
  labSection
}: {
  isOpen: boolean;
  onClose: () => void;
  labSection: LabSection | null;
}) {
  const controller = useCourseController();
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset
  } = useForm<CreateMeetingData>({
    defaultValues: {
      meeting_date: "",
      notes: ""
    }
  });

  useEffect(() => {
    if (isOpen && labSection) {
      reset({
        meeting_date: "",
        notes: ""
      });
    }
  }, [isOpen, labSection, reset]);

  const onSubmit = useCallback(
    async (data: CreateMeetingData) => {
      if (!labSection) return;

      setIsLoading(true);
      try {
        const meetingData = {
          lab_section_id: labSection.id,
          class_id: labSection.class_id,
          meeting_date: data.meeting_date,
          cancelled: false,
          notes: data.notes || null
        };

        await controller.labSectionMeetings.create(meetingData);

        toaster.success({
          title: "Meeting created successfully"
        });
        onClose();
      } catch (error) {
        toaster.error({
          title: "Error creating meeting",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      } finally {
        setIsLoading(false);
      }
    },
    [labSection, controller, onClose]
  );

  if (!labSection) return null;

  return (
    <Portal>
      <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Add Meeting - {labSection.name}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <form onSubmit={handleSubmit(onSubmit)}>
                <VStack gap={4}>
                  <Field.Root invalid={!!errors.meeting_date}>
                    <Field.Label>Meeting Date</Field.Label>
                    <Input type="date" {...register("meeting_date", { required: "Meeting date is required" })} />
                    <Field.ErrorText>{errors.meeting_date?.message}</Field.ErrorText>
                    <Field.HelperText>
                      Meeting will use the lab section&apos;s scheduled time:{" "}
                      {labSection.start_time
                        ? format(new Date(`2000-01-01T${labSection.start_time}`), "h:mm a")
                        : "Not set"}{" "}
                      -{" "}
                      {labSection.end_time
                        ? format(new Date(`2000-01-01T${labSection.end_time}`), "h:mm a")
                        : "Not set"}
                    </Field.HelperText>
                  </Field.Root>

                  <Field.Root invalid={!!errors.notes}>
                    <Field.Label>Notes (Optional)</Field.Label>
                    <Input placeholder="Optional notes about this meeting" {...register("notes")} />
                    <Field.ErrorText>{errors.notes?.message}</Field.ErrorText>
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
              <Button onClick={handleSubmit(onSubmit)} loading={isLoading} colorPalette="green">
                Create Meeting
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Portal>
  );
}

function LabSectionsTable() {
  const controller = useCourseController();
  const supabase = createClient();
  const sectionsReady = useIsTableControllerReady(controller.labSections);
  const meetingsReady = useIsTableControllerReady(controller.labSectionMeetings);
  const [isDeleting, setIsDeleting] = useState(false);
  const [labSectionLeadersMap, setLabSectionLeadersMap] = useState<Map<number, string[]>>(new Map());
  const [leadersRefreshKey, setLeadersRefreshKey] = useState(0);

  const {
    isOpen: isCreateModalOpen,
    modalData: editingLabSection,
    openModal: openCreateModal,
    closeModal: closeCreateModal
  } = useModalManager<EditLabSectionData | undefined>();

  const {
    isOpen: isMeetingsModalOpen,
    modalData: managingLabSection,
    openModal: openMeetingsModal,
    closeModal: closeMeetingsModal
  } = useModalManager<LabSection | undefined>();

  const {
    isOpen: isCreateMeetingModalOpen,
    modalData: createMeetingLabSection,
    openModal: openCreateMeetingModal,
    closeModal: closeCreateMeetingModal
  } = useModalManager<LabSection | undefined>();

  // Get lab sections from course controller
  const unsortedLabSections = useTableControllerTableValues(controller.labSections);
  const labSections = useMemo(
    () => unsortedLabSections.sort((a, b) => a.name.localeCompare(b.name)),
    [unsortedLabSections]
  );

  // Get lab section meetings from course controller
  const labSectionMeetings = useTableControllerTableValues(controller.labSectionMeetings);

  // Fetch lab section leaders for all sections
  useEffect(() => {
    const fetchLeaders = async () => {
      if (labSections.length === 0) return;

      const { data: leaders } = await supabase
        .from("lab_section_leaders")
        .select("lab_section_id, profile_id, profiles(name)")
        .in(
          "lab_section_id",
          labSections.map((s) => s.id)
        );

      if (leaders) {
        const map = new Map<number, string[]>();
        leaders.forEach((leader) => {
          const sectionId = leader.lab_section_id;
          const profileName = (leader.profiles as { name: string })?.name || "Unknown";
          if (!map.has(sectionId)) {
            map.set(sectionId, []);
          }
          map.get(sectionId)!.push(profileName);
        });
        setLabSectionLeadersMap(map);
      }
    };

    fetchLeaders();
  }, [labSections, supabase, leadersRefreshKey]);

  const handleCreateNew = () => {
    openCreateModal(undefined);
  };

  const handleEdit = async (labSection: LabSection) => {
    // Fetch current leaders for this section
    const { data: leaders } = await supabase
      .from("lab_section_leaders")
      .select("profile_id")
      .eq("lab_section_id", labSection.id);

    openCreateModal({
      id: labSection.id,
      name: labSection.name,
      day_of_week: labSection.day_of_week as DayOfWeek,
      start_time: labSection.start_time || "",
      end_time: labSection.end_time || undefined,
      lab_leader_ids: leaders?.map((l) => l.profile_id) || [],
      meeting_location: labSection.meeting_location || undefined,
      description: labSection.description || undefined
    });
  };

  const handleDelete = async (id: number) => {
    setIsDeleting(true);
    try {
      await controller.labSections.delete(id);
      toaster.success({
        title: "Lab section deleted successfully"
      });
    } catch (error) {
      toaster.error({
        title: "Error deleting lab section",
        description: error instanceof Error ? error.message : "An unknown error occurred"
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleModalSuccess = () => {
    // Trigger refresh of lab section leaders map
    setLeadersRefreshKey((prev) => prev + 1);
  };

  const formatTime = (time: string) => {
    return format(new Date(`2000-01-01T${time}`), "h:mm a");
  };

  const getDayDisplayName = (day: string) => {
    return DAYS_OF_WEEK.find((d) => d.value === day)?.label || day;
  };

  const getLabSectionMeetings = (labSectionId: number) => {
    return labSectionMeetings.filter((meeting) => meeting.lab_section_id === labSectionId);
  };

  const getUpcomingMeetings = (labSectionId: number) => {
    const meetings = getLabSectionMeetings(labSectionId);
    const now = new Date();
    return meetings
      .filter((meeting) => new Date(meeting.meeting_date) >= now && !meeting.cancelled)
      .sort((a, b) => new Date(a.meeting_date).getTime() - new Date(b.meeting_date).getTime());
  };
  if (!sectionsReady || !meetingsReady) {
    return (
      <VStack gap={4} mt={4}>
        <Spinner />
        <Text>Loading lab sections...</Text>
      </VStack>
    );
  }

  return (
    <>
      <VStack gap={4} mt={4}>
        <HStack justify="space-between" width="100%">
          <Heading size="lg">Lab Sections</Heading>
          <Button onClick={handleCreateNew} size="sm">
            <FaPlus /> Create Lab Section
          </Button>
        </HStack>

        {labSections.length === 0 ? (
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
                <Table.ColumnHeader>Room Location</Table.ColumnHeader>
                <Table.ColumnHeader>Lab Leader</Table.ColumnHeader>
                <Table.ColumnHeader>Upcoming Meetings</Table.ColumnHeader>
                <Table.ColumnHeader>Students</Table.ColumnHeader>
                <Table.ColumnHeader>Actions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {labSections.map((labSection) => (
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
                      <Text>{labSection.day_of_week ? getDayDisplayName(labSection.day_of_week) : "N/A"}</Text>
                      <Text fontSize="sm" color="fg.muted">
                        {labSection.start_time ? formatTime(labSection.start_time) : "N/A"}
                        {labSection.end_time && ` - ${formatTime(labSection.end_time)}`}
                      </Text>
                    </VStack>
                  </Table.Cell>
                  <Table.Cell>
                    <Text>{labSection.meeting_location || "Not specified"}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    {(() => {
                      const leaders = labSectionLeadersMap.get(labSection.id) || [];
                      if (leaders.length === 0) {
                        return <Text color="fg.muted">Not assigned</Text>;
                      }
                      return (
                        <VStack gap={1} align="start">
                          {leaders.map((name, idx) => (
                            <Text key={idx} fontSize="sm">
                              {name}
                            </Text>
                          ))}
                        </VStack>
                      );
                    })()}
                  </Table.Cell>
                  <Table.Cell>
                    {(() => {
                      const upcomingMeetings = getUpcomingMeetings(labSection.id);
                      if (upcomingMeetings.length === 0) {
                        return (
                          <Text fontSize="sm" color="fg.muted">
                            No upcoming meetings
                          </Text>
                        );
                      }
                      return (
                        <VStack gap={1} align="start">
                          {upcomingMeetings.slice(0, 3).map((meeting) => (
                            <Text key={meeting.id} fontSize="sm">
                              {format(new Date(meeting.meeting_date), "MMM d, yyyy")}
                            </Text>
                          ))}
                          {upcomingMeetings.length > 3 && (
                            <Text fontSize="xs" color="fg.muted">
                              +{upcomingMeetings.length - 3} more
                            </Text>
                          )}
                        </VStack>
                      );
                    })()}
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm" color="fg.muted">
                      {/* TODO: Add student count */}0 students
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack gap={2}>
                      <Tooltip content="Manage meetings">
                        <Button size="sm" variant="ghost" onClick={() => openMeetingsModal(labSection)}>
                          <FaCalendar />
                        </Button>
                      </Tooltip>
                      <Tooltip content="Edit lab section">
                        <Button size="sm" variant="ghost" onClick={() => handleEdit(labSection)}>
                          <FaEdit />
                        </Button>
                      </Tooltip>
                      <PopConfirm
                        triggerLabel="Delete lab section"
                        trigger={
                          <Button size="sm" variant="ghost" colorPalette="red" loading={isDeleting}>
                            <FaTrash />
                          </Button>
                        }
                        confirmHeader="Delete Lab Section"
                        confirmText={`Are you sure you want to delete "${labSection.name}"? This action cannot be undone.`}
                        onConfirm={async () => await handleDelete(labSection.id)}
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

      <ManageMeetingsModal
        isOpen={isMeetingsModalOpen}
        onClose={closeMeetingsModal}
        labSection={managingLabSection || null}
        onAddMeeting={openCreateMeetingModal}
      />

      <CreateMeetingModal
        isOpen={isCreateMeetingModalOpen}
        onClose={closeCreateMeetingModal}
        labSection={createMeetingLabSection || null}
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
