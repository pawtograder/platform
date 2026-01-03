"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Button } from "@/components/ui/button";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useCourse, useCourseController } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { useIsTableControllerReady, useListTableControllerValues } from "@/lib/TableController";
import { Assignment, AssignmentDueDateException, AssignmentGroup } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Icon, Table, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { FaPlus, FaTrash } from "react-icons/fa";
import AddExceptionModal, { AddExtensionDefaults } from "../modals/addExceptionModal";

interface AssignmentExceptionsTableProps {
  assignment: Assignment;
  assignmentFilter?: number;
  studentFilter?: string;
  tokenFilter?: "any" | "has" | "none";
}

/** LEGACY HOOK, THIS IS A BAD PATTERN, DO NOT CONTINUE TO EXTEND OR USE THIS. FUTURE WORK SHOULD OPTIMIZE THE PERFORMANCE OF THIS PAGE. */
function useAssignmentGroupsWithMembers(assignment_id: number) {
  const { assignmentGroupsWithMembers } = useCourseController();
  const predicate = useMemo(() => (g: AssignmentGroup) => g.assignment_id === assignment_id, [assignment_id]);
  return useListTableControllerValues(assignmentGroupsWithMembers, predicate);
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
  // // Load assignment groups with their members for this assignment
  const assignmentGroups = useAssignmentGroupsWithMembers(assignment.id);
  const groupIdToMemberIds = useMemo(() => {
    const map = new Map<number, string[]>();
    if (!assignmentGroups) return map;
    for (const group of assignmentGroups) {
      const memberIds = group.assignment_groups_members.map((member) => member.profile_id);
      map.set(group.id, memberIds);
    }
    return map;
  }, [assignmentGroups]);
  const groupIdToName = useMemo(() => {
    const map = new Map<number, string>();
    if (!assignmentGroups) return map;
    for (const group of assignmentGroups) {
      map.set(group.id, group.name);
    }
    return map;
  }, [assignmentGroups]);
  const profileIdToGroupId = useMemo(() => {
    const map = new Map<string, number>();
    if (!assignmentGroups) return map;
    for (const group of assignmentGroups) {
      for (const member of group.assignment_groups_members) {
        map.set(member.profile_id, group.id);
      }
    }
    return map;
  }, [assignmentGroups]);
  const predicate = useMemo(() => {
    return (e: AssignmentDueDateException) => {
      // Must be for this assignment
      if (e.assignment_id !== assignment.id) return false;

      // Apply filters
      const aPass = assignmentFilter ? e.assignment_id === assignmentFilter : true;
      const sPass = studentFilter
        ? (() => {
            if (e.student_id) return e.student_id === studentFilter;
            if (e.assignment_group_id) {
              const members = groupIdToMemberIds.get(e.assignment_group_id) || [];
              return members.includes(studentFilter);
            }
            return false;
          })()
        : true;
      const tPass =
        tokenFilter === "has" ? e.tokens_consumed > 0 : tokenFilter === "none" ? e.tokens_consumed === 0 : true;
      return aPass && sPass && tPass;
    };
  }, [assignment.id, assignmentFilter, studentFilter, tokenFilter, groupIdToMemberIds]);
  const exceptions = useListTableControllerValues(assignmentDueDateExceptions, predicate);
  const isReady = useIsTableControllerReady(assignmentDueDateExceptions);
  const students = useAllStudentProfiles();

  const addOpen = useModalManager<AddExtensionDefaults>();

  const studentName = (id: string | null | undefined) => students.find((s) => s.id === id)?.name || id;

  return (
    <Box
      borderWidth="1px"
      borderRadius="md"
      p={3}
      aria-label={`Assignment Exceptions for ${assignment.title || `Assignment #${assignment.id}`}`}
    >
      <HStack justifyContent="space-between" mb={2}>
        <VStack align="flex-start">
          <Heading size="sm">{assignment.title || `Assignment #${assignment.id}`}</Heading>
          <Text fontSize="sm" color="fg.muted">
            {exceptions?.length || 0} exceptions, normal due date:{" "}
            <TimeZoneAwareDate date={assignment.due_date} format="MMM d, h:mm a" />
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
            <Table.ColumnHeader>Student / Group</Table.ColumnHeader>
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
                <Table.Cell>
                  <VStack align="flex-start" gap={0}>
                    {r.assignment_group_id ? (
                      <>
                        <Text>
                          Group: {groupIdToName.get(r.assignment_group_id) || `Group #${r.assignment_group_id}`}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          {(groupIdToMemberIds.get(r.assignment_group_id) || [])
                            .map((pid) => studentName(pid))
                            .join(", ")}
                        </Text>
                      </>
                    ) : (
                      <>
                        <Text>{studentName(r.student_id) ?? "Missing Student"}</Text>
                        {r.student_id && profileIdToGroupId.get(r.student_id) ? (
                          <Text fontSize="xs" color="fg.muted">
                            {(() => {
                              const gid = profileIdToGroupId.get(r.student_id!);
                              const members = (gid ? groupIdToMemberIds.get(gid) : []) || [];
                              const otherMembers = members.filter((m) => m !== r.student_id);
                              const gname = gid ? groupIdToName.get(gid) : undefined;
                              if (!gid || members.length === 0) return null;
                              return `Group: ${gname || `Group #${gid}`}; Other members: ${otherMembers
                                .map((pid) => studentName(pid))
                                .join(", ")}`;
                            })()}
                          </Text>
                        ) : null}
                      </>
                    )}
                  </VStack>
                </Table.Cell>
                <Table.Cell>{r.hours}</Table.Cell>
                <Table.Cell>{r.minutes || 0}</Table.Cell>
                <Table.Cell>{r.tokens_consumed}</Table.Cell>
                <Table.Cell>{r.creator_id ? <PersonName uid={r.creator_id} /> : ""}</Table.Cell>
                <Table.Cell>{r.note}</Table.Cell>
                <Table.Cell>
                  <TimeZoneAwareDate date={r.created_at} format="compact" />
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
