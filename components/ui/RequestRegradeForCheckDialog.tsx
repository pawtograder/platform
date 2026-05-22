import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import Markdown from "@/components/ui/markdown";
import { useAssignmentController, useAssignmentData, useBareCheckRegradeRequest } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmission } from "@/hooks/useSubmission";
import { RubricCheck as RubricCheckType } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { toaster } from "@/components/ui/toaster";
import { Alert } from "@/components/ui/alert";
import { format, formatDistanceToNow } from "date-fns";
import RegradeRequestWrapper from "@/components/ui/regrade-request-wrapper";

const RUBRIC_DESCRIPTION_STYLE: CSSProperties = { fontSize: "0.8rem" };

export default function RequestRegradeForCheckDialog({
  submissionReviewId,
  rubricCheckId,
  check,
  isReleased = true,
  compact = false
}: {
  submissionReviewId: number;
  rubricCheckId: number;
  /** Required for the rubric sidebar; omitted in compact grade-view rows that already show check details. */
  check?: RubricCheckType;
  isReleased?: boolean;
  /** Render a low-emphasis trigger (small ghost link) instead of the full-width button. */
  compact?: boolean;
}) {
  const [isRegradeDialogOpen, setIsRegradeDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const { private_profile_id } = useClassProfiles();
  const assignment = useAssignmentData();
  const { regradeRequests } = useAssignmentController();
  const bareCheckRegradeRequest = useBareCheckRegradeRequest(submissionReviewId, rubricCheckId);
  const boxRef = useRef<HTMLDivElement>(null);

  const isGroupSubmission = submission.assignment_group_id !== null;

  // Auto-scroll when deep-linking to this regrade request
  useEffect(() => {
    if (bareCheckRegradeRequest?.id && boxRef.current) {
      const hash = window.location.hash;
      const targetId = `#regrade-request-${bareCheckRegradeRequest.id}`;

      if (hash === targetId) {
        setTimeout(() => {
          boxRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        }, 100);
      }
    }
  }, [bareCheckRegradeRequest?.id]);

  // Calculate regrade deadline status
  const regradeDeadlineInfo = useMemo(() => {
    const regradeDeadline = assignment.regrade_deadline;

    // If no deadline is set, regrades are always allowed
    if (!regradeDeadline) {
      return { hasDeadline: false, isPastDeadline: false, deadline: null };
    }

    const deadline = new Date(regradeDeadline);
    const now = new Date();
    const isPastDeadline = now > deadline;

    return { hasDeadline: true, isPastDeadline, deadline };
  }, [assignment.regrade_deadline]);

  const handleConfirmCreateRegradeRequest = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const supabase = createClient();
      const { data: requestId, error } = await supabase.rpc("create_regrade_request_for_check", {
        private_profile_id: private_profile_id,
        p_submission_review_id: submissionReviewId,
        p_rubric_check_id: rubricCheckId
      });

      if (error) {
        throw error;
      }

      if (requestId) {
        await regradeRequests.invalidate(requestId);
      }

      setIsRegradeDialogOpen(false);

      toaster.success({
        title: "Regrade Request Created",
        description: "Now explain your reasoning in the comment below."
      });
    } catch (error) {
      toaster.error({
        title: "Error Creating Regrade Request",
        description: getStudentFacingErrorMessage(error)
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, private_profile_id, submissionReviewId, rubricCheckId, regradeRequests]);

  if (bareCheckRegradeRequest) {
    return (
      <Box ref={boxRef} id={`regrade-request-${bareCheckRegradeRequest.id}`} pl={2} pb={2} w="100%">
        <RegradeRequestWrapper regradeRequestId={bareCheckRegradeRequest.id}>
          <Box border="1px solid" borderColor="border.emphasized" borderRadius="md" p={1} w="100%" fontSize="sm">
            {check && (
              <>
                <Text fontSize="sm" fontWeight="semibold" mb={1}>
                  {check.name}
                </Text>
                <Markdown style={RUBRIC_DESCRIPTION_STYLE}>{check.description}</Markdown>
              </>
            )}
            <Text fontSize="xs" color="fg.muted" mt={1}>
              {isGraderOrInstructor
                ? "The student requested a regrade for this check, which was not applied to the submission."
                : "This rubric check was not applied to your submission."}
            </Text>
          </Box>
        </RegradeRequestWrapper>
      </Box>
    );
  }

  // Staff view existing bare-check requests on the rubric check; only students can create them.
  if (isGraderOrInstructor || !isReleased) {
    return null;
  }

  // If deadline has passed, show a disabled button with explanation
  if (regradeDeadlineInfo.isPastDeadline && regradeDeadlineInfo.deadline) {
    if (compact) {
      return (
        <Text fontSize="xs" color="fg.subtle" title="Regrade deadline has passed">
          Regrade deadline passed
        </Text>
      );
    }
    return (
      <Box pl={2} pb={2} w="100%">
        <Button size="sm" colorPalette="gray" variant="outline" w="100%" disabled title="Regrade deadline has passed">
          Regrade deadline passed
        </Button>
        <Text fontSize="xs" color="fg.muted" mt={1}>
          The deadline was {format(regradeDeadlineInfo.deadline, "MMM d, yyyy 'at' h:mm a")}
        </Text>
      </Box>
    );
  }

  return (
    <Box pl={compact ? 0 : 2} pb={compact ? 0 : 2} w={compact ? "auto" : "100%"}>
      <DialogRoot open={isRegradeDialogOpen} onOpenChange={(e) => setIsRegradeDialogOpen(e.open)}>
        <DialogTrigger asChild>
          {compact ? (
            <Button size="xs" variant="ghost" colorPalette="gray" color="fg.muted" px={1} h="auto" py={0.5}>
              Request regrade
            </Button>
          ) : (
            <Button size="sm" colorPalette="orange" variant="outline" w="100%">
              Request regrade — check not applied
            </Button>
          )}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a Regrade</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <VStack gap={4} align="start">
              <Text>
                This rubric check was not applied to your submission. You can request that a grader review it.
              </Text>

              {regradeDeadlineInfo.hasDeadline && regradeDeadlineInfo.deadline && (
                <Alert status="warning" title="Regrade Request Deadline">
                  Regrade requests must be submitted by{" "}
                  <strong>{format(regradeDeadlineInfo.deadline, "MMM d, yyyy 'at' h:mm a")}</strong> (
                  {formatDistanceToNow(regradeDeadlineInfo.deadline, { addSuffix: true })}).
                </Alert>
              )}

              {isGroupSubmission && (
                <Box bg="bg.info" p={3} borderRadius="md" w="100%">
                  <Text fontWeight="semibold" mb={2}>
                    📝 Group Submission
                  </Text>
                  <VStack gap={1} align="start">
                    <Text fontSize="sm">
                      • This regrade request will apply to <strong>all group members</strong>
                    </Text>
                    <Text fontSize="sm">• All group members will be able to see this request and any responses</Text>
                    <Text fontSize="sm">• If the grade is changed, it will affect the entire group&apos;s score</Text>
                  </VStack>
                </Box>
              )}

              <Text>
                <strong>What happens next:</strong>
              </Text>
              <VStack gap={2} align="start" pl={4}>
                <Text>• You&apos;ll explain your reasoning in a comment below</Text>
                <Text>• Your request will be reviewed by the original grader</Text>
                <Text>• You&apos;ll receive a notification when the grader responds</Text>
                <Text>• If you disagree with the response, you can escalate to an instructor</Text>
                <Text>• The instructor&apos;s decision will be final</Text>
              </VStack>
              <Text color="fg.muted" fontSize="sm">
                <strong>Note:</strong> Regrade requests should only be submitted if you believe there was an error in
                grading. Please make sure you understand the rubric criteria before submitting.
              </Text>
            </VStack>
          </DialogBody>
          <DialogFooter>
            <DialogActionTrigger asChild>
              <Button variant="outline">Cancel</Button>
            </DialogActionTrigger>
            <Button
              colorPalette="orange"
              onClick={handleConfirmCreateRegradeRequest}
              loading={isSubmitting}
              disabled={isSubmitting}
            >
              Draft Regrade Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </Box>
  );
}
