"use client";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useAssignments } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Icon, NativeSelect, Text, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useMemo } from "react";
import { FaGift, FaPlus } from "react-icons/fa";
import AddExceptionModal, { AddExtensionDefaults } from "../modals/addExceptionModal";
import GiftTokenModal, { GiftTokenDefaults } from "../modals/giftTokenModal";
import AssignmentExceptionsTable from "./assignmentExceptionsTable";

/**
 * Renders all due date exceptions for the class, grouped by assignment, with filters
 * and actions to add new exceptions or gift tokens.
 */
export default function DueDateExceptionsTable() {
  const unsortedAssignments = useAssignments();
  const students = useAllStudentProfiles();

  // Filters
  const addOpen = useModalManager<AddExtensionDefaults>();
  const giftOpen = useModalManager<GiftTokenDefaults>();
  const assignmentFilter = useModalManager<number | undefined>();
  const studentFilter = useModalManager<string | undefined>();
  const tokenFilter = useModalManager<"any" | "has" | "none">();
  const assignments = useMemo(
    () =>
      unsortedAssignments?.sort((a, b) => {
        const aDate = new Date(a.due_date);
        const bDate = new Date(b.due_date);
        return aDate.getTime() - bDate.getTime();
      }),
    [unsortedAssignments]
  );

  const assignmentOptions = useMemo(
    () => (assignments || []).map((a) => ({ value: a.id, label: a.title || `Assignment #${a.id}` })),
    [assignments]
  );
  const studentOptions = useMemo(
    () => (students || []).map((s: UserProfile) => ({ value: s.id, label: s.name || s.id })),
    [students]
  );

  console.log("assignments", assignments);

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

      {(assignments || []).map((assignment) => (
        <AssignmentExceptionsTable
          key={assignment.id}
          assignment={assignment}
          assignmentFilter={assignmentFilter.modalData}
          studentFilter={studentFilter.modalData}
          tokenFilter={tokenFilter.modalData}
        />
      ))}

      <AddExceptionModal isOpen={addOpen.isOpen} onClose={addOpen.closeModal} defaults={addOpen.modalData || {}} />
      <GiftTokenModal isOpen={giftOpen.isOpen} onClose={giftOpen.closeModal} defaults={giftOpen.modalData || {}} />
      <Toaster />
    </VStack>
  );
}
