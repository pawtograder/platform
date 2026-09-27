"use client";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogCloseTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import PersonAvatar from "@/components/ui/person-avatar";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useAssignmentDueDate,
  useClassSections,
  useCourse,
  useCourseController,
  useLabSections
} from "@/hooks/useCourseController";
import {
  useListTableControllerValues,
  useTableControllerTableValues,
  useTableControllerValueById
} from "@/lib/TableController";
import { useVirtualizedRowWindow } from "@/hooks/useVirtualizedRowWindow";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroup,
  UserProfile,
  UserRoleWithPrivateProfileAndUser
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button,
  Dialog,
  Fieldset,
  Heading,
  HStack,
  Icon,
  Input,
  NativeSelect,
  Skeleton,
  Table,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  Row,
  RowSelectionState,
  Table as TanStackTable,
  Updater,
  useReactTable,
  VisibilityState
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import {
  BulkAddExtensionDialog,
  BulkExceptionTarget,
  BulkSetDeadlineDialog,
  minutesUntil
} from "./BulkDueDateExceptionDialogs";
import { addHours, addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { FaSort, FaSortDown, FaSortUp, FaTrash } from "react-icons/fa";

// Simplified data structure for student due date information
type StudentDueDateRow = {
  student: UserProfile;
  email: string | null;
  group: AssignmentGroup | null;
  classSectionName: string | null;
  labSectionName: string | null;
  effectiveDueDate: Date | null;
  finalDueDate: Date | null;
  hoursExtended: number;
  minutesExtended: number;
  extensions: AssignmentDueDateException[];
};

type AdjustDueDateInsert = Database["public"]["Tables"]["assignment_due_date_exceptions"]["Insert"];
function AdjustDueDateDialogContent({
  student_id,
  group,
  assignment,
  open,
  setOpen
}: {
  student_id: string;
  group?: AssignmentGroup;
  assignment: Assignment;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const studentOrGroup = group ? "group" : "student";

  const dueDateInfo = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: student_id,
    assignmentGroupId: group?.id
  });
  const { time_zone } = useCourse();
  const originalDueDate = new TZDate(assignment.due_date!);
  const labBasedDueDate = dueDateInfo.effectiveDueDate || originalDueDate;
  const { assignmentDueDateExceptions } = useCourseController();

  const predicate = useCallback(
    (exception: AssignmentDueDateException) => {
      return (
        exception.assignment_id === assignment.id &&
        ((exception.student_id === student_id && !group) || (exception.assignment_group_id === group?.id && !!group))
      );
    },
    [assignment.id, student_id, group]
  );

  const extensions = useListTableControllerValues(assignmentDueDateExceptions, predicate);

  // Calculate final due date with extensions
  const hoursExtended = extensions?.reduce((acc, exception) => acc + exception.hours, 0) || 0;
  const minutesExtended = extensions?.reduce((acc, exception) => acc + exception.minutes, 0) || 0;
  const finalDueDate = addMinutes(addHours(labBasedDueDate, hoursExtended), minutesExtended);

  const {
    handleSubmit,
    register,
    watch,
    reset,
    setError,
    clearErrors,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<AdjustDueDateInsert>({
    defaultValues: {
      hours: 0,
      minutes: 0,
      tokens_consumed: 0
    }
  });

  const [targetDueDate, setTargetDueDate] = useState<string>("");
  const [targetDateError, setTargetDateError] = useState<string>("");

  useEffect(() => {
    if (!open) {
      reset();
      setTargetDueDate("");
      setTargetDateError("");
      lastInputMethod.current = "hours";
      isSyncing.current = false;
    }
  }, [open, reset]);

  const { private_profile_id } = useClassProfiles();

  const onSubmitCallback = useCallback(
    async (values: AdjustDueDateInsert) => {
      if (targetDateError) {
        toaster.error({
          title: "Invalid target date",
          description: targetDateError,
          type: "error"
        });
        return;
      }
      const totalMinutes = (Number(values.hours) || 0) * 60 + (Number(values.minutes) || 0);
      if (totalMinutes <= 0) {
        setError("hours", { type: "validate", message: "Enter hours or minutes greater than 0" });
        setError("minutes", { type: "validate", message: "Enter hours or minutes greater than 0" });
        toaster.error({
          title: "Invalid extension",
          description: "Please set hours or minutes to a value greater than 0.",
          type: "error"
        });
        return;
      }
      const data: AdjustDueDateInsert = {
        ...values,
        hours: Number.parseInt(values.hours.toString()),
        minutes: Number.parseInt(values.minutes?.toString() || "0"),
        tokens_consumed: Number.parseInt(values.tokens_consumed?.toString() || "0"),
        class_id: assignment.class_id,
        student_id: group ? null : student_id,
        assignment_id: assignment.id,
        assignment_group_id: group?.id,
        creator_id: private_profile_id!
      };
      try {
        await assignmentDueDateExceptions.create(data);
        toaster.create({
          title: "Due date exception added",
          description: "The due date exception has been added.",
          type: "success"
        });
        // Close dialog and reset form after successful submission
        setOpen(false);
        reset();
      } catch {
        toaster.error({
          title: "Error adding due date exception",
          description: "An error occurred while adding the due date exception.",
          type: "error"
        });
      }
    },
    [
      assignment.id,
      group,
      student_id,
      assignment.class_id,
      assignmentDueDateExceptions,
      private_profile_id,
      reset,
      setError,
      setOpen,
      targetDateError
    ]
  );

  const onSubmit = handleSubmit(onSubmitCallback);

  const toHoursDays = (hours: number) => {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} days ${remainingHours} hours`;
  };

  const formattedDuration = toHoursDays(hoursExtended);
  const hasLabScheduling = assignment.minutes_due_after_lab !== null;
  const watchedHours = watch("hours", 0) || 0;
  const watchedMinutes = watch("minutes", 0) || 0;
  const newDueDate = addMinutes(addHours(finalDueDate, watchedHours), watchedMinutes);
  const sumIsInvalid = (watchedHours || 0) + (watchedMinutes || 0) <= 0;

  // Memoize finalDueDate to prevent infinite loops (use timestamp for stable dependency)
  const finalDueDateTimestamp = finalDueDate.getTime();
  const finalDueDateMemo = useMemo(() => finalDueDate, [finalDueDateTimestamp]);

  // Format finalDueDate for datetime-local input (min attribute) in course timezone
  const minDateTimeLocal = useMemo(
    () => formatInTimeZone(finalDueDateMemo, time_zone, "yyyy-MM-dd'T'HH:mm"),
    [finalDueDateMemo, time_zone]
  );

  // Convert datetime-local string to Date in the course timezone
  // datetime-local inputs work in browser local timezone, but we interpret the value as course timezone
  const parseTargetDate = useCallback(
    (dateTimeLocal: string): Date | null => {
      if (!dateTimeLocal) return null;
      // Parse the datetime-local string and interpret it as course timezone
      const [datePart, timePart] = dateTimeLocal.split("T");
      if (!datePart || !timePart) return null;
      const [year, month, day] = datePart.split("-").map(Number);
      const [hours, minutes] = timePart.split(":").map(Number);
      return new TZDate(year, month - 1, day, hours, minutes, time_zone);
    },
    [time_zone]
  );

  // Convert Date to datetime-local string format in course timezone
  const formatToDateTimeLocal = useCallback(
    (date: Date): string => {
      return formatInTimeZone(date, time_zone, "yyyy-MM-dd'T'HH:mm");
    },
    [time_zone]
  );

  // Track which input method was used last to avoid sync loops
  const lastInputMethod = useRef<"date" | "hours">("hours");
  const isSyncing = useRef(false);

  // When target date changes, calculate hours/minutes
  useEffect(() => {
    if (isSyncing.current) return;

    if (targetDueDate && lastInputMethod.current === "date") {
      isSyncing.current = true;
      const targetDate = parseTargetDate(targetDueDate);
      if (targetDate) {
        if (targetDate <= finalDueDateMemo) {
          setTargetDateError("Target date must be after current due date");
          isSyncing.current = false;
          return;
        }
        // Clear errors if valid
        setTargetDateError("");
        clearErrors(["hours", "minutes"]);

        // Round a partial minute up so the new due date is not before the target.
        const totalMinutes = minutesUntil(targetDate, finalDueDateMemo);
        if (totalMinutes > 0) {
          const hours = Math.floor(totalMinutes / 60);
          const minutes = totalMinutes % 60;
          // Use setTimeout to reset sync flag after React processes the update
          setValue("hours", hours, { shouldValidate: true, shouldDirty: true });
          setValue("minutes", minutes, { shouldValidate: true, shouldDirty: true });
          setTimeout(() => {
            isSyncing.current = false;
          }, 0);
        } else {
          setValue("hours", 0, { shouldValidate: true, shouldDirty: true });
          setValue("minutes", 0, { shouldValidate: true, shouldDirty: true });
          setTimeout(() => {
            isSyncing.current = false;
          }, 0);
        }
      } else {
        setTargetDateError("");
        isSyncing.current = false;
      }
    } else if (!targetDueDate) {
      setTargetDateError("");
    }
  }, [targetDueDate, finalDueDateMemo, setValue, clearErrors, parseTargetDate]);

  // When hours/minutes change, update target date
  useEffect(() => {
    if (isSyncing.current) return;

    if (lastInputMethod.current === "hours") {
      isSyncing.current = true;
      if (watchedHours > 0 || watchedMinutes > 0) {
        const calculatedNewDate = addMinutes(addHours(finalDueDateMemo, watchedHours), watchedMinutes);
        const formatted = formatToDateTimeLocal(calculatedNewDate);
        if (formatted !== targetDueDate) {
          setTargetDueDate(formatted);
        }
        setTargetDateError("");
      } else {
        if (targetDueDate) {
          setTargetDueDate("");
        }
        setTargetDateError("");
      }
      // Use setTimeout to reset sync flag after React processes the update
      setTimeout(() => {
        isSyncing.current = false;
      }, 0);
    }
  }, [watchedHours, watchedMinutes, finalDueDateMemo, formatToDateTimeLocal, targetDueDate]);

  // Track when target date is manually changed
  const handleTargetDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    lastInputMethod.current = "date";
    setTargetDueDate(value);
  };

  // Track when hours/minutes inputs are focused (user is typing)
  const handleHoursFocus = () => {
    lastInputMethod.current = "hours";
  };

  const handleMinutesFocus = () => {
    lastInputMethod.current = "hours";
  };

  return (
    <Dialog.Content p={4}>
      <Dialog.Header>
        <Dialog.Title>
          Adjust Due Date for {group ? group.name : <PersonName uid={student_id} showAvatar={false} />} on{" "}
          {assignment.title}
        </Dialog.Title>
        <DialogCloseTrigger />
      </Dialog.Header>
      <Dialog.Description>
        {hasLabScheduling ? (
          <>
            <Text mb={2}>
              <strong>Original Assignment Due Date:</strong>{" "}
              <TimeZoneAwareDate date={originalDueDate} format="MMM d, h:mm a" />
            </Text>
            <Text mb={2}>
              <strong>Lab-Based Due Date:</strong> <TimeZoneAwareDate date={labBasedDueDate} format="MMM d, h:mm a" />
              {labBasedDueDate.getTime() !== originalDueDate.getTime() && (
                <Text as="span" color="blue.500" ml={2}>
                  (adjusted for lab scheduling)
                </Text>
              )}
            </Text>
            <Text mb={4}>
              <strong>Current Final Due Date:</strong> <TimeZoneAwareDate date={finalDueDate} format="MMM d, h:mm a" />
              {hoursExtended > 0 && (
                <Text as="span" color="orange.500" ml={2}>
                  (with {formattedDuration} extension)
                </Text>
              )}
            </Text>
          </>
        ) : (
          <Text mb={4}>
            The current due date for this {studentOrGroup} is{" "}
            <TimeZoneAwareDate date={finalDueDate} format="MMM d, h:mm a" />
            {hoursExtended > 0 && ` (an extension of ${formattedDuration})`}.
          </Text>
        )}
        You can manually adjust the due date for this {studentOrGroup} below, either by selecting a target date or by
        entering hours and minutes. Extensions are applied on top of the {hasLabScheduling ? "lab-based" : "original"}{" "}
        due date.
      </Dialog.Description>
      <Dialog.Body>
        <Heading size="md">Add an Exception</Heading>
        <form id="due-date-form" onSubmit={onSubmit}>
          <Fieldset.Root bg="surface" size="sm">
            <Fieldset.Content maxW="md" gap={2}>
              <Field
                orientation="horizontal"
                label="Target Due Date"
                errorText={targetDateError}
                invalid={!!targetDateError}
                helperText="Select a specific date and time for the new due date. Hours and minutes will be calculated automatically."
              >
                <Input
                  size="sm"
                  type="datetime-local"
                  value={targetDueDate}
                  onChange={handleTargetDateChange}
                  min={minDateTimeLocal}
                />
              </Field>
              <Text fontSize="sm" color="fg.muted" mb={2}>
                Or enter hours and minutes manually:
              </Text>
              <HStack align="start" gap={4}>
                <Field
                  orientation="horizontal"
                  label="Hours Extended"
                  errorText={errors.hours?.message?.toString()}
                  invalid={errors.hours ? true : false}
                >
                  <Input
                    size="sm"
                    w="110px"
                    type="number"
                    {...register("hours", {
                      valueAsNumber: true,
                      min: 0,
                      validate: (_value, formValues) => {
                        const h =
                          typeof formValues.hours === "number" && Number.isFinite(formValues.hours)
                            ? formValues.hours
                            : 0;
                        const m =
                          typeof formValues.minutes === "number" && Number.isFinite(formValues.minutes)
                            ? formValues.minutes
                            : 0;
                        return h + m > 0 || "Enter hours or minutes greater than 0";
                      }
                    })}
                    onFocus={handleHoursFocus}
                    defaultValue={0}
                  />
                </Field>
                <Field
                  orientation="horizontal"
                  label="Minutes Extended"
                  errorText={errors.minutes?.message?.toString()}
                  invalid={errors.minutes ? true : false}
                  helperText="Additional time to extend the due date."
                >
                  <Input
                    size="sm"
                    w="110px"
                    type="number"
                    {...register("minutes", {
                      valueAsNumber: true,
                      min: 0,
                      max: 59,
                      validate: (_value, formValues) => {
                        const h =
                          typeof formValues.hours === "number" && Number.isFinite(formValues.hours)
                            ? formValues.hours
                            : 0;
                        const m =
                          typeof formValues.minutes === "number" && Number.isFinite(formValues.minutes)
                            ? formValues.minutes
                            : 0;
                        return h + m > 0 || "Enter hours or minutes greater than 0";
                      }
                    })}
                    onFocus={handleMinutesFocus}
                    defaultValue={0}
                  />
                </Field>
              </HStack>
              <Field
                orientation="horizontal"
                label="Tokens to Consume"
                errorText={errors.tokens_consumed?.message?.toString()}
                invalid={errors.tokens_consumed ? true : false}
                helperText="Deducted from the student's token balance"
                defaultValue={0}
              >
                <Input
                  size="sm"
                  w="120px"
                  type="number"
                  {...register("tokens_consumed", {
                    valueAsNumber: true,
                    min: 0,
                    required: "Tokens consumed is required"
                  })}
                />
              </Field>
              <Field
                orientation="horizontal"
                label="Notes"
                errorText={errors.note?.message?.toString()}
                invalid={errors.note ? true : false}
                helperText="Visible to the student and the staff."
              >
                <Textarea size="sm" {...register("note")} />
              </Field>
              <Box
                mb={2}
                w="100%"
                p={2}
                bg={sumIsInvalid ? "bg.error" : "bg.info"}
                borderWidth="1px"
                borderColor={sumIsInvalid ? "border.error" : "border.info"}
                borderRadius="md"
              >
                {sumIsInvalid ? (
                  <Text fontSize="sm" color="fg.error">
                    {errors.hours?.message?.toString() ||
                      errors.minutes?.message?.toString() ||
                      "Enter hours or minutes greater than 0"}
                  </Text>
                ) : (
                  <Text fontSize="sm" color="fg.info">
                    <strong>New Due Date:</strong> <TimeZoneAwareDate date={newDueDate} format="MMM d, h:mm a" />
                  </Text>
                )}
              </Box>
            </Fieldset.Content>
          </Fieldset.Root>
        </form>
        <Heading size="md">Extension History</Heading>
        {extensions && extensions.length > 0 ? (
          <Box maxH="400px" overflowY="auto">
            <Table.Root maxW="2xl">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Date Applied</Table.ColumnHeader>
                  <Table.ColumnHeader>Hours Extended</Table.ColumnHeader>
                  <Table.ColumnHeader>Minutes Extended</Table.ColumnHeader>
                  <Table.ColumnHeader>Tokens Consumed</Table.ColumnHeader>
                  <Table.ColumnHeader>Grantor</Table.ColumnHeader>
                  <Table.ColumnHeader>Notes</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {extensions?.map((extension) => (
                  <Table.Row key={extension.id}>
                    <Table.Cell>
                      <TimeZoneAwareDate date={extension.created_at} format="MMM d, h:mm a" />
                    </Table.Cell>
                    <Table.Cell>
                      {extension.hours}
                      {
                        <PopConfirm
                          triggerLabel="Delete"
                          trigger={
                            <Button size="xs" variant="ghost" colorPalette="red">
                              <Icon as={FaTrash} />
                            </Button>
                          }
                          placement="top-start"
                          confirmHeader="Delete extension"
                          confirmText="Are you sure you want to delete this extension?"
                          onConfirm={async () => {
                            await assignmentDueDateExceptions.hardDelete(extension.id);
                          }}
                        />
                      }
                    </Table.Cell>
                    <Table.Cell>{extension.minutes || 0}</Table.Cell>
                    <Table.Cell>{extension.tokens_consumed}</Table.Cell>
                    <Table.Cell>
                      <PersonName uid={extension.creator_id} />
                    </Table.Cell>
                    <Table.Cell>{extension.note}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        ) : (
          <Text>No extensions have been granted for this {studentOrGroup}.</Text>
        )}
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.ActionTrigger asChild>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </Dialog.ActionTrigger>
        <Button loading={isSubmitting} colorPalette="green" type="submit" form="due-date-form">
          Add Due Date Exception
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  );
}
export function AdjustDueDateDialog({
  student_id,
  group,
  assignment
}: {
  student_id: string;
  group?: AssignmentGroup;
  assignment: Assignment;
}) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((details: { open: boolean }) => {
    setOpen(details.open);
  }, []);

  return (
    <Dialog.Root size="xl" open={open} onOpenChange={handleOpenChange} lazyMount>
      <Dialog.Trigger asChild>
        <Button size="xs" colorPalette="green" variant="subtle">
          Adjust Due Date
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <AdjustDueDateDialogContent
          student_id={student_id}
          group={group || undefined}
          assignment={assignment}
          open={open}
          setOpen={setOpen}
        />
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

/**
 * Option value for "no group" / "no section". Not a possible name, so a group or section that is
 * literally called "No group" stays a separate option.
 */
const FILTER_EMPTY_VALUE = "__none__";

/** Multi-select filter: matches when the row's label (or FILTER_EMPTY_VALUE when unset) is one of the chosen values. */
function includesFilter(row: Row<StudentDueDateRow>, columnId: string, filterValue: unknown) {
  if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
  const values = Array.isArray(filterValue) ? (filterValue as string[]) : [String(filterValue)];
  const label = row.getValue<string | undefined>(columnId);
  return values.includes(label || FILTER_EMPTY_VALUE);
}

/**
 * Select or deselect every row matching the current filters, on every page, in one state update
 * (row.toggleSelected copies the selection object once per row).
 */
function setFilteredSelection(table: TanStackTable<StudentDueDateRow>, selected: boolean) {
  const ids = table.getFilteredRowModel().rows.map((r) => r.id);
  table.setRowSelection((prev) => {
    const next = { ...prev };
    for (const id of ids) {
      if (selected) next[id] = true;
      else delete next[id];
    }
    return next;
  });
}

/** Display labels for the FILTER_EMPTY_VALUE option. */
const FILTER_EMPTY_LABELS: Record<string, string> = {
  group_name: "No group",
  class_section_name: "Not assigned",
  lab_section_name: "Not assigned"
};

export default function DueDateExceptions() {
  const course = useCourse();
  const { assignment_id } = useParams();
  const { assignments, assignmentGroupsWithMembers, assignmentDueDateExceptions } = useCourseController();
  // TableControllers already hydrate/fetch and stay realtime; avoid forced mount refetches on large classes.
  const controller = useCourseController();

  // Get assignment data
  const assignment = useTableControllerValueById(assignments, Number.parseInt(assignment_id as string));

  // Get groups for this assignment
  const groupPredicate = useMemo(() => {
    return (group: AssignmentGroup) => {
      return group.assignment_id === Number.parseInt(assignment_id as string);
    };
  }, [assignment_id]);
  const groups = useListTableControllerValues(assignmentGroupsWithMembers, groupPredicate);

  // Get all extensions for this assignment
  const extensionPredicate = useMemo(() => {
    return (exception: AssignmentDueDateException) => {
      return exception.assignment_id === Number.parseInt(assignment_id as string);
    };
  }, [assignment_id]);
  const allExtensions = useListTableControllerValues(assignmentDueDateExceptions, extensionPredicate);

  // Active (not dropped) students, with their section assignments. Subscribes per row, so a
  // section or name change on an existing role re-renders (useAllStudentRoles keeps its old array
  // while the set of ids is unchanged).
  const studentRolePredicate = useCallback(
    (r: UserRoleWithPrivateProfileAndUser) => r.role === "student" && !r.disabled,
    []
  );
  const studentRoles = useListTableControllerValues(controller.userRolesWithProfiles, studentRolePredicate);
  // Catch up on roles changed since the controller's watermark, as useAllStudentRoles does on
  // mount: the first-channel-join catch-up can be dropped when a full refetch races it, or the
  // SSR data can predate a cache invalidation, which would hide students enrolled moments ago.
  useEffect(() => {
    void controller.userRolesWithProfiles.catchUpSinceWatermark();
  }, [controller.userRolesWithProfiles]);
  const classSections = useClassSections();
  const labSections = useLabSections();
  // calculateEffectiveDueDate reads these from the controller; subscribe so lab-based dates
  // recompute once they load or change.
  const labSectionMeetings = useTableControllerTableValues(controller.labSectionMeetings);

  const hasLabScheduling = assignment?.minutes_due_after_lab !== null;
  const hasGroups = (groups?.length ?? 0) > 0;
  const originalDueDate = useMemo(() => {
    return assignment?.due_date ? new TZDate(assignment.due_date, course.time_zone || "America/New_York") : null;
  }, [assignment?.due_date, course.time_zone]);

  // Process student data with extensions and due dates
  const studentData = useMemo(() => {
    // calculateEffectiveDueDate reads lab section meetings from the controller, which the linter
    // cannot see; referencing them here keeps them a dependency.
    void labSectionMeetings;
    if (!assignment) return [];
    const classSectionNames = new Map(classSections.map((s) => [s.id, s.name]));
    const labSectionNames = new Map(labSections.map((s) => [s.id, s.name]));

    // Lookups built once, so each row is O(1) rather than a scan of groups and exceptions.
    const groupByStudent = new Map<string, AssignmentGroup>();
    for (const g of groups ?? []) {
      for (const m of g.assignment_groups_members) groupByStudent.set(m.profile_id, g);
    }
    const extensionsByStudent = new Map<string, AssignmentDueDateException[]>();
    const extensionsByGroup = new Map<number, AssignmentDueDateException[]>();
    const extensionOrder = new Map<AssignmentDueDateException, number>();
    const push = <K,>(map: Map<K, AssignmentDueDateException[]>, key: K, ext: AssignmentDueDateException) => {
      const list = map.get(key);
      if (list) list.push(ext);
      else map.set(key, [ext]);
    };
    (allExtensions ?? []).forEach((ext, i) => {
      extensionOrder.set(ext, i);
      if (ext.student_id) push(extensionsByStudent, ext.student_id, ext);
      if (ext.assignment_group_id) push(extensionsByGroup, ext.assignment_group_id, ext);
    });
    // The lab-based date depends only on the lab section.
    const effectiveDueDateByLab = new Map<number, TZDate | null>();

    return studentRoles.map((role): StudentDueDateRow => {
      const student = role.profiles;
      const group = groupByStudent.get(student.id) ?? null;

      // The student's own exceptions plus their group's, as calculate_final_due_date sums them.
      // Group members can hold their own too (student-wide extensions are keyed by student_id).
      const ownExtensions = extensionsByStudent.get(student.id) ?? [];
      const groupExtensions = group ? (extensionsByGroup.get(group.id) ?? []) : [];
      // Merge in the controller's order (the most recent is shown last).
      const extensions = groupExtensions.length
        ? [...ownExtensions, ...groupExtensions.filter((ext) => ext.student_id !== student.id)].sort(
            (a, b) => extensionOrder.get(a)! - extensionOrder.get(b)!
          )
        : ownExtensions;

      // Calculate effective due date (lab-based if applicable). A student with no lab section
      // keeps the original due date, as calculateEffectiveDueDate would return.
      let effectiveDueDate = originalDueDate;
      const labSectionId = role.lab_section_id;
      if (hasLabScheduling && originalDueDate && assignment && labSectionId) {
        if (!effectiveDueDateByLab.has(labSectionId)) {
          try {
            const calculatedDate = controller.calculateEffectiveDueDate(assignment, {
              studentPrivateProfileId: student.id,
              labSectionId
            });
            effectiveDueDateByLab.set(labSectionId, new TZDate(calculatedDate, course.time_zone || "America/New_York"));
          } catch {
            // Fallback to original due date if calculation fails
            effectiveDueDateByLab.set(labSectionId, originalDueDate);
          }
        }
        effectiveDueDate = effectiveDueDateByLab.get(labSectionId) ?? originalDueDate;
      }

      // Calculate total extensions
      const hoursExtended = extensions?.reduce((acc, ext) => acc + ext.hours, 0) || 0;
      const minutesExtended = extensions?.reduce((acc, ext) => acc + (ext.minutes || 0), 0) || 0;

      // Calculate final due date with extensions
      const finalDueDate = effectiveDueDate
        ? addMinutes(addHours(effectiveDueDate, hoursExtended), minutesExtended)
        : null;

      return {
        student,
        email: role.users?.email ?? null,
        group,
        classSectionName: role.class_section_id ? (classSectionNames.get(role.class_section_id) ?? null) : null,
        labSectionName: role.lab_section_id ? (labSectionNames.get(role.lab_section_id) ?? null) : null,
        effectiveDueDate,
        finalDueDate,
        hoursExtended,
        minutesExtended,
        extensions: extensions || []
      };
    });
  }, [
    studentRoles,
    classSections,
    labSections,
    labSectionMeetings,
    assignment,
    groups,
    allExtensions,
    originalDueDate,
    hasLabScheduling,
    controller,
    course.time_zone
  ]);

  // Names shared by more than one student, whose row checkboxes need more than the name to be told apart.
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const row of studentData) {
      const name = row.student.name ?? "student";
      if (seen.has(name)) duplicates.add(name);
      else seen.add(name);
    }
    return duplicates;
  }, [studentData]);

  // Set up columns for the table
  const columns = useMemo<ColumnDef<StudentDueDateRow>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableColumnFilter: false,
        header: ({ table }) => {
          const filteredRows = table.getFilteredRowModel().rows;
          const selectedInView = filteredRows.filter((r) => r.getIsSelected()).length;
          const allSelected = filteredRows.length > 0 && selectedInView === filteredRows.length;
          const someSelected = selectedInView > 0 && !allSelected;
          return (
            <VStack align="stretch" gap={1}>
              <Checkbox
                inputProps={{ "aria-label": "Select all rows matching current filters" }}
                checked={someSelected ? "indeterminate" : allSelected}
                disabled={filteredRows.length === 0}
                onCheckedChange={(details) => setFilteredSelection(table, details.checked === true)}
              />
              <HStack gap={1} flexWrap="wrap">
                <Button
                  size="2xs"
                  variant="plain"
                  disabled={filteredRows.length === 0}
                  onClick={() => setFilteredSelection(table, true)}
                >
                  All matching filters
                </Button>
                <Button size="2xs" variant="plain" onClick={() => table.resetRowSelection()}>
                  None
                </Button>
              </HStack>
            </VStack>
          );
        },
        cell: ({ row }) => {
          const { student, email } = row.original;
          const name = student.name ?? "student";
          const label = duplicateNames.has(name) ? `${name} (${email ?? student.id.slice(0, 8)})` : name;
          return (
            <Checkbox
              inputProps={{ "aria-label": `Select ${label} for bulk actions` }}
              checked={row.getIsSelected()}
              onCheckedChange={(details) => row.toggleSelected(details.checked === true)}
            />
          );
        }
      },
      {
        id: "student_name",
        accessorFn: (row) => row.student.name ?? undefined,
        header: "Student",
        sortUndefined: "last",
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values: string[] = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name = row.original.student.name;
          // Options are exact names, so "Sam Lee" must not also match "Sam Leeds".
          return !!name && values.includes(name);
        },
        cell: ({ row }) => <PersonName uid={row.original.student.id} showAvatar={false} />
      },
      {
        id: "group_name",
        // `undefined`, not `null`, for empty values: sortUndefined only checks `=== undefined`.
        accessorFn: (row) => row.group?.name || undefined,
        header: "Group",
        sortUndefined: "last",
        enableColumnFilter: true,
        filterFn: includesFilter,
        cell: ({ row }) => row.original.group?.name || <Text color="fg.muted">No group</Text>
      },
      {
        id: "class_section_name",
        accessorFn: (row) => row.classSectionName || undefined,
        header: "Class Section",
        sortUndefined: "last",
        enableColumnFilter: true,
        filterFn: includesFilter,
        cell: ({ row }) => row.original.classSectionName ?? <Text color="fg.muted">Not assigned</Text>
      },
      {
        id: "lab_section_name",
        accessorFn: (row) => row.labSectionName || undefined,
        header: "Lab Section",
        sortUndefined: "last",
        enableColumnFilter: true,
        filterFn: includesFilter,
        cell: ({ row }) => row.original.labSectionName ?? <Text color="fg.muted">Not assigned</Text>
      },
      {
        id: "lab_due_date",
        accessorFn: (row) => row.effectiveDueDate?.getTime(),
        header: "Lab-Based Due Date",
        sortUndefined: "last",
        cell: ({ row }) => {
          const { effectiveDueDate } = row.original;
          if (!effectiveDueDate || !hasLabScheduling) return <Text></Text>;

          const isDifferentFromOriginal = originalDueDate && effectiveDueDate.getTime() !== originalDueDate.getTime();

          return (
            <VStack align="start" gap={1}>
              <Text>
                <TimeZoneAwareDate date={effectiveDueDate} format="MMM d, h:mm a" />
              </Text>
              {isDifferentFromOriginal && (
                <Text fontSize="xs" color="blue.500">
                  (lab-adjusted)
                </Text>
              )}
            </VStack>
          );
        }
      },
      {
        id: "final_due_date",
        // Only extended rows show a final date, so sort on what is displayed.
        accessorFn: (row) =>
          row.hoursExtended === 0 && row.minutesExtended === 0 ? undefined : row.finalDueDate?.getTime(),
        header: "Final Due Date",
        sortUndefined: "last",
        cell: ({ row }) => {
          const { finalDueDate: finalDate, hoursExtended, minutesExtended } = row.original;

          if (!finalDate || (hoursExtended === 0 && minutesExtended === 0)) return <Text></Text>;

          return (
            <VStack align="start" gap={1}>
              <Text>
                <TimeZoneAwareDate date={finalDate} format="MMM d, h:mm a" />
              </Text>
              <Text fontSize="xs" color="orange.500">
                (+{hoursExtended}h {minutesExtended}m)
              </Text>
            </VStack>
          );
        }
      },
      {
        id: "hours_extended",
        accessorFn: (row) => row.hoursExtended * 60 + row.minutesExtended,
        header: "Hours Extended",
        cell: ({ row }) => {
          const { hoursExtended, minutesExtended, extensions } = row.original;
          if (hoursExtended === 0 && minutesExtended === 0) return <Text></Text>;

          const extensionText = `${hoursExtended}h ${minutesExtended}m`;
          const mostRecentExtension = extensions[extensions.length - 1];

          return (
            <HStack>
              <Text>{extensionText}</Text>
              {mostRecentExtension && <PersonAvatar uid={mostRecentExtension.creator_id} size="2xs" />}
            </HStack>
          );
        }
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => {
          const { student, group } = row.original;

          return assignment ? (
            <AdjustDueDateDialog student_id={student.id} group={group || undefined} assignment={assignment} />
          ) : null;
        }
      }
    ],
    [hasLabScheduling, originalDueDate, assignment, duplicateNames]
  );

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Optional columns default from the data (which may load after first render); once the user
  // toggles a column, their choice wins.
  const defaultColumnVisibility = useMemo<VisibilityState>(
    () => ({
      group_name: hasGroups,
      class_section_name: classSections.length > 1,
      lab_section_name: hasLabScheduling || labSections.length > 0,
      lab_due_date: hasLabScheduling
    }),
    [hasGroups, classSections.length, labSections.length, hasLabScheduling]
  );
  const [columnVisibilityOverrides, setColumnVisibilityOverrides] = useState<VisibilityState>({});
  const columnVisibility = useMemo(
    () => ({ ...defaultColumnVisibility, ...columnVisibilityOverrides }),
    [defaultColumnVisibility, columnVisibilityOverrides]
  );
  const onColumnVisibilityChange = useCallback(
    (updater: Updater<VisibilityState>) => {
      setColumnVisibilityOverrides((prev) => {
        const current = { ...defaultColumnVisibility, ...prev };
        const next = typeof updater === "function" ? updater(current) : updater;
        // Keep only the columns the user actually changed, so the rest keep tracking the data.
        return Object.fromEntries(
          Object.entries(next).filter(([id, visible]) => visible !== current[id] || id in prev)
        );
      });
    },
    [defaultColumnVisibility]
  );

  // Same row models and pagination defaults as useTableControllerTable; rows here are derived
  // from several controllers, so there is no single TableController to hand it.
  const table = useReactTable({
    data: studentData,
    columns,
    getRowId: (row) => row.student.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // Realtime extension updates replace `data`; don't bounce the user back to page 1 for them.
    autoResetPageIndex: false,
    enableRowSelection: true,
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 1000 },
      sorting: [{ id: "student_name", desc: false }]
    }
  });

  // Set when a filter change can only widen the rows, so the selection is kept.
  const filtersOnlyWidened = useRef(false);
  const columnFiltersKey = JSON.stringify(table.getState().columnFilters);
  useEffect(() => {
    if (filtersOnlyWidened.current) filtersOnlyWidened.current = false;
    else setRowSelection({});
    table.setPageIndex(0);
  }, [columnFiltersKey, table]);

  // A filter's control only renders on a visible column, but TanStack keeps applying it; drop the
  // filter when its column is hidden so hidden state cannot narrow the rows.
  useEffect(() => {
    if (table.getState().columnFilters.some((f) => columnVisibility[f.id] === false)) {
      filtersOnlyWidened.current = true;
      table.setColumnFilters((prev) => prev.filter((f) => columnVisibility[f.id] !== false));
    }
  }, [columnVisibility, table]);

  const filterOptions = useMemo(() => {
    const collect = (getLabel: (row: StudentDueDateRow) => string | null, emptyLabel?: string) => {
      const labels = Array.from(new Set(studentData.map(getLabel).filter((label): label is string => !!label))).sort(
        (a, b) => a.localeCompare(b)
      );
      const options = labels.map((label) => ({ label, value: label }));
      return emptyLabel ? [...options, { label: emptyLabel, value: FILTER_EMPTY_VALUE }] : options;
    };
    return {
      student_name: collect((row) => row.student.name),
      group_name: collect((row) => row.group?.name ?? null, FILTER_EMPTY_LABELS.group_name),
      class_section_name: collect((row) => row.classSectionName, FILTER_EMPTY_LABELS.class_section_name),
      lab_section_name: collect((row) => row.labSectionName, FILTER_EMPTY_LABELS.lab_section_name)
    } as Record<string, { label: string; value: string }[]>;
  }, [studentData]);
  const filterPlaceholders: Record<string, string> = {
    student_name: "Filter by name...",
    group_name: "Filter by group...",
    class_section_name: "Filter by class section...",
    lab_section_name: "Filter by lab section..."
  };

  // Collapse selected rows to the students/groups that own exceptions: a group's exception is
  // shared by every member, so selecting two members of one group must not extend it twice.
  const selectedRows = useMemo(
    () => studentData.filter((row) => rowSelection[row.student.id]),
    [studentData, rowSelection]
  );
  const memberDeadlinesByGroup = useMemo(() => {
    const deadlines = new Map<number, Set<number | undefined>>();
    for (const row of studentData) {
      if (!row.group) continue;
      const set = deadlines.get(row.group.id) ?? new Set<number | undefined>();
      set.add(row.finalDueDate?.getTime());
      deadlines.set(row.group.id, set);
    }
    return deadlines;
  }, [studentData]);
  const memberIdsByGroup = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.assignment_groups_members.map((m) => m.profile_id)])),
    [groups]
  );
  const bulkTargets = useMemo(() => {
    const targets = new Map<string, BulkExceptionTarget>();
    for (const original of selectedRows) {
      const key = original.group ? `group:${original.group.id}` : `student:${original.student.id}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        key,
        student_id: original.student.id,
        member_student_ids: original.group
          ? (memberIdsByGroup.get(original.group.id) ?? [original.student.id])
          : [original.student.id],
        assignment_group_id: original.group?.id ?? null,
        currentFinalDueDate: original.finalDueDate,
        hasMixedMemberDeadlines: (original.group ? (memberDeadlinesByGroup.get(original.group.id)?.size ?? 0) : 0) > 1
      });
    }
    return Array.from(targets.values());
  }, [selectedRows, memberDeadlinesByGroup, memberIdsByGroup]);
  const [bulkAction, setBulkAction] = useState<"extend" | "set" | null>(null);

  const tableRows = table.getRowModel().rows;
  const rowWindow = useVirtualizedRowWindow(tableRows, {
    estimatedRowHeight: 68,
    minRowsForVirtualization: 60
  });
  const visibleColumnCount = table.getVisibleLeafColumns().length;

  // Each page starts at its top row.
  const pageIndex = table.getState().pagination.pageIndex;
  const scrollContainerRef = rowWindow.containerRef;
  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [pageIndex, scrollContainerRef]);

  if (!assignment) {
    return <Skeleton height="400px" width="100%" />;
  }

  const toggleableColumns: { id: string; label: string }[] = [
    { id: "group_name", label: "Group" },
    { id: "class_section_name", label: "Class Section" },
    { id: "lab_section_name", label: "Lab Section" },
    ...(hasLabScheduling ? [{ id: "lab_due_date", label: "Lab-Based Due Date" }] : [])
  ];

  return (
    <VStack w="100%" gap={6}>
      <Box w="100%">
        <Heading size="md">Due Date Exceptions</Heading>
        <Box mb={4} p={4} bg="bg.subtle" borderRadius="md">
          <Heading size="sm" mb={2}>
            Assignment Due Date Information
          </Heading>
          <Text mb={2}>
            <strong>Original Assignment Due Date:</strong>{" "}
            {originalDueDate ? <TimeZoneAwareDate date={originalDueDate} format="MMM d, h:mm a" /> : "No due date"}
          </Text>
          {hasLabScheduling && (
            <Text mb={2} color="fg.info">
              <strong>Lab-Based Scheduling:</strong> This assignment uses lab-based due dates. Each student&apos;s
              effective due date is calculated as {assignment.minutes_due_after_lab} minutes after their most recent lab
              meeting before the original due date.
            </Text>
          )}
          <Text fontSize="sm" color="fg.muted">
            This assignment allows students to use up to {assignment.max_late_tokens} late tokens to extend the due
            date. Each late token extends the due date by 24 hours. Students in the course are given a total of{" "}
            {course.late_tokens_per_student} late tokens. You can view and edit the due date exceptions for each student
            below. Extensions are applied on top of the {hasLabScheduling ? "lab-based" : "original"} due date.
          </Text>
        </Box>
      </Box>

      <VStack w="100%" gap={0}>
        {selectedRows.length === 0 ? (
          <Box w="100%" mb={2}>
            <Text fontSize="sm" color="fg.muted">
              Select students below to extend or set their deadline in bulk.
            </Text>
          </Box>
        ) : (
          <HStack alignItems="center" gap={2} w="100%" mb={2}>
            <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
              {selectedRows.length} selected
            </Text>
            <Button colorPalette="green" variant="subtle" onClick={() => setBulkAction("extend")}>
              Add extension
            </Button>
            <Button colorPalette="green" variant="subtle" onClick={() => setBulkAction("set")}>
              Set due date to...
            </Button>
          </HStack>
        )}
        <BulkAddExtensionDialog
          open={bulkAction === "extend"}
          setOpen={(open) => setBulkAction(open ? "extend" : null)}
          targets={bulkTargets}
          assignment={assignment}
          onApplied={() => table.resetRowSelection()}
        />
        <BulkSetDeadlineDialog
          open={bulkAction === "set"}
          setOpen={(open) => setBulkAction(open ? "set" : null)}
          targets={bulkTargets}
          assignment={assignment}
          onApplied={() => table.resetRowSelection()}
        />

        {/* Column Visibility Controls */}
        <Box w="100%" p={4} bg="bg.subtle" borderRadius="md" mb={0}>
          <Text fontSize="sm" fontWeight="medium" mb={3}>
            Toggle Column Visibility:
          </Text>
          <HStack wrap="wrap" gap={4}>
            {toggleableColumns.map(({ id, label }) => {
              const column = table.getColumn(id);
              return (
                <Checkbox
                  key={id}
                  checked={column?.getIsVisible() ?? false}
                  onCheckedChange={(details) => column?.toggleVisibility(details.checked === true)}
                >
                  {label}
                </Checkbox>
              );
            })}
          </HStack>
        </Box>

        {/* Table */}
        <Box w="100%" overflowX="auto" maxW="100vw">
          <Box ref={rowWindow.containerRef} onScroll={rowWindow.onScroll} overflowY="auto" maxH="70vh">
            <Table.Root minW="0" w="100%">
              <Table.Header>
                {table.getHeaderGroups().map((headerGroup) => (
                  <Table.Row key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.muted"
                        verticalAlign="top"
                        // Without scope the header cells are exposed as plain cells, where aria-sort is not allowed.
                        scope="col"
                        aria-sort={
                          header.column.getIsSorted() === "asc"
                            ? "ascending"
                            : header.column.getIsSorted() === "desc"
                              ? "descending"
                              : undefined
                        }
                        style={{
                          position: "sticky",
                          top: 0,
                          zIndex: 20
                        }}
                      >
                        {header.isPlaceholder ? null : (
                          <>
                            {header.column.getCanSort() ? (
                              <Button
                                variant="plain"
                                size="sm"
                                h="auto"
                                p={0}
                                gap={0}
                                fontWeight="inherit"
                                color="inherit"
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {{
                                  asc: (
                                    <Icon size="md">
                                      <FaSortUp />
                                    </Icon>
                                  ),
                                  desc: (
                                    <Icon size="md">
                                      <FaSortDown />
                                    </Icon>
                                  )
                                }[header.column.getIsSorted() as string] ?? (
                                  <Icon size="md">
                                    <FaSort />
                                  </Icon>
                                )}
                              </Button>
                            ) : (
                              flexRender(header.column.columnDef.header, header.getContext())
                            )}
                            {filterOptions[header.id] && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                aria-label={filterPlaceholders[header.id]}
                                value={((header.column.getFilterValue() as string[] | undefined) ?? []).map(
                                  (value) =>
                                    filterOptions[header.id].find((option) => option.value === value) ?? {
                                      label: value,
                                      value
                                    }
                                )}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={filterOptions[header.id]}
                                placeholder={filterPlaceholders[header.id]}
                              />
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    ))}
                  </Table.Row>
                ))}
              </Table.Header>
              <Table.Body>
                {rowWindow.shouldVirtualize && rowWindow.paddingTop > 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={visibleColumnCount} p={0} border="none" h={`${rowWindow.paddingTop}px`} />
                  </Table.Row>
                ) : null}
                {rowWindow.visibleRows.map((row, idx) => (
                  <Table.Row
                    key={row.id}
                    bg={(rowWindow.startIndex + idx) % 2 === 0 ? "bg.subtle" : undefined}
                    _hover={{ bg: "bg.info" }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <Table.Cell key={cell.id} p={2}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
                {rowWindow.shouldVirtualize && rowWindow.paddingBottom > 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={visibleColumnCount} p={0} border="none" h={`${rowWindow.paddingBottom}px`} />
                  </Table.Row>
                ) : null}
              </Table.Body>
            </Table.Root>
          </Box>
        </Box>
        <HStack mt={2}>
          <Button onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
            {"<<"}
          </Button>
          <Button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            {"<"}
          </Button>
          <Button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            {">"}
          </Button>
          <Button onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()}>
            {">>"}
          </Button>
          <VStack>
            <Text>Page</Text>
            <Text>
              {table.getState().pagination.pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
            </Text>
          </VStack>
          <VStack>
            <Text>Show</Text>
            <NativeSelect.Root title="Select page size">
              <NativeSelect.Field
                value={"" + table.getState().pagination.pageSize}
                onChange={(event) => {
                  table.setPageSize(Number(event.target.value));
                }}
              >
                {[25, 50, 100, 200, 500, 1000, 2000].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        </HStack>
        <Text>
          {table.getFilteredRowModel().rows.length === studentData.length
            ? `${studentData.length} Students`
            : `Showing ${table.getFilteredRowModel().rows.length} of ${studentData.length} Students`}
        </Text>
      </VStack>
    </VStack>
  );
}
