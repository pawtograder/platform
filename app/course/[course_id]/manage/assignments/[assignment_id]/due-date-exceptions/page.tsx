"use client";
import PersonAvatar from "@/components/ui/person-avatar";
import PersonName from "@/components/ui/person-name";
import { useCourse } from "@/hooks/useAuthState";
import { useStudentRoster } from "@/hooks/useClassProfiles";
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
import { Field } from "@/components/ui/field";
import { TZDate } from "@date-fns/tz";
import { useDelete, useList, useOne } from "@refinedev/core";
import { addHours } from "date-fns";
import { useParams } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCallback } from "react";
import { FaTrash } from "react-icons/fa";
import { PopConfirm } from "@/components/ui/popconfirm";
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
  const hoursExtended = extensions?.reduce((acc, exception) => acc + exception.hours, 0) || 0;
  const late_due_date = addHours(
    new TZDate(assignment.due_date!, course.time_zone || "America/New_York"),
    hoursExtended
  );
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
            The current due date for this {studentOrGroup} is {late_due_date.toLocaleString()} (an extension of{" "}
            {formattedDuration}). You can manually adjust the due date for this {studentOrGroup} below, in increments of
            hours. You can also choose to consume a late token when granting an extension, or could even grant extra
            tokens (with a negative number for tokens consumed).
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
                  <Text>New Due Date: {addHours(late_due_date, watch("hours", 0) || 0).toLocaleString()}</Text>
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
                        <Table.Cell>{extension.tokens_consumed}</Table.Cell>
                        <Table.Cell>
                          <PersonName showAvatar={false} uid={extension.creator_id} />
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
            <Dialog.CloseTrigger asChild>
              <Button>Close</Button>
            </Dialog.CloseTrigger>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
export default function DueDateExceptions() {
  const course = useCourse();
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
    filters: [{ field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) }]
  });
  const { data: dueDateExceptions } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    queryOptions: { enabled: !!course },
    liveMode: "auto",
    filters: [{ field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) }],
    sorters: [{ field: "created_at", order: "desc" }]
  });
  if (!assignment || !groups || !dueDateExceptions) {
    return <Skeleton height="400px" width="100%" />;
  }

  return (
    <Box>
      <Heading size="md">Due Date Exceptions</Heading>
      <Heading size="sm">
        Normal Due Date:{" "}
        {new TZDate(assignment?.data.due_date!, course.classes.time_zone || "America/New_York").toLocaleString()}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        This assignment allows students to use up to {assignment?.data.max_late_tokens} late tokens to extend the due
        date. Each late token extends the due date by 24 hours. Students in the course are given a total of{" "}
        {course.classes.late_tokens_per_student} late tokens. You can view and edit the due date exceptions for each
        student below. Changing the due date exceptions for a group of students will override the due date for all
        students in the group.
      </Text>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Due Date</Table.ColumnHeader>
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
            const hoursExtended = exceptions?.reduce((acc, exception) => acc + exception.hours, 0) || 0;
            const late_due_date = addHours(
              new TZDate(assignment.data.due_date!, course.classes.time_zone || "America/New_York"),
              hoursExtended
            );
            const grantors = exceptions?.map((exception) => exception.creator_id);
            const uniqueGrantors = [...new Set(grantors)];
            return (
              <Table.Row key={student.id}>
                <Table.Cell>{student.name}</Table.Cell>
                <Table.Cell>{group?.assignment_groups.name}</Table.Cell>
                <Table.Cell>{hoursExtended > 0 ? late_due_date.toLocaleString() : ""}</Table.Cell>
                <Table.Cell>
                  <HStack>
                    {hoursExtended > 0 ? hoursExtended : ""}
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
