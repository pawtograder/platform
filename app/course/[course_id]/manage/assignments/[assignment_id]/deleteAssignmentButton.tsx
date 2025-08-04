"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { assignmentDelete, EdgeFunctionError } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Dialog, HStack, Icon, Portal, Text, VStack } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FaTrash } from "react-icons/fa";

interface DeleteAssignmentButtonProps {
  assignmentId: number;
  courseId: number;
}

export default function DeleteAssignmentButton({ assignmentId, courseId }: DeleteAssignmentButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleDeleteAssignment = async () => {
    try {
      setIsLoading(true);

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
        type: "success"
      });

      // Redirect to assignments list
      router.push(`/course/${courseId}/manage/assignments`);
    } catch (error) {
      console.error("Error deleting assignment:", error);

      if (error instanceof EdgeFunctionError) {
        toaster.create({
          title: "Delete Failed",
          description: error.details,
          type: "error"
        });
      } else {
        toaster.create({
          title: "Delete Failed",
          description: "An unexpected error occurred while deleting the assignment.",
          type: "error"
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
                    <Box as="li">• All student repositories from GitHub</Box>
                    <Box as="li">• Handout repository (template) from GitHub</Box>
                    <Box as="li">• Solution repository (grader) from GitHub</Box>
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
                    This action is not undoable, and will delete content from GitHub!
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
                    onCancel={() => {}}
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
