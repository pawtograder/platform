"use client";
import { Field } from "@/components/ui/field";
import PersonAvatar from "@/components/ui/person-avatar";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignmentDueDate, useCourseController, useStudentRoster, useCourse } from "@/hooks/useCourseController";
import { useListTableControllerValues, useTableControllerValueById } from "@/lib/TableController";
import { Assignment, AssignmentDueDateException, AssignmentGroup, UserProfile } from "@/utils/supabase/DatabaseTypes";
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
  Skeleton,
  Table,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { addHours, addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { FaSort, FaSortDown, FaSortUp, FaTrash } from "react-icons/fa";

// Simplified data structure for student due date information
type StudentDueDateRow = {
  student: UserProfile;
  group: AssignmentGroup | null;
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
    studentPrivateProfileId: student_id
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
    formState: { errors, isSubmitting }
  } = useForm<AdjustDueDateInsert>();

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const { private_profile_id } = useClassProfiles();

  const onSubmitCallback = useCallback(
    async (values: AdjustDueDateInsert) => {
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
      setOpen
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
  const newDueDate = addMinutes(addHours(finalDueDate, watch("hours", 0) || 0), watch("minutes", 0) || 0);

  return (
    <Dialog.Content p={4}>
      <Dialog.Header>
        <Dialog.Title>
          Adjust Due Date for {group ? group.name : <PersonName uid={student_id} showAvatar={false} />}
        </Dialog.Title>
        <Dialog.CloseTrigger />
      </Dialog.Header>
      <Dialog.Description>
        {hasLabScheduling ? (
          <>
            <Text mb={2}>
              <strong>Original Assignment Due Date:</strong>{" "}
              {formatInTimeZone(originalDueDate, time_zone, "MMM d h:mm aaa")}
            </Text>
            <Text mb={2}>
              <strong>Lab-Based Due Date:</strong> {formatInTimeZone(labBasedDueDate, time_zone, "MMM d h:mm aaa")}
              {labBasedDueDate.getTime() !== originalDueDate.getTime() && (
                <Text as="span" color="blue.500" ml={2}>
                  (adjusted for lab scheduling)
                </Text>
              )}
            </Text>
            <Text mb={4}>
              <strong>Current Final Due Date:</strong> {formatInTimeZone(finalDueDate, time_zone, "MMM d h:mm aaa")}
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
            {formatInTimeZone(finalDueDate, time_zone, "MMM d h:mm aaa")}
            {hoursExtended > 0 && ` (an extension of ${formattedDuration})`}.
          </Text>
        )}
        You can manually adjust the due date for this {studentOrGroup} below, in increments of hours and minutes.
        Extensions are applied on top of the {hasLabScheduling ? "lab-based" : "original"} due date.
      </Dialog.Description>
      <Dialog.Body>
        <Heading size="md">Add an Exception</Heading>
        <form id="due-date-form" onSubmit={onSubmit}>
          <Fieldset.Root bg="surface">
            <Fieldset.Content w="xl">
              <Field
                label="Hours Extended"
                errorText={errors.hours?.message?.toString()}
                invalid={errors.hours ? true : false}
              >
                <Input type="number" {...register("hours", { min: 0, required: "Hours extended is required" })} />
              </Field>
              <Field
                label="Minutes Extended"
                errorText={errors.minutes?.message?.toString()}
                invalid={errors.minutes ? true : false}
                helperText="Additional minutes to extend the due date."
              >
                <Input type="number" {...register("minutes", { min: 0, max: 59 })} defaultValue={0} />
              </Field>
              <Field
                label="Tokens to Consume"
                errorText={errors.tokens_consumed?.message?.toString()}
                invalid={errors.tokens_consumed ? true : false}
                helperText="The number of late tokens to consume when granting this extension. Leave at 0 to not consume any of the student's tokens."
                defaultValue={0}
              >
                <Input
                  type="number"
                  {...register("tokens_consumed", {
                    valueAsNumber: true,
                    min: 0,
                    required: "Tokens consumed is required"
                  })}
                />
              </Field>
              <Field
                label="Notes"
                errorText={errors.note?.message?.toString()}
                invalid={errors.note ? true : false}
                helperText="Any additional notes about this extension."
              >
                <Textarea {...register("note")} />
              </Field>
              <Text>
                <strong>New Due Date:</strong> {formatInTimeZone(newDueDate, time_zone, "MMM d h:mm aaa")}
              </Text>
            </Fieldset.Content>
          </Fieldset.Root>
        </form>
        <Heading size="md">Extension History</Heading>
        {extensions.length > 0 ? (
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
                {extensions.map((extension) => (
                  <Table.Row key={extension.id}>
                    <Table.Cell>{formatInTimeZone(extension.created_at, time_zone, "MMM d h:mm aaa")}</Table.Cell>
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
        <Button onClick={onSubmit} loading={isSubmitting} colorPalette="green" type="submit" form="due-date-form">
          Add Due Date Exception
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  );
}
function AdjustDueDateDialog({
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

export default function DueDateExceptions() {
  const course = useCourse();
  const { assignment_id } = useParams();
  const { assignments, assignmentGroupsWithMembers, assignmentDueDateExceptions } = useCourseController();

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

  // Get student roster
  const studentRoster = useStudentRoster();

  const hasLabScheduling = assignment?.minutes_due_after_lab !== null;
  const originalDueDate = useMemo(() => {
    return assignment?.due_date ? new TZDate(assignment.due_date, course.time_zone || "America/New_York") : null;
  }, [assignment?.due_date, course.time_zone]);

  // Process student data with extensions and due dates
  const studentData = useMemo(() => {
    if (!studentRoster || !assignment) return [];

    return studentRoster.map((student): StudentDueDateRow => {
      // Find group for this student
      const group = groups?.find((g) => g.assignment_groups_members.some((m) => m.profile_id === student.id)) || null;

      // Find extensions for this student or their group
      const extensions = allExtensions.filter((ext) => {
        if (group && ext.assignment_group_id === group.id) return true;
        if (!group && ext.student_id === student.id) return true;
        return false;
      });

      // Calculate effective due date (lab-based if applicable)
      let effectiveDueDate = originalDueDate;
      if (hasLabScheduling && originalDueDate) {
        // For now, use original due date - we can enhance this later with lab scheduling logic
        effectiveDueDate = originalDueDate;
      }

      // Calculate total extensions
      const hoursExtended = extensions.reduce((acc, ext) => acc + ext.hours, 0);
      const minutesExtended = extensions.reduce((acc, ext) => acc + (ext.minutes || 0), 0);

      // Calculate final due date with extensions
      const finalDueDate = effectiveDueDate
        ? addMinutes(addHours(effectiveDueDate, hoursExtended), minutesExtended)
        : null;

      return {
        student,
        group,
        effectiveDueDate,
        finalDueDate,
        hoursExtended,
        minutesExtended,
        extensions
      };
    });
  }, [studentRoster, assignment, groups, allExtensions, originalDueDate, hasLabScheduling]);
  const { time_zone } = useCourse();

  // Set up columns for the table
  const columns = useMemo(() => {
    const columnHelper = createColumnHelper<StudentDueDateRow>();
    return [
      columnHelper.accessor("student", {
        id: "student_name",
        header: "Student",
        cell: ({ getValue }) => {
          const student = getValue();
          return <PersonName uid={student.id} showAvatar={false} />;
        }
      }),
      columnHelper.accessor("group", {
        id: "group_name",
        header: "Group",
        cell: ({ getValue }) => {
          const group = getValue();
          return group?.name || <Text color="fg.muted">No group</Text>;
        }
      }),
      columnHelper.accessor("effectiveDueDate", {
        id: "lab_due_date",
        header: "Lab-Based Due Date",
        cell: ({ getValue }) => {
          const effectiveDueDate = getValue();
          if (!effectiveDueDate || !hasLabScheduling) return <Text></Text>;

          const isDifferentFromOriginal = originalDueDate && effectiveDueDate.getTime() !== originalDueDate.getTime();

          return (
            <VStack align="start" gap={1}>
              <Text>{formatInTimeZone(effectiveDueDate, time_zone, "MMM d h:mm aaa")}</Text>
              {isDifferentFromOriginal && (
                <Text fontSize="xs" color="blue.500">
                  (lab-adjusted)
                </Text>
              )}
            </VStack>
          );
        }
      }),
      columnHelper.accessor("finalDueDate", {
        id: "final_due_date",
        header: "Final Due Date",
        cell: ({ getValue, row }) => {
          const finalDate = getValue();
          const { hoursExtended, minutesExtended } = row.original;

          if (!finalDate || (hoursExtended === 0 && minutesExtended === 0)) return <Text></Text>;

          return (
            <VStack align="start" gap={1}>
              <Text>{formatInTimeZone(finalDate, time_zone, "MMM d h:mm aaa")}</Text>
              <Text fontSize="xs" color="orange.500">
                (+{hoursExtended}h {minutesExtended}m)
              </Text>
            </VStack>
          );
        }
      }),
      columnHelper.display({
        id: "hours_extended",
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
      }),
      columnHelper.display({
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const { student, group } = row.original;

          return assignment ? (
            <AdjustDueDateDialog student_id={student.id} group={group || undefined} assignment={assignment} />
          ) : null;
        }
      })
    ];
  }, [hasLabScheduling, originalDueDate, assignment, time_zone]);

  // Set up React Table
  const table = useReactTable({
    data: studentData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    initialState: {
      sorting: [{ id: "student_name", desc: false }],
      columnVisibility: {
        lab_due_date: hasLabScheduling
      }
    }
  });

  if (!assignment) {
    return <Skeleton height="400px" width="100%" />;
  }

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
            {originalDueDate ? formatInTimeZone(originalDueDate, time_zone, "MMM d h:mm aaa") : "No due date"}
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

      {/* Table */}
      <Box w="100%" overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto">
        <Table.Root minW="0" w="100%">
          <Table.Header>
            {table.getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader
                    key={header.id}
                    bg="bg.muted"
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 20
                    }}
                  >
                    {header.isPlaceholder ? null : (
                      <Text onClick={header.column.getToggleSortingHandler()}>
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
                      </Text>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {table.getRowModel().rows.map((row, idx) => (
              <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined}>
                {row.getVisibleCells().map((cell) => (
                  <Table.Cell key={cell.id} p={2}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>

      <Text>{studentData.length} Students</Text>
    </VStack>
  );
}
