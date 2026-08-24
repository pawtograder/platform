"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { assignmentDelete, EdgeFunctionError } from "@/lib/edgeFunctions";
import { useRevalidateServerCaches } from "@/hooks/useRevalidateServerCaches";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Dialog, HStack, Icon, Portal, Text, VStack } from "@chakra-ui/react";
import { useState } from "react";
import { FaTrash } from "react-icons/fa";

interface DeleteAssignmentButtonProps {
  assignmentId: number;
  courseId: number;
}

export default function DeleteAssignmentButton({ assignmentId, courseId }: DeleteAssignmentButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const revalidateServerCaches = useRevalidateServerCaches(courseId);

  const handleDeleteAssignment = async () => {
    try {
      setIsLoading(true);
      const supabase = createClient();
      const result = await assignmentDelete(
        {
          assignment_id: assignmentId,
          class_id: courseId
        },
        supabase
      );

      toaster.create({
        title: "Assignment Deleted",
        description: result.message,
        type: "success",
        duration: 10000
      });

      // Navigate through the hook so the browser's copy of the assignments list is dropped.
      // Without it the deleted assignment stays listed for up to `staleTimes.dynamic` (30s),
      // and clicking it bounces the user straight back out (#937).
      await revalidateServerCaches({
        tables: ["assignments"],
        navigateTo: `/course/${courseId}/manage/assignments`
      });
    } catch (error) {
      console.error("Error deleting assignment:", error);

      if (error instanceof EdgeFunctionError) {
        toaster.create({
          title: "Delete Failed",
          description: error.details,
          type: "error",
          duration: 10000
        });
      } else {
        toaster.create({
          title: "Delete Failed",
          description: "An unexpected error occurred while deleting the assignment.",
          type: "error",
          duration: 10000
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Button
        w="100%"
        colorPalette="red"
        variant="ghost"
        onClick={() => setIsDialogOpen(true)}
        size="xs"
        fontSize="sm"
        justifyContent="flex-start"
      >
        <Icon as={FaTrash} />
        Delete Assignment
      </Button>

      <Dialog.Root open={isDialogOpen} onOpenChange={(details) => !details.open && setIsDialogOpen(false)}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Delete Assignment</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="flex-start" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    Permanently delete this assignment and all associated data. This action cannot be undone.
                  </Text>
                  <Text fontSize="sm" color="fg.muted">
                    <strong>Before deletion, the system will check:</strong>
                  </Text>
                  <Box as="ul" fontSize="sm" color="fg.muted" ml={4}>
                    <Box as="li">• If any student repository has a commit beyond the initial commit</Box>
                    <Box as="li">• If there are any released submission reviews (if yes, deletion fails)</Box>
                  </Box>
                  <Text fontSize="sm" color="fg.muted">
                    <strong>If checks pass, ALL related data will be permanently deleted:</strong>
                  </Text>
                  <Box as="ul" fontSize="sm" color="fg.muted" ml={4}>
                    <Box as="li">
                      • GitHub repositories: small batches are deleted immediately; larger batches are queued for
                      background archival and locking
                    </Box>
                    <Box as="li">• Handout repository (template) GitHub cleanup</Box>
                    <Box as="li">• Solution repository (grader) GitHub cleanup</Box>
                    <Box as="li">• All submissions and grading results</Box>
                    <Box as="li">• All assignment groups, invitations, and join requests</Box>
                    <Box as="li">• All due date exceptions and late tokens</Box>
                    <Box as="li">• All review assignments and submission reviews</Box>
                    <Box as="li">• All gradebook columns and their dependencies</Box>
                    <Box as="li">• All autograder configurations</Box>
                    <Box as="li">• The assignment itself</Box>
                  </Box>
                  <Box
                    border="2px solid"
                    borderColor="border.error"
                    borderRadius="md"
                    p={4}
                    fontSize="lg"
                    fontWeight="bold"
                  >
                    This action is not undoable. Assignment data is deleted permanently, and associated GitHub
                    repositories are either deleted immediately or archived in the background.
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack gap={3} justify="flex-end">
                  <Button variant="outline" colorPalette="gray" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <PopConfirm
                    triggerLabel="Delete Assignment"
                    trigger={
                      <Button colorPalette="red" variant="solid" loading={isLoading} size="sm">
                        Delete Assignment
                      </Button>
                    }
                    confirmHeader="Final Confirmation"
                    confirmText="This action is not undoable, even by the Pawtograder team. Are you sure you want to proceed with deleting this assignment?"
                    onConfirm={async () => {
                      setIsLoading(true);
                      try {
                        await handleDeleteAssignment();
                        setIsDialogOpen(false);
                      } catch {
                        // Error is already handled in handleDeleteAssignment
                      } finally {
                        setIsLoading(false);
                      }
                    }}
                  />
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
