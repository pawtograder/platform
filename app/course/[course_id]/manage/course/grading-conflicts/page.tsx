"use client";

import { Heading, Container, HStack } from "@chakra-ui/react";
import { useInvalidate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AddConflictDialog from "./addConflictDialog";
import GradingConflictsTable from "./gradingConflictsTable";

export default function GradingConflictsPage() {
  const { course_id } = useParams();
  const invalidate = useInvalidate();

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
        <Heading size="lg">Grading Conflicts</Heading>
        <Button onClick={() => openAddConflictModal()}>Add Conflict</Button>
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
