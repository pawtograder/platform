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
import { useAssignmentData } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useSubmission } from "@/hooks/useSubmission";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { useCreate } from "@refinedev/core";
import { useCallback, useMemo, useState } from "react";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { toaster } from "@/components/ui/toaster";
import { Alert } from "@/components/ui/alert";
import { format, formatDistanceToNow } from "date-fns";

export default function RequestRegradeForCheckDialog({
  submissionReviewId,
  rubricCheckId
}: {
  submissionReviewId: number;
  rubricCheckId: number;
}) {
  const [isRegradeDialogOpen, setIsRegradeDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submission = useSubmission();
  const { private_profile_id } = useClassProfiles();
  const assignment = useAssignmentData();

  const isGroupSubmission = submission.assignment_group_id !== null;
  const { mutateAsync: createRegradeRequestForCheck } = useCreate({
    resource: "rpc/create_regrade_request_for_check"
  });

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
      await createRegradeRequestForCheck({
        values: {
          private_profile_id: private_profile_id,
          p_submission_review_id: submissionReviewId,
          p_rubric_check_id: rubricCheckId
        }
      });

      // Close dialog and show inline form
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
  }, [createRegradeRequestForCheck, private_profile_id, submissionReviewId, rubricCheckId, isSubmitting]);

  // If deadline has passed, show a disabled button with explanation
  if (regradeDeadlineInfo.isPastDeadline && regradeDeadlineInfo.deadline) {
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
    <Box pl={2} pb={2} w="100%">
      <DialogRoot open={isRegradeDialogOpen} onOpenChange={(e) => setIsRegradeDialogOpen(e.open)}>
        <DialogTrigger asChild>
          <Button size="sm" colorPalette="orange" variant="outline" w="100%">
            Request regrade — check not applied
          </Button>
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
