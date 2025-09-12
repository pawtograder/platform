"use client";
import { Field } from "@/components/ui/field";
import PersonAvatar from "@/components/ui/person-avatar";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignmentDueDate, useCourseController, useStudentRoster } from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroup,
  AssignmentGroupMembersWithGroup,
  Course,
  UserProfile
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
  Spinner,
  Table,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { useDelete, useList, useOne } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { addHours, addMinutes } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { FaSort, FaSortDown, FaSortUp, FaTrash } from "react-icons/fa";
import { Select } from "chakra-react-select";

// Type for the assignments_for_student_dashboard view data
type StudentDueDateRow = Database["public"]["Views"]["assignments_for_student_dashboard"]["Row"];

function AdjustDueDateDialog({
  student,
  group,
  assignment,
  course,
  extensions
}: {
  student: UserProfile;
  group?: AssignmentGroup;
  assignment: Assignment;
  course: Course;
  extensions: AssignmentDueDateException[];
}) {
  const studentOrGroup = group ? "group" : "student";
  const dueDateFor = group ? `Group: ${group.name}` : `Student: ${student.name}`;

  // Calculate lab-based effective due date using the hook
  const dueDateInfo = useAssignmentDueDate(assignment, { studentPrivateProfileId: student.id });
  const originalDueDate = new TZDate(assignment.due_date!);
  const labBasedDueDate = dueDateInfo.effectiveDueDate || originalDueDate;

  // Calculate final due date with extensions
  const hoursExtended = extensions?.reduce((acc, exception) => acc + exception.hours, 0) || 0;
  const minutesExtended = extensions?.reduce((acc, exception) => acc + exception.minutes, 0) || 0;
  const finalDueDate = addMinutes(addHours(labBasedDueDate, hoursExtended), minutesExtended);

  const { mutateAsync: deleteException } = useDelete();
  const {
    handleSubmit,
    setValue,
    register,
    watch,
    formState: { errors, isSubmitting },
    refineCore
  } = useForm({ refineCoreProps: { resource: "assignment_due_date_exceptions", action: "create" } });
  const { private_profile_id } = useClassProfiles();

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      async function populate() {
        setValue("class_id", student.class_id);
        setValue("student_id", group ? null : student.id);
        setValue("assignment_id", assignment.id);
        setValue("assignment_group_id", group?.id);
        setValue("creator_id", private_profile_id!);
        handleSubmit(refineCore.onFinish)();
      }
      populate();
    },
    [
      handleSubmit,
      refineCore.onFinish,
      private_profile_id,
      assignment.id,
      group,
      student.id,
      setValue,
      student.class_id
    ]
  );

  const toHoursDays = (hours: number) => {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} days ${remainingHours} hours`;
  };

  const formattedDuration = toHoursDays(hoursExtended);
  const hasLabScheduling = assignment.minutes_due_after_lab !== null;
  const newDueDate = addMinutes(addHours(finalDueDate, watch("hours", 0) || 0), watch("minutes", 0) || 0);

  return (
    <Dialog.Root size="xl">
      <Dialog.Trigger asChild>
        <Button size="xs" colorPalette="green" variant="subtle">
          Adjust Due Date
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content p={4}>
          <Dialog.Title>Adjust Due Date for {dueDateFor}</Dialog.Title>
          <Dialog.Description>
            {hasLabScheduling ? (
              <>
                <Text mb={2}>
                  <strong>Original Assignment Due Date:</strong> {originalDueDate.toLocaleString()}
                </Text>
                <Text mb={2}>
                  <strong>Lab-Based Due Date:</strong> {labBasedDueDate.toLocaleString()}
                  {labBasedDueDate.getTime() !== originalDueDate.getTime() && (
                    <Text as="span" color="blue.500" ml={2}>
                      (adjusted for lab scheduling)
                    </Text>
                  )}
                </Text>
                <Text mb={4}>
                  <strong>Current Final Due Date:</strong> {new TZDate(finalDueDate).toLocaleString()}
                  {hoursExtended > 0 && (
                    <Text as="span" color="orange.500" ml={2}>
                      (with {formattedDuration} extension)
                    </Text>
                  )}
                </Text>
              </>
            ) : (
              <Text mb={4}>
                The current due date for this {studentOrGroup} is {new TZDate(finalDueDate).toLocaleString()}
                {hoursExtended > 0 && ` (an extension of ${formattedDuration})`}.
              </Text>
            )}
            You can manually adjust the due date for this {studentOrGroup} below, in increments of hours and minutes.
            Extensions are applied on top of the {hasLabScheduling ? "lab-based" : "original"} due date.
          </Dialog.Description>
          <Dialog.Body>
            <Heading size="md">Add an Exception</Heading>
            <form onSubmit={onSubmit}>
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
                    <strong>New Due Date:</strong> {newDueDate.toLocaleString()}
                  </Text>
                  <Button type="submit" loading={isSubmitting} colorPalette="green">
                    Add Due Date Exception
                  </Button>
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
                        <Table.Cell>
                          {new TZDate(extension.created_at, course.time_zone || "America/New_York").toLocaleString()}
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
                              confirmHeader="Delete extension"
                              confirmText="Are you sure you want to delete this extension?"
                              onConfirm={async () => {
                                await deleteException({ id: extension.id, resource: "assignment_due_date_exceptions" });
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
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

export default function DueDateExceptions() {
  const { role } = useClassProfiles();
  const course = role.classes;
  const { assignment_id } = useParams();
  const { classRealTimeController } = useCourseController();
  const supabase = createClient();

  const { data: assignment } = useOne<Assignment>({
    resource: "assignments",
    id: Number.parseInt(assignment_id as string)
  });

  const { data: groups } = useList<AssignmentGroupMembersWithGroup>({
    resource: "assignment_groups_members",
    queryOptions: { enabled: !!assignment },
    meta: { select: "*, assignment_groups(*)" },
    pagination: { pageSize: 1000 },
    filters: [{ field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) }]
  });

  const hasLabScheduling = assignment?.data.minutes_due_after_lab !== null;
  const originalDueDate = useMemo(() => {
    return assignment?.data.due_date
      ? new TZDate(assignment.data.due_date, course.time_zone || "America/New_York")
      : null;
  }, [assignment?.data.due_date, course.time_zone]);

  // Get student roster to map profile IDs to names
  const studentRoster = useStudentRoster();

  // Create a mapping of profile ID to student name
  const studentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (studentRoster) {
      studentRoster.forEach((student) => {
        if (student.id && student.name) {
          map.set(student.id, student.name);
        }
      });
    }
    return map;
  }, [studentRoster]);

  // Set up columns for the table
  const columns = useMemo<ColumnDef<StudentDueDateRow>[]>(
    () => [
      {
        id: "assignment_id",
        accessorKey: "id",
        header: "Assignment ID",
        filterFn: (row, id, filterValue) => {
          return String(row.original.id) === String(filterValue);
        }
      },
      {
        id: "student_name",
        accessorFn: (row) => {
          // Get student name from the name map
          return studentNameMap.get(row.student_profile_id || "") || "Unknown Student";
        },
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const studentName = studentNameMap.get(row.original.student_profile_id || "");
          if (!studentName) return values.includes("Unknown Student");
          return values.some((val) => studentName.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => <PersonName uid={row.original.student_profile_id!} showAvatar={false} />
      },
      {
        id: "group_name",
        accessorFn: (row) => {
          // Find group for this student
          const group = groups?.data?.find((g) => g.profile_id === row.student_profile_id);
          return group?.assignment_groups.name || "";
        },
        header: "Group",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const group = groups?.data?.find((g) => g.profile_id === row.original.student_profile_id);
          const groupName = group?.assignment_groups.name;
          if (!groupName) return values.includes("No group");
          return values.some((val) => groupName.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ getValue }) => {
          const groupName = getValue() as string;
          return groupName || <Text color="fg.muted">No group</Text>;
        }
      },
      {
        id: "lab_due_date",
        accessorKey: "due_date",
        header: "Lab-Based Due Date",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const dueDate = row.original.due_date;
          if (!dueDate) return values.includes("No due date");

          const labDueDate = new TZDate(dueDate, course.time_zone || "America/New_York");
          const formattedDate = labDueDate.toLocaleDateString();
          return values.some((val) => formattedDate.includes(val));
        },
        cell: ({ getValue }) => {
          const dueDate = getValue() as string | null;
          if (!dueDate || !hasLabScheduling) return <Text></Text>;

          const labDueDate = new TZDate(dueDate, course.time_zone || "America/New_York");
          const isDifferentFromOriginal = originalDueDate && labDueDate.getTime() !== originalDueDate.getTime();

          return (
            <VStack align="start" gap={1}>
              <Text>{labDueDate.toLocaleString()}</Text>
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
        accessorFn: (row) => {
          const baseDueDate = row.due_date ? new TZDate(row.due_date) : originalDueDate || new Date();
          const hoursExtended = row.exception_hours || 0;
          const minutesExtended = row.exception_minutes || 0;

          if (hoursExtended === 0 && minutesExtended === 0) {
            return null;
          }

          return addMinutes(addHours(baseDueDate, hoursExtended), minutesExtended);
        },
        header: "Final Due Date",
        cell: ({ getValue, row }) => {
          const finalDate = getValue() as Date | null;
          const hoursExtended = row.original.exception_hours || 0;
          const minutesExtended = row.original.exception_minutes || 0;

          if (!finalDate) return <Text></Text>;

          return (
            <VStack align="start" gap={1}>
              <Text>{finalDate.toLocaleString()}</Text>
              <Text fontSize="xs" color="orange.500">
                (+{hoursExtended}h {minutesExtended}m)
              </Text>
            </VStack>
          );
        }
      },
      {
        id: "hours_extended",
        accessorFn: (row) => {
          const hours = row.exception_hours || 0;
          const minutes = row.exception_minutes || 0;
          return hours > 0 || minutes > 0 ? `${hours}h ${minutes}m` : "";
        },
        header: "Hours Extended",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const hours = row.original.exception_hours || 0;
          const minutes = row.original.exception_minutes || 0;
          const hasExtension = hours > 0 || minutes > 0;
          const extensionText = hasExtension ? `${hours}h ${minutes}m` : "";

          if (!hasExtension) return values.includes("No extension");
          return values.some((val) => extensionText.includes(val));
        },
        cell: ({ getValue, row }) => {
          const extension = getValue() as string;
          if (!extension) return <Text></Text>;

          // Show avatar of who granted the extension
          return (
            <HStack>
              <Text>{extension}</Text>
              {row.original.exception_creator_id && <PersonAvatar uid={row.original.exception_creator_id} size="2xs" />}
            </HStack>
          );
        }
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          // We need to reconstruct student and group objects for the dialog
          const studentId = row.original.student_profile_id!;
          const group = groups?.data?.find((g) => g.profile_id === studentId);

          // Create a minimal student object
          const student = {
            id: studentId,
            name: studentId, // PersonName component will handle the actual name lookup
            class_id: row.original.class_id!
          } as UserProfile;

          // Get all exceptions for this student
          const exceptions: AssignmentDueDateException[] = [];
          if (row.original.due_date_exception_id) {
            exceptions.push({
              id: row.original.due_date_exception_id,
              created_at: row.original.exception_created_at!,
              hours: row.original.exception_hours!,
              minutes: row.original.exception_minutes || 0,
              tokens_consumed: row.original.exception_tokens_consumed || 0,
              creator_id: row.original.exception_creator_id!,
              note: row.original.exception_note || "",
              class_id: row.original.class_id!,
              assignment_id: row.original.id!,
              student_id: studentId,
              assignment_group_id: group?.assignment_groups.id || null
            });
          }

          return assignment ? (
            <AdjustDueDateDialog
              student={student}
              group={group?.assignment_groups}
              assignment={assignment.data}
              course={course}
              extensions={exceptions}
            />
          ) : null;
        }
      }
    ],
    [hasLabScheduling, originalDueDate, course, groups, assignment, studentNameMap]
  );

  // Set up TableController
  const tableController = useMemo(() => {
    const query = supabase
      .from("assignments_for_student_dashboard")
      .select("*")
      .eq("id", Number.parseInt(assignment_id as string));

    return new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: "assignments_for_student_dashboard" as any,
      classRealTimeController
    });
  }, [supabase, assignment_id, classRealTimeController]);

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    getRowCount,
    setPageIndex,
    getCanPreviousPage,
    getPageCount,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    isLoading
  } = useTableControllerTable({
    columns,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tableController: tableController as any,
    initialState: {
      columnFilters: [{ id: "assignment_id", value: assignment_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      },
      sorting: [{ id: "student_name", desc: false }],
      columnVisibility: {
        assignment_id: false,
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
            <strong>Original Assignment Due Date:</strong> {originalDueDate?.toLocaleString() || "No due date"}
          </Text>
          {hasLabScheduling && (
            <Text mb={2} color="blue.600">
              <strong>Lab-Based Scheduling:</strong> This assignment uses lab-based due dates. Each student&apos;s
              effective due date is calculated as {assignment.data.minutes_due_after_lab} minutes after their most
              recent lab meeting before the original due date.
            </Text>
          )}
          <Text fontSize="sm" color="fg.muted">
            This assignment allows students to use up to {assignment.data.max_late_tokens} late tokens to extend the due
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
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers
                  .filter((h) => h.id !== "assignment_id")
                  .map((header) => (
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
                        <>
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
                          {header.id === "student_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                ...Array.from(
                                  getRowModel()
                                    .rows.reduce((map, row) => {
                                      const studentName = studentNameMap.get(row.original.student_profile_id || "");
                                      if (studentName && !map.has(studentName)) {
                                        map.set(studentName, studentName);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((name) => ({ label: name, value: name })),
                                { label: "Unknown Student", value: "Unknown Student" }
                              ]}
                              placeholder="Filter by student..."
                            />
                          )}
                          {header.id === "group_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                ...Array.from(
                                  getRowModel()
                                    .rows.reduce((map, row) => {
                                      const group = groups?.data?.find(
                                        (g) => g.profile_id === row.original.student_profile_id
                                      );
                                      const groupName = group?.assignment_groups.name;
                                      if (groupName && !map.has(groupName)) {
                                        map.set(groupName, groupName);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((name) => ({ label: name, value: name })),
                                { label: "No group", value: "No group" }
                              ]}
                              placeholder="Filter by group..."
                            />
                          )}
                          {header.id === "lab_due_date" && hasLabScheduling && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                ...Array.from(
                                  getRowModel()
                                    .rows.reduce((map, row) => {
                                      const dueDate = row.original.due_date;
                                      if (dueDate) {
                                        const labDueDate = new TZDate(dueDate, course.time_zone || "America/New_York");
                                        const formattedDate = labDueDate.toLocaleDateString();
                                        if (!map.has(formattedDate)) {
                                          map.set(formattedDate, formattedDate);
                                        }
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((date) => ({ label: date, value: date })),
                                { label: "No due date", value: "No due date" }
                              ]}
                              placeholder="Filter by lab due date..."
                            />
                          )}
                          {header.id === "hours_extended" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                ...Array.from(
                                  getRowModel()
                                    .rows.reduce((map, row) => {
                                      const hours = row.original.exception_hours || 0;
                                      const minutes = row.original.exception_minutes || 0;
                                      const hasExtension = hours > 0 || minutes > 0;
                                      if (hasExtension) {
                                        const extensionText = `${hours}h ${minutes}m`;
                                        if (!map.has(extensionText)) {
                                          map.set(extensionText, extensionText);
                                        }
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((extension) => ({ label: extension, value: extension })),
                                { label: "No extension", value: "No extension" }
                              ]}
                              placeholder="Filter by extension..."
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
            {isLoading && (
              <Table.Row>
                <Table.Cell colSpan={getHeaderGroups()[0]?.headers.length || 6} bg="bg.subtle">
                  <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                    <Spinner size="lg" />
                    <Text>Loading...</Text>
                  </VStack>
                </Table.Cell>
              </Table.Row>
            )}
            {getRowModel().rows.map((row, idx) => (
              <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined}>
                {row
                  .getVisibleCells()
                  .filter((c) => c.column.id !== "assignment_id")
                  .map((cell) => (
                    <Table.Cell key={cell.id} p={0}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Table.Cell>
                  ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>

      {/* Pagination */}
      <HStack>
        <Button onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
          {"<<"}
        </Button>
        <Button onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
          {"<"}
        </Button>
        <Button onClick={() => nextPage()} disabled={!getCanNextPage()}>
          {">"}
        </Button>
        <Button onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
          {">>"}
        </Button>
        <VStack>
          <Text>Page</Text>
          <Text>
            {getState().pagination.pageIndex + 1} of {getPageCount()}
          </Text>
        </VStack>
        <VStack>
          | Go to page:
          <input
            title="Go to page"
            type="number"
            defaultValue={getState().pagination.pageIndex + 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              setPageIndex(page);
            }}
          />
        </VStack>
        <VStack>
          <Text>Show</Text>
          <NativeSelect.Root title="Select page size">
            <NativeSelect.Field
              value={"" + getState().pagination.pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
              }}
            >
              {[25, 50, 100, 200, 500, 1000].map((pageSize) => (
                <option key={pageSize} value={pageSize}>
                  Show {pageSize}
                </option>
              ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </VStack>
      </HStack>
      <div>{getRowCount()} Students</div>
    </VStack>
  );
}
