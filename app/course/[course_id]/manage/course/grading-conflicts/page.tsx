"use client";

import { useMemo } from "react";
import { Heading, IconButton, Container, HStack, Table } from "@chakra-ui/react";
import { useList, useDelete } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaTrash } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import PersonName from "@/components/ui/person-name";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster, Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AddConflictDialog from "./addConflictDialog";

type GradingConflict = Database["public"]["Tables"]["grading_conflicts"]["Row"];

type GradingConflictWithPopulatedProfiles = GradingConflict & {
  grader_profile?: { id: string; name: string };
  student_profile?: { id: string; name: string };
  created_by_profile?: { id: string; name: string };
};

type GradingConflictWithResolvedNames = GradingConflict & {
  grader_name: string;
  student_name: string;
  created_by_name: string;
};

export default function GradingConflictsPage() {
  const { course_id } = useParams();
  const {
    data: conflictsData,
    isLoading: isLoadingConflicts,
    refetch
  } = useList<GradingConflictWithPopulatedProfiles>({
    resource: "grading_conflicts",
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id) }],
    sorters: [{ field: "created_at", order: "desc" }],
    meta: {
      select:
        "*, grader_profile:profiles!grading_conflicts_grader_profile_id_fkey(id, name), student_profile:profiles!grading_conflicts_student_profile_id_fkey(id, name), created_by_profile:profiles!grading_conflicts_created_by_profile_id_fkey(id, name)"
    }
  });

  const { mutate: deleteConflict } = useDelete();

  const {
    isOpen: isAddConflictModalOpen,
    openModal: openAddConflictModal,
    closeModal: closeAddConflictModal
  } = useModalManager<undefined>();

  const conflicts: GradingConflictWithResolvedNames[] = useMemo(() => {
    return (
      conflictsData?.data?.map((conflict) => {
        return {
          ...conflict,
          grader_name: conflict.grader_profile?.name || conflict.grader_profile_id,
          student_name: conflict.student_profile?.name || conflict.student_profile_id,
          created_by_name: conflict.created_by_profile?.name || conflict.created_by_profile_id
        };
      }) || []
    );
  }, [conflictsData]);

  const handleDelete = (id: number) => {
    deleteConflict(
      {
        resource: "grading_conflicts",
        id: id
      },
      {
        onSuccess: () => {
          toaster.success({ title: "Conflict deleted successfully" });
          refetch();
        },
        onError: (error) => {
          toaster.error({ title: "Error deleting conflict", description: error.message });
        }
      }
    );
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
            refetch();
            closeAddConflictModal();
          }}
          isOpen={isAddConflictModalOpen}
          closeModal={closeAddConflictModal}
        />
      )}

      {isLoadingConflicts && <p>Loading conflicts...</p>}
      {!isLoadingConflicts && conflicts.length === 0 && <p>No grading conflicts found for this course.</p>}

      {!isLoadingConflicts && conflicts.length > 0 && (
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Grader</Table.ColumnHeader>
              <Table.ColumnHeader>Student</Table.ColumnHeader>
              <Table.ColumnHeader>Reason</Table.ColumnHeader>
              <Table.ColumnHeader>Created By</Table.ColumnHeader>
              <Table.ColumnHeader>Created At</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {conflicts.map((conflict) => (
              <Table.Row key={conflict.id}>
                <Table.Cell>
                  <PersonName uid={conflict.grader_profile_id} />
                </Table.Cell>
                <Table.Cell>
                  <PersonName uid={conflict.student_profile_id} />
                </Table.Cell>
                <Table.Cell>{conflict.reason || "-"}</Table.Cell>
                <Table.Cell>
                  <PersonName uid={conflict.created_by_profile_id} />
                </Table.Cell>
                <Table.Cell>{new Date(conflict.created_at).toLocaleString()}</Table.Cell>
                <Table.Cell textAlign="center">
                  <PopConfirm
                    triggerLabel="Delete"
                    confirmHeader="Delete Grading Conflict"
                    confirmText="Are you sure you want to delete this grading conflict?"
                    onConfirm={() => handleDelete(conflict.id)}
                    onCancel={() => {}}
                    trigger={
                      <IconButton aria-label="Delete conflict" colorPalette="red" variant="ghost" size="sm">
                        <FaTrash />
                      </IconButton>
                    }
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Container>
  );
}
