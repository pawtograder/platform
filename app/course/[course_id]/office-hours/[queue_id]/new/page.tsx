"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { useHelpQueue, useHelpQueueAssignments } from "@/hooks/useOfficeHoursRealtime";
import { Box, Card, Container, Text, Button } from "@chakra-ui/react";

import HelpRequestForm from "./newRequestForm";

export default function NewRequestPage() {
  const { queue_id, course_id } = useParams();
  const router = useRouter();
  const helpQueue = useHelpQueue(Number(queue_id));
  const allHelpQueueAssignments = useHelpQueueAssignments();

  // Check if queue has an active assignment
  const hasActiveAssignment = useMemo(() => {
    if (!allHelpQueueAssignments) return false;
    return allHelpQueueAssignments.some(
      (assignment) => assignment.help_queue_id === Number(queue_id) && assignment.is_active
    );
  }, [allHelpQueueAssignments, queue_id]);

  useEffect(() => {
    if (helpQueue && !hasActiveAssignment) {
      // Redirect back to queue page if queue has no active assignment
      router.replace(`/course/${course_id}/office-hours/${queue_id}`);
    }
  }, [helpQueue, hasActiveAssignment, router, course_id, queue_id]);

  // Show error message if queue has no active assignment
  if (helpQueue && !hasActiveAssignment) {
    return (
      <Container>
        <Box py={8}>
          <Card.Root variant="outline" borderColor="orange.200">
            <Card.Body>
              <Text color="orange.600" fontWeight="semibold" mb={2}>
                Queue Closed for New Requests
              </Text>
              <Text color="fg.muted" mb={4}>
                This queue is currently closed for new requests. You can still view existing requests and queue status.
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
