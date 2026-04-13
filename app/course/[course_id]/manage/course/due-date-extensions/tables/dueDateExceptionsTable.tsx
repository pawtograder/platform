"use client";

import { Button } from "@/components/ui/button";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useAssignments, useCourseController } from "@/hooks/useCourseController";
import { useVirtualizedRowWindow } from "@/hooks/useVirtualizedRowWindow";
import useModalManager from "@/hooks/useModalManager";
import { useIsTableControllerReady, useListTableControllerValues } from "@/lib/TableController";
import { AssignmentDueDateException, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Icon, NativeSelect, Table, Text, VStack } from "@chakra-ui/react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { useMemo } from "react";
import { FaGift, FaPlus, FaTrash } from "react-icons/fa";
import AddExceptionModal, { AddExtensionDefaults } from "../modals/addExceptionModal";
import GiftTokenModal, { GiftTokenDefaults } from "../modals/giftTokenModal";

type DueDateExceptionRow = {
  exception: AssignmentDueDateException;
  assignmentName: string;
  assigneeLabel: string;
  assigneeDetails: string;
};

/**
 * Renders all due date exceptions for the class in one virtualized table.
 */
export default function DueDateExceptionsTable() {
  const unsortedAssignments = useAssignments() ?? [];
  const students = useAllStudentProfiles();
  const { assignmentDueDateExceptions, assignmentGroupsWithMembers } = useCourseController();
  const dueDateExceptions = useListTableControllerValues(assignmentDueDateExceptions, () => true);
  const assignmentGroups = useListTableControllerValues(assignmentGroupsWithMembers, () => true);
  const isReady = useIsTableControllerReady(assignmentDueDateExceptions);

  const addOpen = useModalManager<AddExtensionDefaults>();
  const giftOpen = useModalManager<GiftTokenDefaults>();
  const assignmentFilter = useModalManager<number | undefined>();
  const studentFilter = useModalManager<string | undefined>();
  const tokenFilter = useModalManager<"any" | "has" | "none">();

  const assignments = useMemo(
    () =>
      [...unsortedAssignments].sort((a, b) => {
        const aDate = new Date(a.due_date);
        const bDate = new Date(b.due_date);
        return aDate.getTime() - bDate.getTime();
      }),
    [unsortedAssignments]
  );
  const assignmentMap = useMemo(
    () => new Map(assignments.map((assignment) => [assignment.id, assignment])),
    [assignments]
  );
  const studentMap = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const assignmentGroupMap = useMemo(
    () => new Map(assignmentGroups.map((assignmentGroup) => [assignmentGroup.id, assignmentGroup])),
    [assignmentGroups]
  );

  const rows = useMemo<DueDateExceptionRow[]>(
    () =>
      dueDateExceptions.map((exception) => {
        const assignment = assignmentMap.get(exception.assignment_id);
        const assignmentName = assignment?.title || `Assignment #${exception.assignment_id}`;

        if (exception.assignment_group_id) {
          const assignmentGroup = assignmentGroupMap.get(exception.assignment_group_id);
          const assigneeLabel = assignmentGroup?.name || `Group #${exception.assignment_group_id}`;
          const assigneeDetails =
            assignmentGroup?.assignment_groups_members
              .map((groupMember) => studentMap.get(groupMember.profile_id)?.name || groupMember.profile_id)
              .join(", ") || "Unknown group members";
          return {
            exception,
            assignmentName,
            assigneeLabel: `Group: ${assigneeLabel}`,
            assigneeDetails
          };
        }

        const studentName =
          studentMap.get(exception.student_id || "")?.name || exception.student_id || "Unknown student";
        return {
          exception,
          assignmentName,
          assigneeLabel: studentName,
          assigneeDetails: "Individual exception"
        };
      }),
    [assignmentGroupMap, assignmentMap, dueDateExceptions, studentMap]
  );

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (assignmentFilter.modalData && row.exception.assignment_id !== assignmentFilter.modalData) {
          return false;
        }
        if (studentFilter.modalData) {
          const matchesStudentDirectly = row.exception.student_id === studentFilter.modalData;
          const matchesStudentViaGroup =
            row.exception.assignment_group_id != null &&
            assignmentGroupMap
              .get(row.exception.assignment_group_id)
              ?.assignment_groups_members.some((groupMember) => groupMember.profile_id === studentFilter.modalData);
          if (!matchesStudentDirectly && !matchesStudentViaGroup) {
            return false;
          }
        }
        if (tokenFilter.modalData === "has" && row.exception.tokens_consumed <= 0) {
          return false;
        }
        if (tokenFilter.modalData === "none" && row.exception.tokens_consumed > 0) {
          return false;
        }
        return true;
      }),
    [assignmentFilter.modalData, assignmentGroupMap, rows, studentFilter.modalData, tokenFilter.modalData]
  );

  const columns = useMemo<ColumnDef<DueDateExceptionRow>[]>(
    () => [
      {
        id: "assignment",
        accessorFn: (row) => row.assignmentName,
        header: "Assignment",
        cell: ({ row }) => row.original.assignmentName
      },
      {
        id: "assignee",
        accessorFn: (row) => row.assigneeLabel,
        header: "Student / Group",
        cell: ({ row }) => (
          <VStack align="start" gap={0}>
            <Text>{row.original.assigneeLabel}</Text>
            <Text fontSize="xs" color="fg.muted">
              {row.original.assigneeDetails}
            </Text>
          </VStack>
        )
      },
      {
        id: "hours",
        accessorFn: (row) => row.exception.hours,
        header: "Hours",
        cell: ({ row }) => row.original.exception.hours
      },
      {
        id: "minutes",
        accessorFn: (row) => row.exception.minutes,
        header: "Minutes",
        cell: ({ row }) => row.original.exception.minutes
      },
      {
        id: "tokens",
        accessorFn: (row) => row.exception.tokens_consumed,
        header: "Tokens",
        cell: ({ row }) => row.original.exception.tokens_consumed
      },
      {
        id: "creator",
        accessorFn: (row) => row.exception.creator_id,
        header: "Grantor",
        cell: ({ row }) => <PersonName uid={row.original.exception.creator_id} showAvatar={false} />
      },
      {
        id: "note",
        accessorFn: (row) => row.exception.note || "",
        header: "Note",
        cell: ({ row }) => row.original.exception.note || ""
      },
      {
        id: "created_at",
        accessorFn: (row) => row.exception.created_at,
        header: "Date",
        cell: ({ row }) => <TimeZoneAwareDate date={row.original.exception.created_at} format="compact" />
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => (
          <PopConfirm
            triggerLabel="Delete exception"
            trigger={
              <Button size="xs" variant="ghost" colorPalette="red">
                <Icon as={FaTrash} />
              </Button>
            }
            confirmHeader="Delete exception"
            confirmText="Are you sure you want to delete this exception?"
            onConfirm={async () => {
              try {
                await assignmentDueDateExceptions.hardDelete(row.original.exception.id);
              } catch (error) {
                toaster.error({
                  title: "Delete failed",
                  description: error instanceof Error ? error.message : "Unknown error"
                });
              }
            }}
          />
        )
      }
    ],
    [assignmentDueDateExceptions, timeFormatter]
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const tableRows = table.getRowModel().rows;
  const rowWindow = useVirtualizedRowWindow(tableRows, {
    estimatedRowHeight: 72,
    minRowsForVirtualization: 80
  });

  const assignmentOptions = useMemo(
    () => assignments.map((a) => ({ value: a.id, label: a.title || `Assignment #${a.id}` })),
    [assignments]
  );
  const studentOptions = useMemo(
    () => (students || []).map((s: UserProfile) => ({ value: s.id, label: s.name || s.id })),
    [students]
  );

  return (
    <VStack align="stretch" gap={4} w="100%">
      <HStack gap={3} justifyContent="space-between" alignItems="center">
        <VStack align="flex-start">
          <Heading size="md">Assignment Due Date Exceptions</Heading>
        </VStack>
        <HStack gap={2}>
          <Button onClick={() => addOpen.openModal({})}>
            <Icon as={FaPlus} /> Add Exception
          </Button>
          <Button onClick={() => giftOpen.openModal({})}>
            <Icon as={FaGift} /> Gift Tokens
          </Button>
        </HStack>
      </HStack>

      <HStack gap={3} flexWrap="wrap">
        <Box minW="260px">
          <Text fontSize="sm" color="fg.muted">
            Filter by assignment
          </Text>
          <Select
            options={assignmentOptions}
            value={assignmentOptions.find((o) => o.value === assignmentFilter.modalData) || null}
            onChange={(opt) => assignmentFilter.openModal((opt as { value: number } | null)?.value)}
            placeholder="All assignments"
            isClearable
          />
        </Box>
        <Box minW="260px">
          <Text fontSize="sm" color="fg.muted">
            Filter by student
          </Text>
          <Select
            options={studentOptions}
            value={studentOptions.find((o) => o.value === studentFilter.modalData) || null}
            onChange={(opt) => studentFilter.openModal((opt as { value: string } | null)?.value)}
            placeholder="All students"
            isClearable
          />
        </Box>
        <Box minW="200px">
          <Text fontSize="sm" color="fg.muted">
            Tokens
          </Text>
          <NativeSelect.Root>
            <NativeSelect.Field
              value={tokenFilter.modalData || "any"}
              onChange={(e) => tokenFilter.openModal((e.target.value as "any" | "has" | "none") || "any")}
            >
              <option value="any">Any</option>
              <option value="has">Has tokens</option>
              <option value="none">No tokens</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
        </Box>
      </HStack>

      <Box
        ref={rowWindow.containerRef}
        onScroll={rowWindow.onScroll}
        overflowY="auto"
        maxH="70vh"
        borderWidth="1px"
        borderRadius="md"
      >
        <Table.Root size="sm">
          <Table.Header>
            {table.getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id} bg="bg.subtle">
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader key={header.id}>
                    {header.isPlaceholder ? null : (
                      <Text
                        cursor={header.column.getCanSort() ? "pointer" : "default"}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </Text>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {!isReady ? (
              <Table.Row>
                <Table.Cell colSpan={columns.length}>Loading exceptions...</Table.Cell>
              </Table.Row>
            ) : tableRows.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={columns.length}>No matching due date exceptions.</Table.Cell>
              </Table.Row>
            ) : (
              <>
                {rowWindow.shouldVirtualize && rowWindow.paddingTop > 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={columns.length} p={0} border="none" h={`${rowWindow.paddingTop}px`} />
                  </Table.Row>
                ) : null}
                {rowWindow.visibleRows.map((row) => (
                  <Table.Row key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                    ))}
                  </Table.Row>
                ))}
                {rowWindow.shouldVirtualize && rowWindow.paddingBottom > 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={columns.length} p={0} border="none" h={`${rowWindow.paddingBottom}px`} />
                  </Table.Row>
                ) : null}
              </>
            )}
          </Table.Body>
        </Table.Root>
      </Box>

      <AddExceptionModal isOpen={addOpen.isOpen} onClose={addOpen.closeModal} defaults={addOpen.modalData || {}} />
      <GiftTokenModal isOpen={giftOpen.isOpen} onClose={giftOpen.closeModal} defaults={giftOpen.modalData || {}} />
      <Toaster />
    </VStack>
  );
}
