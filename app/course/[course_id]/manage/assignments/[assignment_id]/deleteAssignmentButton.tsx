"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { assignmentDelete, EdgeFunctionError } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Card, Heading, Text, VStack } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface DeleteAssignmentButtonProps {
  assignment: Assignment;
  courseId: number;
}

export default function DeleteAssignmentButton({ assignment, courseId }: DeleteAssignmentButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleDeleteAssignment = async () => {
    try {
      setIsLoading(true);

      const result = await assignmentDelete(
        {
          assignment_id: assignment.id,
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
          description: error.message,
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
    <Box mt={8}>
      <Card.Root bg="bg.error" borderColor="border.error" borderWidth="1px">
        <Card.Header>
          <Heading size="md" color="fg.error">
            Danger Zone
          </Heading>
        </Card.Header>
        <Card.Body>
          <VStack align="flex-start" gap={3}>
            <Text color="fg.error" fontWeight="medium">
              Delete Assignment
            </Text>
            <Text fontSize="sm" color="fg.muted">
              Permanently delete this assignment and all associated data. This action cannot be undone.
            </Text>
            <Text fontSize="sm" color="fg.muted">
              <strong>Before deletion, the system will check:</strong>
            </Text>
            <Box as="ul" fontSize="sm" color="fg.muted" ml={4}>
              <Box as="li">• If any generated repositories still match the template (if different, deletion fails)</Box>
              <Box as="li">• If there are any released submission reviews (if yes, deletion fails)</Box>
              <Box as="li">• Missing repositories are not considered an error</Box>
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

            <PopConfirm
              triggerLabel="Delete Assignment"
              trigger={
                <Button colorPalette="red" variant="solid" loading={isLoading} size="sm">
                  Delete Assignment
                </Button>
              }
              confirmHeader="Delete Assignment"
              confirmText={`Are you sure you want to delete "${assignment.title}"? This will permanently delete the assignment and all associated data including submissions, reviews, groups, and repositories. This action cannot be undone.`}
              onConfirm={handleDeleteAssignment}
              onCancel={() => {}}
            />
          </VStack>
        </Card.Body>
      </Card.Root>
    </Box>
  );
}
