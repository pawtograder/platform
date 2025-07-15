"use client";
import { Field } from "@/components/ui/field";
import PersonAvatar from "@/components/ui/person-avatar";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useCourse } from "@/hooks/useAuthState";
import { useClassProfiles, useStudentRoster } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroup,
  AssignmentGroupMembersWithGroup,
  Course,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
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
  Textarea
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useDelete, useList, useOne } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { addHours, addMinutes } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback } from "react";
import { FaTrash } from "react-icons/fa";

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
  const courseController = useCourseController();
  const studentOrGroup = group ? "group" : "student";
  const dueDateFor = group ? `Group: ${group.name}` : `Student: ${student.name}`;
  
  // Calculate lab-based effective due date
  const originalDueDate = new TZDate(assignment.due_date!);
  const labBasedDueDate = courseController.isLoaded 
    ? new TZDate(courseController.calculateEffectiveDueDate(assignment, { studentPrivateProfileId: student.id }))
    : originalDueDate;
  
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
        <Button>Adjust Due Date</Button>
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
            Extensions are applied on top of the {hasLabScheduling ? 'lab-based' : 'original'} due date.
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
                    <Input
                      type="number"
                      {...register("minutes", { min: 0, max: 59 })}
                      defaultValue={0}
                    />
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
                              confirmText="Are you sure you want to delete this extension?"
                              onConfirm={() =>
                                deleteException({ id: extension.id, resource: "assignment_due_date_exceptions" })
                              }
                              onCancel={() => {}}
                              confirmHeader="Delete extension"
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
  const course = useCourse();
  const courseController = useCourseController();
  const { assignment_id } = useParams();
  const students = useStudentRoster();
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
  const { data: dueDateExceptions } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    queryOptions: { enabled: !!course },
    liveMode: "auto",
    pagination: { pageSize: 1000 },
    filters: [{ field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) }],
    sorters: [{ field: "created_at", order: "desc" }]
  });
  
  if (!assignment || !groups || !dueDateExceptions) {
    return <Skeleton height="400px" width="100%" />;
  }

  const hasLabScheduling = assignment.data.minutes_due_after_lab !== null;
  const originalDueDate = new TZDate(assignment.data.due_date, course.classes.time_zone || "America/New_York");

  return (
    <Box>
      <Heading size="md">Due Date Exceptions</Heading>
      <Box mb={4} p={4} bg="bg.subtle" borderRadius="md">
        <Heading size="sm" mb={2}>Assignment Due Date Information</Heading>
        <Text mb={2}>
          <strong>Original Assignment Due Date:</strong> {originalDueDate.toLocaleString()}
        </Text>
        {hasLabScheduling && (
          <Text mb={2} color="blue.600">
            <strong>Lab-Based Scheduling:</strong> This assignment uses lab-based due dates. 
                         Each student&apos;s effective due date is calculated as {assignment.data.minutes_due_after_lab} minutes 
            after their most recent lab meeting before the original due date.
          </Text>
        )}
        <Text fontSize="sm" color="fg.muted">
          This assignment allows students to use up to {assignment?.data.max_late_tokens} late tokens to extend the due
          date. Each late token extends the due date by 24 hours. Students in the course are given a total of{" "}
          {course.classes.late_tokens_per_student} late tokens. You can view and edit the due date exceptions for each
          student below. Extensions are applied on top of the {hasLabScheduling ? 'lab-based' : 'original'} due date.
        </Text>
      </Box>
      
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            {hasLabScheduling && <Table.ColumnHeader>Lab-Based Due Date</Table.ColumnHeader>}
            <Table.ColumnHeader>Final Due Date</Table.ColumnHeader>
            <Table.ColumnHeader>Hours Extended</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {students.map((student) => {
            const group = groups.data?.find((group) => group.profile_id === student.id);
            const exceptions = dueDateExceptions?.data.filter(
              (exception) =>
                exception.student_id === student.id ||
                (group && exception.assignment_group_id === group.assignment_groups.id)
            );
            
            // Calculate lab-based effective due date
            const labBasedDueDate = courseController.isLoaded 
              ? new TZDate(courseController.calculateEffectiveDueDate(assignment.data, { studentPrivateProfileId: student.id }))
              : originalDueDate;
            
            // Calculate final due date with extensions
            const hoursExtended = exceptions?.reduce((acc, exception) => acc + exception.hours, 0) || 0;
            const minutesExtended = exceptions?.reduce((acc, exception) => acc + exception.minutes, 0) || 0;
            const finalDueDate = addMinutes(addHours(labBasedDueDate, hoursExtended), minutesExtended);
            
            const grantors = exceptions?.map((exception) => exception.creator_id);
            const uniqueGrantors = [...new Set(grantors)];
            
            const hasExtensions = hoursExtended > 0 || minutesExtended > 0;
            const isDifferentFromOriginal = hasLabScheduling && labBasedDueDate.getTime() !== originalDueDate.getTime();
            
            return (
              <Table.Row key={student.id}>
                <Table.Cell>{student.name}</Table.Cell>
                <Table.Cell>{group?.assignment_groups.name}</Table.Cell>
                {hasLabScheduling && (
                  <Table.Cell>
                    <Text>{labBasedDueDate.toLocaleString()}</Text>
                    {isDifferentFromOriginal && (
                      <Text fontSize="xs" color="blue.500">
                        (lab-adjusted)
                      </Text>
                    )}
                  </Table.Cell>
                )}
                <Table.Cell>
                  <Text>{hasExtensions ? finalDueDate.toLocaleString() : ""}</Text>
                  {hasExtensions && (
                    <Text fontSize="xs" color="orange.500">
                      (+{hoursExtended}h {minutesExtended}m)
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <HStack>
                    {hasExtensions ? `${hoursExtended}h ${minutesExtended}m` : ""}
                    {uniqueGrantors.map((grantor) => (
                      <PersonAvatar key={grantor} uid={grantor} size="2xs" />
                    ))}
                  </HStack>
                </Table.Cell>
                <Table.Cell>
                  <AdjustDueDateDialog
                    student={student}
                    group={group?.assignment_groups}
                    assignment={assignment.data}
                    course={course.classes}
                    extensions={exceptions}
                  />
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
