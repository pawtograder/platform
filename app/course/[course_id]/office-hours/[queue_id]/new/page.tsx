"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  // Latch the "open" signal: once we've ever observed the queue as open in
  // this session, keep treating it as open even if the realtime channel
  // briefly drops the active-assignment row (re-subscribe / cache invalidate
  // can flap it false→true→false within a single render cycle). Unlatching
  // requires a fresh page mount.
  //
  // Without this, an in-flight click on Submit Request gets stranded:
  //   1. button is enabled, user clicks
  //   2. React queues the synthetic submit event for our onSubmit
  //   3. a realtime tick momentarily empties activeHelpQueueAssignments
  //   4. isQueueOpen flips false, parent re-renders, the early-return
  //      branch below unmounts <HelpRequestForm>
  //   5. React tries to dispatch the queued submit to a now-unmounted
  //      component; onSubmit never runs, no row is created, no toast
  //
  // Tracked down via the office-hours E2E CI flake on PR 785 — the
  // failing attempts showed ZERO OH-DEBUG events from inside onSubmit
  // despite Playwright's click() returning success.
  const [hasEverBeenOpen, setHasEverBeenOpen] = useState(false);
  useEffect(() => {
    if (isQueueOpen) setHasEverBeenOpen(true);
  }, [isQueueOpen]);
  const treatAsOpen = isQueueOpen || hasEverBeenOpen;

  // Track whether the form is mid-submit. Use both a ref (so the
  // useEffect below can read it without rerunning on every toggle) and
  // useState (so the render-time guard below actually picks up the flip
  // — refs don't trigger renders). The form calls onSubmittingChange
  // before any await in its handler, so by the time anything downstream
  // observes !treatAsOpen we already know the form is committed.
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handleSubmittingChange = useCallback((submitting: boolean) => {
    isSubmittingRef.current = submitting;
    setIsSubmitting(submitting);
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
    // Once we've observed the queue as open we don't redirect away from
    // /new even if realtime briefly says otherwise — see the
    // hasEverBeenOpen latch comment above.
    if (helpQueue && !treatAsOpen) {
      // Redirect back to queue page if queue is not open for new requests
      router.replace(`/course/${course_id}/office-hours/${queue_id}`);
    }
  }, [helpQueue, treatAsOpen, activeHelpQueueAssignments, router, course_id, queue_id]);

  // Show error message if queue is not open for new requests. Gate with
  // the same guards as the useEffect so a transient realtime blip can't
  // unmount the form mid-submit (see hasEverBeenOpen comment).
  if (helpQueue && !treatAsOpen && !isSubmitting && activeHelpQueueAssignments !== undefined) {
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
