"use client";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { useIsGrader } from "@/hooks/useClassProfiles";
import useModalManager from "@/hooks/useModalManager";
import { Container, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { useInvalidate } from "@refinedev/core";
import { useParams } from "next/navigation";
import AddConflictDialog from "./addConflictDialog";
import GradingConflictsTable from "./gradingConflictsTable";

export default function GradingConflictsPage() {
  const { course_id } = useParams();
  const invalidate = useInvalidate();
  const isGrader = useIsGrader();

  const {
    isOpen: isAddConflictModalOpen,
    openModal: openAddConflictModal,
    closeModal: closeAddConflictModal
  } = useModalManager<undefined>();

  const handleConflictChange = () => {
    invalidate({ resource: "grading_conflicts", invalidates: ["list"] });
  };

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <HStack justifyContent="space-between" mb={4}>
        <VStack alignItems="flex-start" gap={0}>
          <Heading size="lg">Grading Conflicts</Heading>
          {isGrader && (
            <Text color="fg.muted" fontSize="sm">
              Viewing only your own grading conflicts. Please contact your instructor if you need to discuss other
              grading conflicts.
            </Text>
          )}
        </VStack>
        <Button onClick={() => openAddConflictModal()} colorPalette="green" variant="surface">
          Add Conflict
        </Button>
      </HStack>

      {isAddConflictModalOpen && (
        <AddConflictDialog
          courseId={Number(course_id)}
          onSuccess={() => {
            handleConflictChange();
            closeAddConflictModal();
          }}
          isOpen={isAddConflictModalOpen}
          closeModal={closeAddConflictModal}
        />
      )}

      <GradingConflictsTable courseId={course_id as string} onConflictDeleted={handleConflictChange} />
    </Container>
  );
}
