"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
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

  // Set while the form is submitting/navigating to its newly created request, so the
  // redirect below stands down and can't race (and swallow) the form's router.push.
  const isSubmittingRef = useRef(false);
  const handleSubmittingChange = useCallback((submitting: boolean) => {
    isSubmittingRef.current = submitting;
  }, []);

  useEffect(() => {
    // Don't redirect while a submission is in flight — the form navigates to the new
    // request itself, and a competing router.replace here gets swallowed under load,
    // stranding the student on a URL without the request id.
    if (isSubmittingRef.current) return;
    // Don't act on indeterminate state: activeHelpQueueAssignments is undefined until the
    // realtime data loads (and can blip undefined on re-subscribe), which would briefly make
    // the queue look closed and fire a spurious redirect.
    if (activeHelpQueueAssignments === undefined) return;
    if (helpQueue && !isQueueOpen) {
      // Redirect back to queue page if queue is not open for new requests
      router.replace(`/course/${course_id}/office-hours/${queue_id}`);
    }
  }, [helpQueue, isQueueOpen, activeHelpQueueAssignments, router, course_id, queue_id]);

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

  return <HelpRequestForm onSubmittingChange={handleSubmittingChange} />;
}
