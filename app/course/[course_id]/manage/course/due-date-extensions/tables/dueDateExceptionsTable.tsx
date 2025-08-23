"use client";

import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import PersonName from "@/components/ui/person-name";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useCourse } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { Assignment, AssignmentDueDateException, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Icon, NativeSelect, Skeleton, Table, Text, VStack } from "@chakra-ui/react";
import { useDelete, useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { FaGift, FaPlus, FaTrash } from "react-icons/fa";
import AddExtensionModal, { AddExtensionDefaults } from "../modals/addExtensionModal";
import GiftTokenModal, { GiftTokenDefaults } from "../modals/giftTokenModal";

/**
 * Renders all due date exceptions for the class, grouped by assignment, with filters
 * and actions to add new exceptions or gift tokens.
 */
export default function DueDateExceptionsTable() {
  const { course_id } = useParams<{ course_id: string }>();
  const course = useCourse();
  const { mutateAsync: deleteException } = useDelete();

  const { data: exceptionsResult, isLoading } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    liveMode: "auto",
    pagination: { pageSize: 1000 },
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id) }],
    sorters: [
      { field: "assignment_id", order: "asc" },
      { field: "created_at", order: "desc" }
    ]
  });
  const { data: assignmentsResult } = useList<Assignment>({
    resource: "assignments",
    pagination: { pageSize: 1000 },
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id) }],
    sorters: [{ field: "due_date", order: "asc" }]
  });
  const students = useAllStudentProfiles();

  const assignmentsById = useMemo(() => {
    const map = new Map<number, Assignment>();
    (assignmentsResult?.data || []).forEach((a) => map.set(a.id, a));
    return map;
  }, [assignmentsResult?.data]);

  // Filters
  const addOpen = useModalManager<AddExtensionDefaults>();
  const giftOpen = useModalManager<GiftTokenDefaults>();
  const assignmentFilter = useModalManager<number | undefined>();
  const studentFilter = useModalManager<string | undefined>();
  const tokenFilter = useModalManager<"any" | "has" | "none">();

  const assignmentOptions = useMemo(
    () => (assignmentsResult?.data || []).map((a) => ({ value: a.id, label: a.title || `Assignment #${a.id}` })),
    [assignmentsResult?.data]
  );
  const studentOptions = useMemo(
    () => (students || []).map((s: UserProfile) => ({ value: s.id, label: s.name || s.id })),
    [students]
  );

  const exceptions = exceptionsResult?.data || [];
  const filtered = exceptions.filter((e) => {
    const aPass = assignmentFilter.modalData ? e.assignment_id === assignmentFilter.modalData : true;
    const sPass = studentFilter.modalData ? e.student_id === studentFilter.modalData : true;
    const tPass =
      tokenFilter.modalData === "has"
        ? e.tokens_consumed > 0
        : tokenFilter.modalData === "none"
          ? e.tokens_consumed === 0
          : true;
    return aPass && sPass && tPass;
  });

  const grouped = useMemo(() => {
    const m = new Map<number, AssignmentDueDateException[]>();
    for (const row of filtered) {
      const arr = m.get(row.assignment_id) || [];
      arr.push(row);
      m.set(row.assignment_id, arr);
    }
    return m;
  }, [filtered]);

  const studentName = (id: string) => students.find((s) => s.id === id)?.name || id;

  if (isLoading) return <Skeleton height="300px" width="100%" />;

  return (
    <VStack align="stretch" gap={4} w="100%">
      <HStack gap={3} justifyContent="space-between" alignItems="center">
        <Heading size="md">Assignment Due Date Exceptions</Heading>
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

      {Array.from(grouped.entries()).map(([assignmentId, rows]) => {
        const assignment = assignmentsById.get(assignmentId);
        return (
          <Box key={assignmentId} borderWidth="1px" borderRadius="md" p={3}>
            <HStack justifyContent="space-between" mb={2}>
              <Heading size="sm">{assignment?.title || `Assignment #${assignmentId}`}</Heading>
              <HStack gap={2}>
                <Button size="sm" onClick={() => addOpen.openModal({ assignmentId })}>
                  <Icon as={FaPlus} /> Add
                </Button>
                <Button size="sm" onClick={() => giftOpen.openModal({ assignmentId })}>
                  <Icon as={FaGift} /> Gift
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
                {rows.map((r) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>{studentName(r.student_id!)}</Table.Cell>
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
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            addOpen.openModal({ assignmentId: r.assignment_id, studentId: r.student_id || undefined })
                          }
                        >
                          <Icon as={FaPlus} />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            giftOpen.openModal({ assignmentId: r.assignment_id, studentId: r.student_id || undefined })
                          }
                        >
                          <Icon as={FaGift} />
                        </Button>
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
                              await deleteException({ id: r.id, resource: "assignment_due_date_exceptions" });
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
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        );
      })}

      <AddExtensionModal isOpen={addOpen.isOpen} onClose={addOpen.closeModal} defaults={addOpen.modalData || {}} />
      <GiftTokenModal isOpen={giftOpen.isOpen} onClose={giftOpen.closeModal} defaults={giftOpen.modalData || {}} />
      <Toaster />
    </VStack>
  );
}
