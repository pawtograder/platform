"use client";

import { Button } from "@/components/ui/button";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useCourse, useCourseController } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { useIsTableControllerReady, useListTableControllerValues } from "@/lib/TableController";
import { Assignment, AssignmentDueDateException } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Icon, Table, Text, VStack } from "@chakra-ui/react";
import { formatInTimeZone } from "date-fns-tz";
import { useMemo } from "react";
import { FaPlus, FaTrash } from "react-icons/fa";
import AddExceptionModal, { AddExtensionDefaults } from "../modals/addExceptionModal";

interface AssignmentExceptionsTableProps {
  assignment: Assignment;
  assignmentFilter?: number;
  studentFilter?: string;
  tokenFilter?: "any" | "has" | "none";
}

/**
 * Renders due date exceptions for a single assignment
 */
export default function AssignmentExceptionsTable({
  assignment,
  assignmentFilter,
  studentFilter,
  tokenFilter
}: AssignmentExceptionsTableProps) {
  const course = useCourse();
  const { assignmentDueDateExceptions } = useCourseController();
  const predicate = useMemo(() => {
    return (e: AssignmentDueDateException) => {
      // Must be for this assignment
      if (e.assignment_id !== assignment.id) return false;

      // Apply filters
      const aPass = assignmentFilter ? e.assignment_id === assignmentFilter : true;
      const sPass = studentFilter ? e.student_id === studentFilter : true;
      const tPass =
        tokenFilter === "has" ? e.tokens_consumed > 0 : tokenFilter === "none" ? e.tokens_consumed === 0 : true;
      return aPass && sPass && tPass;
    };
  }, [assignment.id, assignmentFilter, studentFilter, tokenFilter]);
  const exceptions = useListTableControllerValues(assignmentDueDateExceptions, predicate);
  const isReady = useIsTableControllerReady(assignmentDueDateExceptions);
  const students = useAllStudentProfiles();

  const addOpen = useModalManager<AddExtensionDefaults>();

  const studentName = (id: string | null | undefined) => students.find((s) => s.id === id)?.name || id;
  console.log("exceptions", exceptions);

  return (
    <Box borderWidth="1px" borderRadius="md" p={3}>
      <HStack justifyContent="space-between" mb={2}>
        <VStack align="flex-start">
          <Heading size="sm">{assignment.title || `Assignment #${assignment.id}`}</Heading>
          <Text fontSize="sm" color="fg.muted">
            {exceptions.length} exceptions, normal due date:{" "}
            {formatInTimeZone(assignment.due_date, course.time_zone || "America/New_York", "MMM d h:mm aaa")}
            {assignment.minutes_due_after_lab !== null &&
              ` (auto-calculated for students as ${assignment.minutes_due_after_lab} minutes after lab)`}
          </Text>
        </VStack>
        <HStack gap={2}>
          <Button
            colorPalette="green"
            variant="solid"
            size="sm"
            onClick={() => addOpen.openModal({ assignmentId: assignment.id })}
          >
            <Icon as={FaPlus} /> Add Exception
          </Button>
        </HStack>
      </HStack>

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Hours</Table.ColumnHeader>
            <Table.ColumnHeader>Minutes</Table.ColumnHeader>
            <Table.ColumnHeader>Tokens</Table.ColumnHeader>
            <Table.ColumnHeader>Grantor</Table.ColumnHeader>
            <Table.ColumnHeader>Note</Table.ColumnHeader>
            <Table.ColumnHeader>Date</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {!isReady || !exceptions ? (
            <Table.Row>
              <Table.Cell colSpan={8} textAlign="center" color="fg.muted" py={4}>
                Loading...
              </Table.Cell>
            </Table.Row>
          ) : exceptions.length > 0 ? (
            exceptions.map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell>{studentName(r.student_id) ?? "Missing Student"}</Table.Cell>
                <Table.Cell>{r.hours}</Table.Cell>
                <Table.Cell>{r.minutes || 0}</Table.Cell>
                <Table.Cell>{r.tokens_consumed}</Table.Cell>
                <Table.Cell>{r.creator_id ? <PersonName uid={r.creator_id} /> : ""}</Table.Cell>
                <Table.Cell>{r.note}</Table.Cell>
                <Table.Cell>
                  {new Date(r.created_at).toLocaleString("en-US", {
                    timeZone: course.time_zone || "America/New_York"
                  })}
                </Table.Cell>
                <Table.Cell>
                  <HStack gap={2}>
                    <PopConfirm
                      triggerLabel="Delete"
                      trigger={
                        <Button size="xs" variant="ghost" colorPalette="red">
                          <Icon as={FaTrash} />
                        </Button>
                      }
                      confirmHeader="Delete exception"
                      confirmText="Are you sure you want to delete this exception?"
                      onConfirm={async () => {
                        try {
                          await assignmentDueDateExceptions.hardDelete(r.id);
                        } catch (err) {
                          toaster.error({
                            title: "Delete failed",
                            description: err instanceof Error ? err.message : "Unknown error"
                          });
                        }
                      }}
                    />
                  </HStack>
                </Table.Cell>
              </Table.Row>
            ))
          ) : (
            <Table.Row>
              <Table.Cell colSpan={8} textAlign="center" color="fg.muted" py={4}>
                No extensions
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>
      <AddExceptionModal isOpen={addOpen.isOpen} onClose={addOpen.closeModal} defaults={addOpen.modalData || {}} />
    </Box>
  );
}
