"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHelpQueue } from "@/hooks/useOfficeHoursRealtime";
import { Box, Card, Container, Text, Button } from "@chakra-ui/react";

import HelpRequestForm from "./newRequestForm";

export default function NewRequestPage() {
  const { queue_id, course_id } = useParams();
  const router = useRouter();
  const helpQueue = useHelpQueue(Number(queue_id));

  // The queue is "accepting new requests" iff the DB column says so (or
  // it's a demo queue). We intentionally do NOT factor in active-staff
  // here — that's a realtime-derived signal that flaps under load, and
  // if we unmount the form based on it we strand in-flight click events
  // (React can't dispatch a synthetic submit to a component that's no
  // longer mounted). Tracked down via the office-hours CI flake on PR
  // 785: failing attempts showed ZERO console.log events from inside
  // the form's onSubmit despite Playwright's click() returning success.
  // The form itself enforces the "active staff" guard via the submit
  // button's `disabled` state, which is the right place for a realtime
  // gate — it disables the button while data is in flux without
  // unmounting the form.
  const queueAcceptingRequests = helpQueue?.is_demo || (helpQueue?.available ?? false);

  // Track whether the form is mid-submit. Use both a ref (so the
  // useEffect below can read it without rerunning on every toggle) and
  // useState (so the render-time guard below actually picks up the flip
  // — refs don't trigger renders).
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
    // Don't act on indeterminate state: helpQueue is undefined until the
    // realtime data loads, which would briefly make the queue look closed
    // and fire a spurious redirect.
    if (helpQueue === undefined) return;
    if (!queueAcceptingRequests) {
      // Redirect back to queue page if the queue is closed at the
      // DB-row level (helpQueue.available === false and not demo).
      router.replace(`/course/${course_id}/office-hours/${queue_id}`);
    }
  }, [helpQueue, queueAcceptingRequests, router, course_id, queue_id]);

  // Show error message only when the queue's own row says it's closed.
  // Don't unmount the form on a realtime blip.
  if (helpQueue !== undefined && !queueAcceptingRequests && !isSubmitting) {
    return (
      <Container>
        <Box py={8}>
          <Card.Root variant="outline" borderColor="orange.200">
            <Card.Body>
              <Text color="orange.600" fontWeight="semibold" mb={2}>
                Queue Closed for New Requests
              </Text>
              <Text color="fg.muted" mb={4}>
                This queue is not currently accepting new requests. You can still view existing requests and queue
                status.
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
