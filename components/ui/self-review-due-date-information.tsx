"use client";
import FinalizeSubmissionEarly from "@/app/course/[course_id]/assignments/[assignment_id]/finalizeSubmissionEarly";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import {
  useAssignmentController,
  useMyReviewAssignments,
  useRubric,
  useSelfReviewSettings
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useAssignmentDueDate } from "@/hooks/useCourseController";
import { useWritableSubmissionReviews } from "@/hooks/useSubmission";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { addHours } from "date-fns";
import { useState } from "react";

export default function SelfReviewDueDateInformation() {
  const settings = useSelfReviewSettings();
  const selfReviewRubric = useRubric("self-review");
  const myReviewAssignments = useMyReviewAssignments();
  const myReviews = useWritableSubmissionReviews();
  const { private_profile_id } = useClassProfiles();
  const { assignment } = useAssignmentController();
  const dueDate = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: private_profile_id,
    assignmentGroupId: undefined
  });
  const selfReviewDueDate = addHours(dueDate.dueDate || new Date(), settings.deadline_offset || 0);
  const selfReviewAssignment = myReviewAssignments.find((a) => a.rubric_id === selfReviewRubric?.id);
  const [isLoading, setIsLoading] = useState(false);
  const isGrader = useIsGraderOrInstructor();

  if (!settings.enabled || !myReviews || !assignment || isGrader) {
    return <></>;
  }
  if (!selfReviewAssignment) {
    if (settings.allow_early) {
      return (
        <HStack>
          <VStack justifyContent="start" alignItems="start" w="100%">
            <Text>
              A self review will be due at <TimeZoneAwareDate date={selfReviewDueDate} format="full" /> (
              {settings.deadline_offset} hours after the coding assignment due date).
            </Text>
            <Text fontSize="sm" color="fg.muted">
              If you are finished with the programming assignment, you can submit your self review early. However, once
              you begin the self review, you will not be able to change your submission.
            </Text>
          </VStack>
          <FinalizeSubmissionEarly
            assignment={assignment}
            private_profile_id={private_profile_id}
            enabled={settings.allow_early}
            setLoading={setIsLoading}
            loading={isLoading}
          />
        </HStack>
      );
    }
    return (
      <Text>
        A self-review will be due at <TimeZoneAwareDate date={selfReviewDueDate} format="full" /> (
        {settings.deadline_offset} hours after the coding assignment due date).
      </Text>
    );
  }
  return <></>;
}
