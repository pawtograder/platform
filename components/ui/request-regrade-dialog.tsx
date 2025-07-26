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
import { useRubricCheck, useRubricCriteria } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useSubmission, useSubmissionController } from "@/hooks/useSubmission";
import { SubmissionArtifactComment, SubmissionComments, SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { useCreate } from "@refinedev/core";
import { useCallback, useState } from "react";
import { toaster } from "./toaster";
export default function RequestRegradeDialog({
  comment
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
}) {
  const [isRegradeDialogOpen, setIsRegradeDialogOpen] = useState(false);
  const submission = useSubmission();
  const submissionController = useSubmissionController();
  const { private_profile_id } = useClassProfiles();

  const isGroupSubmission = submission.assignment_group_id !== null;
  const rubricCheck = useRubricCheck(comment?.rubric_check_id);
  const rubricCriteria = useRubricCriteria(rubricCheck?.rubric_criteria_id);
  const { mutateAsync: createRegradeRequest } = useCreate({
    resource: "rpc/create_regrade_request"
  });
  const handleConfirmCreateRegradeRequest = useCallback(async () => {
    try {
      if ("submission_file_id" in comment) {
        await createRegradeRequest({
          values: {
            private_profile_id: private_profile_id,
            submission_file_comment_id: comment.id
          }
        });
        await submissionController.submission_file_comments.invalidate(comment.id);
      } else if ("submission_id" in comment && "artifact_id" in comment) {
        await createRegradeRequest({
          values: {
            private_profile_id: private_profile_id,
            submission_artifact_comment_id: comment.id
          }
        });
        await submissionController.submission_artifact_comments.invalidate(comment.id);
      } else if ("submission_id" in comment && !("artifact_id" in comment) && !("submission_file_id" in comment)) {
        await createRegradeRequest({
          values: {
            private_profile_id: private_profile_id,
            submission_comment_id: comment.id
          }
        });
        await submissionController.submission_comments.invalidate(comment.id);
      } else {
        throw new Error("Unknown comment type for regrade request");
      }
      // Close dialog and show inline form
      setIsRegradeDialogOpen(false);

      toaster.success({
        title: "Regrade Request Created",
        description: "Now explain your reasoning in the comment below."
      });
    } catch (error) {
      toaster.error({
        title: "Error Creating Regrade Request",
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [comment, private_profile_id, createRegradeRequest, submissionController]);

  const pointsText = rubricCriteria?.is_additive ? `+${comment?.points}` : `-${comment?.points}`;
  return (
    <Box pl={2} pb={2} w="100%">
      <DialogRoot open={isRegradeDialogOpen} onOpenChange={(e) => setIsRegradeDialogOpen(e.open)}>
        <DialogTrigger asChild>
          <Button size="sm" colorPalette="orange" variant="outline" w="100%">
            Request regrade for this check
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a Regrade</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <VStack gap={4} align="start">
              <Text>
                You are about to request a regrade for this comment that affected your score by{" "}
                <strong>{pointsText} points</strong>.
              </Text>

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
            <Button colorPalette="orange" onClick={handleConfirmCreateRegradeRequest}>
              Draft Regrade Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </Box>
  );
}
