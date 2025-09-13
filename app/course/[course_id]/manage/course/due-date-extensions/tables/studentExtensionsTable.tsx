"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useStudentDeadlineExtensions } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { createClient } from "@/utils/supabase/client";
import { StudentDeadlineExtension } from "@/utils/supabase/DatabaseTypes";
import { Checkbox, Dialog, Heading, HStack, Icon, Input, Portal, Table, Text, VStack } from "@chakra-ui/react";

import { FaEdit, FaPlus, FaTrash } from "react-icons/fa";
import AddExtensionModal, { AddExtensionDefaults } from "../modals/addExtensionModal";

/**
 * Table of student-wide extensions (applies to all assignments), with dialog to add/edit/delete.
 */
export default function StudentExtensionsTable() {
  const extensions = useStudentDeadlineExtensions();
  const students = useAllStudentProfiles();
  const supabase = createClient();

  const createOpen = useModalManager<AddExtensionDefaults>();
  const editOpen = useModalManager<StudentDeadlineExtension>();

  const studentName = (id: string) => students.find((s) => s.id === id)?.name || id;

  const handleUpdate = async (row: StudentDeadlineExtension, updates: { hours?: number; includes_lab?: boolean }) => {
    try {
      const { error } = await supabase
        .from("student_deadline_extensions")
        .update({ hours: updates.hours ?? row.hours, includes_lab: updates.includes_lab ?? row.includes_lab })
        .eq("id", row.id);
      if (error) throw error;
      toaster.create({
        title: "Extension updated",
        description: "Note: updates do not retroactively modify existing exceptions.",
        type: "info"
      });
      editOpen.closeModal();
    } catch (err) {
      toaster.error({ title: "Update failed", description: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  const handleDelete = async (row: StudentDeadlineExtension) => {
    try {
      const { error } = await supabase.from("student_deadline_extensions").delete().eq("id", row.id);
      if (error) throw error;
      toaster.create({
        title: "Extension deleted",
        description: "Note: deletions do not retroactively modify existing exceptions.",
        type: "info"
      });
    } catch (err) {
      toaster.error({ title: "Delete failed", description: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  return (
    <VStack gap={4} align="stretch" w="100%">
      <HStack justifyContent="space-between">
        <Heading size="md">Student-Wide Extensions</Heading>
        <Button onClick={() => createOpen.openModal({ hours: 24, includes_lab: false })}>
          <Icon as={FaPlus} /> Add Extension
        </Button>
      </HStack>

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Hours</Table.ColumnHeader>
            <Table.ColumnHeader>Includes Labs</Table.ColumnHeader>
            <Table.ColumnHeader>Created</Table.ColumnHeader>
            <Table.ColumnHeader>Updated</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(extensions || []).map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>{studentName(row.student_id)}</Table.Cell>
              <Table.Cell>{row.hours}</Table.Cell>
              <Table.Cell>{row.includes_lab ? "Yes" : "No"}</Table.Cell>
              <Table.Cell>{new Date(row.created_at).toLocaleString()}</Table.Cell>
              <Table.Cell>{new Date(row.updated_at).toLocaleString()}</Table.Cell>
              <Table.Cell>
                <HStack gap={2}>
                  <Button size="xs" variant="ghost" onClick={() => editOpen.openModal(row)}>
                    <Icon as={FaEdit} />
                  </Button>
                  <PopConfirm
                    triggerLabel="Delete"
                    trigger={
                      <Button size="xs" variant="ghost" colorPalette="red">
                        <Icon as={FaTrash} />
                      </Button>
                    }
                    confirmHeader="Delete extension"
                    confirmText="Are you sure you want to delete this student-wide extension?"
                    onConfirm={() => handleDelete(row)}
                  />
                </HStack>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

      <AddExtensionModal
        isOpen={createOpen.isOpen}
        onClose={createOpen.closeModal}
        defaults={createOpen.modalData || {}}
      />

      {/* Edit dialog */}
      {editOpen.modalData && (
        <Dialog.Root open={editOpen.isOpen} onOpenChange={(d) => !d.open && editOpen.closeModal()}>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Edit Student-Wide Extension</Dialog.Title>
                  <Dialog.CloseTrigger onClick={editOpen.closeModal} />
                </Dialog.Header>
                <Dialog.Body>
                  <VStack gap={4} align="stretch">
                    <Text>
                      <strong>Student:</strong> {studentName(editOpen.modalData.student_id)}
                    </Text>
                    <Field label="Hours" required>
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={editOpen.modalData.hours}
                        onChange={(e) =>
                          editOpen.openModal({ ...editOpen.modalData!, hours: parseInt(e.target.value || "0", 10) })
                        }
                      />
                    </Field>
                    <HStack>
                      <Checkbox.Root
                        checked={!!editOpen.modalData.includes_lab}
                        onCheckedChange={(c) =>
                          editOpen.openModal({ ...editOpen.modalData!, includes_lab: c.checked.valueOf() === true })
                        }
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                        <Text ml={2}>Include lab assignments</Text>
                      </Checkbox.Root>
                    </HStack>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack gap={3} justifyContent="flex-end">
                    <Button variant="outline" colorPalette="red" onClick={editOpen.closeModal}>
                      Cancel
                    </Button>
                    <Button
                      colorPalette="green"
                      onClick={() =>
                        handleUpdate(editOpen.modalData!, {
                          hours: editOpen.modalData!.hours,
                          includes_lab: editOpen.modalData!.includes_lab
                        })
                      }
                    >
                      Save
                    </Button>
                  </HStack>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}

      <Toaster />
    </VStack>
  );
}
