"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { useHelpQueue, useActiveHelpQueueAssignments } from "@/hooks/useOfficeHoursRealtime";
import { Box, Card, Container, Text, Button } from "@chakra-ui/react";

import HelpRequestForm from "./newRequestForm";

export default function NewRequestPage() {
  const { queue_id, course_id } = useParams();
  const router = useRouter();
  const helpQueue = useHelpQueue(Number(queue_id));
  // Use the specialized hook that subscribes to individual item changes
  const activeHelpQueueAssignments = useActiveHelpQueueAssignments();

  // Check if queue has an active assignment (staff is working)
  const hasActiveAssignment = useMemo(() => {
    if (!activeHelpQueueAssignments) return false;
    // Demo queues don't require active staff
    if (helpQueue?.is_demo) return true;
    return activeHelpQueueAssignments.some((assignment) => assignment.help_queue_id === Number(queue_id));
  }, [activeHelpQueueAssignments, queue_id, helpQueue?.is_demo]);

  // Check if queue is available for new requests (both available flag AND has active staff, unless demo)
  const isQueueOpen = helpQueue?.is_demo || (helpQueue?.available && hasActiveAssignment);

  useEffect(() => {
    if (helpQueue && !isQueueOpen) {
      // Redirect back to queue page if queue is not open for new requests
      router.replace(`/course/${course_id}/office-hours/${queue_id}`);
    }
  }, [helpQueue, isQueueOpen, router, course_id, queue_id]);

  // Show error message if queue is not open for new requests
  if (helpQueue && !isQueueOpen) {
    const reason = !helpQueue.available
      ? "This queue is not currently accepting new requests."
      : "This queue is not currently staffed.";

    return (
      <Container>
        <Box py={8}>
          <Card.Root variant="outline" borderColor="orange.200">
            <Card.Body>
              <Text color="orange.600" fontWeight="semibold" mb={2}>
                Queue Closed for New Requests
              </Text>
              <Text color="fg.muted" mb={4}>
                {reason} You can still view existing requests and queue status.
              </Text>
              <Button onClick={() => router.push(`/course/${course_id}/office-hours/${queue_id}`)} variant="outline">
                Back to Queue
              </Button>
            </Card.Body>
          </Card.Root>
        </Box>
      </Container>
    );
  }

  return <HelpRequestForm />;
}
